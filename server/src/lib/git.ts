// Thin, safe wrapper around the `git` CLI.
//
// Ported from `src-tauri/src/backend/cli.rs`. The desktop Rust backend ran the
// native git CLI (the `git2` libgit2 path was Android-only and is dropped in the
// TypeScript rewrite, which targets the desktop/native-CLI environment).
//
// All helpers set GIT_TERMINAL_PROMPT=0 so git never blocks on an interactive
// credential prompt.

import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { AppError } from "./errors.ts";
import { recordGitCommand } from "./gitLog.ts";
import { gitProcessEnv } from "./gitCredentials.ts";

export interface GitOutput {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const MAX_BUFFER = 1024 * 1024 * 256; // 256MB: large blame/log output on big repos.

function resolveCode(error: Error | null): number {
  if (!error) return 0;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : 1;
}

// Per-request diff display options (ignore whitespace, diff algorithm). The
// HTTP layer runs viewer routes inside `withDiffOptions`; every `git diff`
// spawned during that request gets the flags inserted after "diff".
export type DiffOptions = { whitespace?: "all" | "change" | "eol" | "none"; algorithm?: "myers" | "minimal" | "patience" | "histogram" };
const diffOptionsStore = new AsyncLocalStorage<string[]>();

export function withDiffOptions<T>(options: DiffOptions | null | undefined, run: () => Promise<T>): Promise<T> {
  const flags: string[] = [];
  if (options?.whitespace === "all") flags.push("--ignore-all-space");
  else if (options?.whitespace === "change") flags.push("--ignore-space-change");
  else if (options?.whitespace === "eol") flags.push("--ignore-space-at-eol");
  if (options?.algorithm && ["myers", "minimal", "patience", "histogram"].includes(options.algorithm)) flags.push(`--diff-algorithm=${options.algorithm}`);
  return flags.length ? diffOptionsStore.run(flags, run) : run();
}

function spawnArgs(path: string | null, args: string[]): string[] {
  const flags = diffOptionsStore.getStore();
  const effective = flags && (args[0] === "diff" || args[0] === "show") ? [args[0], ...flags, ...args.slice(1)] : args;
  return path ? ["-C", path, ...effective] : [...effective];
}

// ---------------------------------------------------------------------------
// Per-repository git lanes.
//
// Every repository (keyed by the -C path) gets its own lane: its own pool of
// git processes, so a slow repository (a huge submodule tree on a fuse mount)
// never delays git calls for another open tab. Within a lane:
//  - identical read commands that are already running are shared instead of
//    spawning a second process (tab switches fire the same reads repeatedly);
//    any write bumps the lane's generation so a read issued after a write never
//    reuses output from before it;
//  - read commands started for an HTTP request that the client abandoned (it
//    switched to another tab) are killed, freeing CPU and the connection.
// ---------------------------------------------------------------------------

const READ_COMMANDS = new Set([
  "status", "log", "rev-parse", "rev-list", "for-each-ref", "show", "show-ref", "diff", "ls-files", "ls-tree",
  "cat-file", "merge-base", "describe", "blame", "shortlog", "name-rev", "count-objects", "symbolic-ref", "range-diff",
  "grep", "cherry", "check-ignore", "check-attr", "worktree", "stash", "branch", "tag", "remote", "config", "notes",
]);
// Sub-commands of the list above that only read for a given first argument.
function isReadCommand(args: string[]): boolean {
  const [command, sub] = args;
  if (!READ_COMMANDS.has(command)) return false;
  switch (command) {
    case "worktree": return sub === "list";
    case "stash": return sub === "list" || sub === "show";
    case "notes": return sub === "show" || sub === "list";
    case "remote": return sub === undefined || sub === "-v" || sub === "get-url" || sub === "show";
    case "config": return args.some((arg) => arg === "--get" || arg === "--get-all" || arg === "--get-regexp" || arg === "--list" || arg === "-l");
    case "branch": return args.slice(1).every((arg) => arg.startsWith("-") && !/^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(arg)) || args.includes("--list");
    case "tag": return args.length === 1 || args.includes("-l") || args.includes("--list") || args.includes("--contains") || args.includes("--points-at");
    case "symbolic-ref": return args.length <= 3 && !args.slice(1).some((arg) => arg === "-d" || arg === "--delete") && args.filter((arg) => !arg.startsWith("-")).length <= 2;
    default: return true;
  }
}

const LANE_CONCURRENCY = Math.max(2, Number.parseInt(process.env.CHRONO_GIT_PER_REPO ?? "8", 10) || 8);

type RawOutput = { stdout: Buffer | string; stderr: string; code: number };

interface SharedRun {
  promise: Promise<RawOutput>;
  holders: number;        // callers that can still abort; Infinity once a non-abortable caller joins
  controller: AbortController;
}

class GitLane {
  active = 0;
  generation = 0;
  lastUsed = Date.now();
  private waiting: Array<{ start: () => void; signal?: AbortSignal; cancel: () => void }> = [];
  readonly inflight = new Map<string, SharedRun>();

  acquire(signal?: AbortSignal): Promise<boolean> {
    this.lastUsed = Date.now();
    if (this.active < LANE_CONCURRENCY) { this.active++; return Promise.resolve(true); }
    return new Promise((resolve) => {
      const entry = {
        signal,
        start: () => { signal?.removeEventListener("abort", entry.cancel); this.active++; resolve(true); },
        cancel: () => { this.waiting = this.waiting.filter((item) => item !== entry); resolve(false); },
      };
      if (signal?.aborted) { resolve(false); return; }
      signal?.addEventListener("abort", entry.cancel, { once: true });
      this.waiting.push(entry);
    });
  }

  release(): void {
    this.active--;
    this.lastUsed = Date.now();
    const next = this.waiting.shift();
    if (next) next.start();
  }
}

const lanes = new Map<string, GitLane>();
function laneFor(path: string | null): GitLane {
  const key = path ?? "";
  let lane = lanes.get(key);
  if (!lane) {
    lane = new GitLane();
    lanes.set(key, lane);
    if (lanes.size > 64) {
      // Forget idle lanes of repositories that are no longer used.
      for (const [other, candidate] of lanes) {
        if (candidate !== lane && candidate.active === 0 && candidate.inflight.size === 0 && Date.now() - candidate.lastUsed > 60_000) lanes.delete(other);
      }
    }
  }
  return lane;
}

/** Diagnostic snapshot: active git processes per repository. */
export function gitLaneStats(): Array<{ path: string; active: number; shared: number }> {
  return [...lanes].filter(([, lane]) => lane.active > 0 || lane.inflight.size > 0)
    .map(([path, lane]) => ({ path, active: lane.active, shared: lane.inflight.size }));
}

// Abort signal of the HTTP request being served (read routes only).
const requestSignalStore = new AsyncLocalStorage<AbortSignal>();
export function withAbortSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return requestSignalStore.run(signal, run);
}
/** The abort signal of the request being served, if any. */
export function currentRequestSignal(): AbortSignal | undefined {
  return requestSignalStore.getStore();
}
/** Run git work that must outlive the current request (shared background state). */
export function outsideRequest<T>(run: () => T): T {
  return requestSignalStore.exit(run);
}

const ABORTED: RawOutput = { stdout: "", stderr: "aborted: the client no longer needs this result", code: 130 };

function execGit(path: string | null, args: string[], extraEnv: Record<string, string>, binary: boolean): Promise<RawOutput> {
  const lane = laneFor(path);
  const read = isReadCommand(args);
  const spawned = spawnArgs(path, args);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...gitProcessEnv(path), ...extraEnv };
  const signal = read ? requestSignalStore.getStore() : undefined;
  if (!read) lane.generation++;

  const key = read ? `${lane.generation}\u0000${binary ? "b" : "t"}\u0000${spawned.join("\u0000")}\u0000${JSON.stringify(extraEnv)}` : null;
  let shared = key ? lane.inflight.get(key) : undefined;
  if (!shared) {
    const controller = new AbortController();
    const promise = (async (): Promise<RawOutput> => {
      const admitted = await lane.acquire(controller.signal);
      if (!admitted) return ABORTED;
      try {
        return await new Promise<RawOutput>((resolve) => {
          const startedAt = new Date().toISOString();
          const start = performance.now();
          execFile("git", spawned, {
            maxBuffer: MAX_BUFFER,
            env,
            signal: controller.signal,
            ...(binary ? { encoding: "buffer" as const } : {}),
          }, (error, stdout, stderr) => {
            const aborted = controller.signal.aborted;
            const code = aborted ? 130 : resolveCode(error);
            const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : (stderr ?? "");
            if (!binary) {
              recordGitCommand({
                args,
                cwd: path,
                exitCode: code,
                durationMs: performance.now() - start,
                startedAt,
                stdoutTail: (stdout as string) ?? "",
                stderrTail: aborted ? ABORTED.stderr : stderrText,
              });
            }
            resolve(aborted ? ABORTED : { stdout: stdout ?? (binary ? Buffer.alloc(0) : ""), stderr: stderrText, code });
          });
        });
      } finally {
        lane.release();
      }
    })();
    shared = { promise, holders: 0, controller };
    if (key) {
      lane.inflight.set(key, shared);
      const entry = shared;
      void promise.finally(() => { if (lane.inflight.get(key) === entry) lane.inflight.delete(key); });
    }
  }

  // Abort the shared process only when every caller that joined it gave up.
  const run = shared;
  if (!signal) {
    run.holders = Number.POSITIVE_INFINITY;
  } else if (signal.aborted) {
    if (run.holders === 0) run.controller.abort();
    return Promise.resolve(ABORTED);
  } else {
    run.holders++;
    const onAbort = () => { run.holders--; if (run.holders <= 0) run.controller.abort(); };
    signal.addEventListener("abort", onAbort, { once: true });
    void run.promise.finally(() => signal.removeEventListener("abort", onAbort));
  }
  return run.promise;
}

// Run git and always resolve (never reject) with utf8 stdout/stderr and the exit code.
export async function runGit(
  path: string | null,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<GitOutput> {
  const output = await execGit(path, args, extraEnv, false);
  return { stdout: output.stdout as string, stderr: output.stderr, code: output.code };
}

// Run git returning raw stdout bytes (used for binary/blob detection).
export async function runGitRaw(
  path: string | null,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  const output = await execGit(path, args, extraEnv, true);
  return { stdout: Buffer.isBuffer(output.stdout) ? output.stdout : Buffer.from(output.stdout), stderr: output.stderr, code: output.code };
}

export function toCommandResult(output: GitOutput): CommandResult {
  return { stdout: output.stdout, stderr: output.stderr, exitCode: output.code };
}

// Run git, throwing a `command` AppError on a non-zero exit. Returns stdout.
export async function checkedStdout(
  path: string | null,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const output = await runGit(path, args, extraEnv);
  if (output.code !== 0) throw gitFailure(path, args, output.stderr, output.code);
  return output.stdout;
}

// Like checkedStdout but returns the full CommandResult (with exit code 0).
export async function checked(
  path: string | null,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<CommandResult> {
  const output = await runGit(path, args, extraEnv);
  const result = toCommandResult(output);
  if (result.exitCode !== 0) throw gitFailure(path, args, result.stderr, result.exitCode);
  return result;
}

// Build the failure message, naming the workdir so the UI says WHICH folder
// failed. git's stderr is empty on several platforms (notably Windows when
// the workdir is missing), which used to surface as "git <args>: " — a
// fallback keeps the message useful either way.
function gitFailure(workdir: string | null, args: string[], stderr: string, code: number): AppError {
  const detail = stderr.replace(/\s+/g, " ").trim();
  const where = workdir ? ` in ${workdir}` : "";
  return new AppError(
    "command",
    detail ? `git ${args.join(" ")}${where}: ${detail}` : `git ${args.join(" ")}${where} failed (exit code ${code})`,
  );
}

// Return CommandResult, or null on failure (mirrors Rust `.ok()`).
export async function checkedOpt(
  path: string | null,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<CommandResult | null> {
  const output = await runGit(path, args, extraEnv);
  return output.code === 0 ? toCommandResult(output) : null;
}

// Resolve the worktree root for a user-supplied path. When the folder is
// missing or not a git checkout, git's stderr can be empty (Windows), so the
// error names the path explicitly instead of leaving a dangling colon.
export async function repositoryRoot(path: string): Promise<string> {
  const output = await runGit(path, ["rev-parse", "--show-toplevel"]);
  if (output.code !== 0) {
    const detail = output.stderr.replace(/\s+/g, " ").trim();
    throw new AppError(
      "invalid",
      detail
        ? `git rev-parse --show-toplevel in ${path}: ${detail}`
        : `"${path}" is not inside a git work tree — the folder may be missing or renamed`,
    );
  }
  return output.stdout.trim();
}

// True when the repository has at least one commit. Every HEAD-relative read
// command (log, status, blame…) is guarded with this first: an unborn-HEAD
// repo then returns empty results instead of a git error (GitDesktop's rule).
export async function hasHead(path: string): Promise<boolean> {
  const result = await checkedOpt(path, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return result !== null;
}

// Wrap a user-supplied path in a `:(literal)` pathspec so glob characters in
// the path (e.g. `b[0].txt`) can't match sibling files (GitDesktop fix).
// `git blame` takes a literal path, not a pathspec — never wrap for blame.
export function literalPathspec(file: string): string {
  return `:(literal)${file}`;
}

// The shared commit log format string (fields separated by \u001f, records by \u001e).
export const COMMIT_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";

export interface CommitRecord {
  id: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
}

export function parseCommits(output: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (const chunk of output.split("\u001e")) {
    const fields = chunk.trim().split("\u001f");
    if (fields.length !== 6) continue;
    records.push({
      id: fields[0],
      parents: fields[1].split(/\s+/).filter((value) => value.length > 0),
      authorName: fields[2],
      authorEmail: fields[3],
      authoredAt: fields[4],
      subject: fields[5],
    });
  }
  return records;
}

// Parse `--numstat` output into per-file change records.
export interface FileChangeStat {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export function parseNumstat(output: string): FileChangeStat[] {
  const result: FileChangeStat[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.length) continue;
    const [add, del, ...rest] = line.split("\t");
    if (rest.length === 0 || add === undefined || del === undefined) continue;
    const path = rest.join("\t");
    if (!path.length) continue;
    const binary = add === "-" || del === "-";
    result.push({
      path,
      additions: binary ? null : Number.parseInt(add, 10) || 0,
      deletions: binary ? null : Number.parseInt(del, 10) || 0,
      binary,
    });
  }
  return result;
}

/** `--all` for history views, minus internal refs that are not branch history
 *  (git notes and Chrono's own archive refs would otherwise show up as
 *  orphan "Notes added by 'git notes add'" commits in the graph). The
 *  `--exclude` options must precede `--all`. */
export const HISTORY_ALL_REFS = ["--exclude=refs/notes/*", "--exclude=refs/chrono/*", "--all"] as const;

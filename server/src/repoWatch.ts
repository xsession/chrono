// Live repository changes: tells the UI within a fraction of a second that the
// working tree or the repository state changed, so the Changes list and the
// graph's WIP row follow edits made in an editor, a terminal or another tool.
//
// One watcher per repository root, shared by every client:
//  • the working tree: one non-recursive fs.watch per directory git cares
//    about (directories of tracked files, submodules included, plus untracked
//    directories that are not ignored). Ignored trees such as node_modules or
//    build output are never watched, which keeps big repositories cheap.
//    Directories created later are picked up from their parent's events.
//  • the git directory: index (a "worktree" change: only the status moved),
//    HEAD, refs, packed-refs and merge/rebase/cherry-pick state (a "git"
//    change: the graph needs reloading too). Submodule git directories are
//    watched for HEAD and index.
// If the system runs out of inotify watches, or the tree is huge, the watcher
// falls back to comparing `git status` once a second.
//
// Clients long-poll: waitForChange(path, since) resolves as soon as the
// version passes `since` (or after a timeout with the same version).

import { watch, type FSWatcher, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { outsideRequest, repositoryRoot, runGit } from "./lib/git.ts";

const SETTLE_MS = 80;            // coalesce bursts of events (an editor save, a checkout)
const POLL_MS = 1000;            // fallback when events are unavailable
const IDLE_MS = 60_000;          // drop a watcher nobody has asked about for this long
const MAX_DIRECTORIES = 40_000;  // beyond this, polling is cheaper than watching
const WAIT_TIMEOUT_MS = 25_000;

export interface RepositoryChange {
  /** Bumped for every change. */
  version: number;
  /** Bumped when HEAD, refs or the operation state changed (reload the graph). */
  gitVersion: number;
  mode: "events" | "poll" | "starting";
}

const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn"]);
// Inside the git directory: what changes the status, and what changes the graph.
const GIT_INDEX = /^index$/;
const GIT_STATE = /^(HEAD|packed-refs|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|BISECT_LOG|refs(\/.*)?|rebase-merge(\/.*)?|rebase-apply(\/.*)?|sequencer(\/.*)?)$/;

class RepositoryWatch {
  version = 0;
  gitVersion = 0;
  mode: RepositoryChange["mode"] = "starting";
  lastUsed = Date.now();
  private waiters = new Set<() => void>();
  private watchers = new Map<string, FSWatcher>();
  private pendingGit = false;
  private settle: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;
  private pollSignature = "";
  private polling = false;
  private closed = false;

  readonly root: string;
  constructor(root: string) { this.root = root; }

  async start(): Promise<void> {
    try {
      const gitDirs = await this.gitDirectories();
      const directories = await this.workingDirectories();
      if (directories.length > MAX_DIRECTORIES) throw Object.assign(new Error("tree too large to watch"), { code: "TOO_MANY" });
      for (const dir of gitDirs.state) this.watchGitDir(dir.path, dir.base);
      for (const dir of directories) this.watchWorkDir(dir);
      if (this.closed) return;
      this.mode = "events";
    } catch {
      this.startPolling();
    }
  }

  // --- git directories ------------------------------------------------------
  private async gitDirectories(): Promise<{ state: Array<{ path: string; base: string }> }> {
    const state: Array<{ path: string; base: string }> = [];
    const out = await runGit(this.root, ["rev-parse", "--absolute-git-dir", "--git-common-dir"]);
    const [gitDir, commonRaw] = out.stdout.split("\n").map((line) => line.trim());
    if (!gitDir) throw new Error("not a git repository");
    const commonDir = path.resolve(this.root, commonRaw || gitDir);
    state.push({ path: gitDir, base: gitDir });
    if (commonDir !== gitDir) state.push({ path: commonDir, base: commonDir });
    for (const refsDir of await walkDirectories(path.join(commonDir, "refs"), 5000)) state.push({ path: refsDir, base: commonDir });
    // Submodules: their HEAD and index live under .git/modules/…
    const modules = path.join(commonDir, "modules");
    for (const dir of await walkDirectories(modules, 2000)) {
      try { await fs.access(path.join(dir, "HEAD")); state.push({ path: dir, base: dir }); } catch { /* not a git dir */ }
    }
    return { state };
  }

  /** `base` is the git directory `dir` belongs to (names are matched relative to it). */
  private watchGitDir(dir: string, base: string): void {
    const prefix = dir === base ? "" : `${path.relative(base, dir).split(path.sep).join("/")}/`;
    this.addWatcher(dir, (name) => {
      const relative = prefix + name;
      if (relative.endsWith(".lock")) return;
      if (GIT_INDEX.test(relative)) this.changed(false);
      else if (GIT_STATE.test(relative)) {
        this.changed(true);
        // New ref folders (refs/heads/feature/…) need their own watcher.
        if (relative.startsWith("refs/")) void this.maybeWatchNewDir(path.join(dir, name), (sub) => this.watchGitDir(sub, base));
      }
    });
  }

  // --- working tree ---------------------------------------------------------
  private async workingDirectories(): Promise<string[]> {
    const set = new Set<string>([this.root]);
    const tracked = await runGit(this.root, ["ls-files", "-z", "--cached", "--recurse-submodules"]);
    for (const file of tracked.stdout.split("\0")) {
      let dir = path.posix.dirname(file);
      while (file && dir !== "." && !set.has(path.join(this.root, dir))) {
        set.add(path.join(this.root, dir));
        dir = path.posix.dirname(dir);
      }
      if (set.size > MAX_DIRECTORIES) return [...set];
    }
    const untracked = await runGit(this.root, ["ls-files", "-z", "--others", "--exclude-standard", "--directory"]);
    for (const entry of untracked.stdout.split("\0")) {
      if (!entry.endsWith("/")) continue;
      for (const dir of await walkDirectories(path.join(this.root, entry), MAX_DIRECTORIES - set.size)) set.add(dir);
    }
    return [...set];
  }

  private watchWorkDir(dir: string): void {
    this.addWatcher(dir, (name) => {
      if (SKIP_DIRS.has(name)) return;
      this.changed(false);
      void this.maybeWatchNewDir(path.join(dir, name), (sub) => this.watchWorkDir(sub));
    });
  }

  private async maybeWatchNewDir(candidate: string, add: (dir: string) => void): Promise<void> {
    if (this.closed || this.mode === "poll" || this.watchers.has(candidate)) return;
    try {
      if (!(await fs.stat(candidate)).isDirectory()) return;
    } catch {
      this.watchers.get(candidate)?.close();
      this.watchers.delete(candidate);
      return;
    }
    for (const dir of await walkDirectories(candidate, 2000)) if (!this.watchers.has(dir)) add(dir);
  }

  private addWatcher(dir: string, onName: (name: string) => void): void {
    if (this.closed || this.watchers.has(dir)) return;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (name) onName(String(name)); else this.changed(true);
      });
      watcher.on("error", (error: NodeJS.ErrnoException) => {
        watcher.close();
        this.watchers.delete(dir);
        if (error.code === "ENOSPC" || error.code === "EMFILE") this.startPolling();
      });
      this.watchers.set(dir, watcher);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOSPC" || code === "EMFILE") throw error; // out of watches: poll instead
      // ENOENT/EACCES: the directory went away or is unreadable; nothing to watch
    }
  }

  // --- polling fallback -------------------------------------------------------
  private startPolling(): void {
    if (this.closed || this.mode === "poll") return;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.mode = "poll";
    const tick = async () => {
      if (this.closed || this.polling) return;
      this.polling = true;
      try {
        const status = await outsideRequest(() => runGit(this.root, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal"]));
        const head = status.stdout.match(/# branch\.oid (\S+)/)?.[1] ?? "";
        const next = `${head}:${createHash("sha1").update(status.stdout).digest("hex")}`;
        if (this.pollSignature && next !== this.pollSignature) this.changed(!this.pollSignature.startsWith(`${head}:`));
        this.pollSignature = next;
      } finally {
        this.polling = false;
      }
    };
    this.poller = setInterval(() => { void tick(); }, POLL_MS);
    this.poller.unref?.();
    void tick();
  }

  // --- notifications ----------------------------------------------------------
  private changed(git: boolean): void {
    if (this.closed) return;
    this.pendingGit ||= git;
    if (this.settle) return;
    this.settle = setTimeout(() => {
      this.settle = null;
      this.version += 1;
      if (this.pendingGit) this.gitVersion += 1;
      this.pendingGit = false;
      const waiters = [...this.waiters];
      this.waiters.clear();
      for (const wake of waiters) wake();
    }, SETTLE_MS);
  }

  snapshot(): RepositoryChange {
    return { version: this.version, gitVersion: this.gitVersion, mode: this.mode };
  }

  wait(since: number, signal: AbortSignal | undefined, timeoutMs: number): Promise<RepositoryChange> {
    this.lastUsed = Date.now();
    if (this.version !== since || signal?.aborted) return Promise.resolve(this.snapshot());
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.waiters.delete(done);
        this.lastUsed = Date.now();
        resolve(this.snapshot());
      };
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done, { once: true });
      this.waiters.add(done);
    });
  }

  get idle(): boolean { return this.waiters.size === 0 && Date.now() - this.lastUsed > IDLE_MS; }

  close(): void {
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    if (this.poller) clearInterval(this.poller);
    if (this.settle) clearTimeout(this.settle);
    for (const wake of [...this.waiters]) wake();
  }
}

/** Every directory under `root` (itself included), skipping SKIP_DIRS, up to `limit`. */
async function walkDirectories(root: string, limit: number): Promise<string[]> {
  const found: string[] = [];
  const queue = [root];
  while (queue.length && found.length < limit) {
    const dir = queue.shift()!;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    found.push(dir);
    for (const entry of entries) if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) queue.push(path.join(dir, entry.name));
  }
  return found;
}

const watches = new Map<string, RepositoryWatch>();
const roots = new Map<string, Promise<string>>();

setInterval(() => {
  for (const [root, entry] of watches) if (entry.idle) { entry.close(); watches.delete(root); }
}, 15_000).unref?.();

function watchFor(root: string): RepositoryWatch {
  let entry = watches.get(root);
  if (!entry) {
    entry = new RepositoryWatch(root);
    watches.set(root, entry);
    const started = entry;
    void outsideRequest(() => started.start());
  }
  return entry;
}

/**
 * Wait until `inputPath`'s repository changes after version `since`. A negative
 * `since` returns the current version at once (and starts watching).
 */
export async function waitForChange(inputPath: string, since: number, signal?: AbortSignal, timeoutMs = WAIT_TIMEOUT_MS): Promise<RepositoryChange> {
  let root = roots.get(inputPath);
  if (!root) {
    root = outsideRequest(() => repositoryRoot(inputPath));
    roots.set(inputPath, root);
    root.catch(() => roots.delete(inputPath));
  }
  const entry = watchFor(await root);
  if (since < 0) { entry.lastUsed = Date.now(); return entry.snapshot(); }
  return entry.wait(since, signal, Math.min(Math.max(timeoutMs, 1000), 60_000));
}

/** Stop every watcher (tests, shutdown). */
export function closeAllWatches(): void {
  for (const entry of watches.values()) entry.close();
  watches.clear();
  roots.clear();
}

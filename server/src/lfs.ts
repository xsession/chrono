// Git LFS: status, tracked patterns, LFS files, locks and the actions on them.
//
// Reading needs no git-lfs binary: patterns come from .gitattributes, files
// from the index (`:(attr:filter=lfs)` pathspec) and their pointers from
// `git cat-file --batch`, and an object counts as downloaded when it is in
// .git/lfs/objects. So a repository that uses LFS on a machine without
// git-lfs still shows what is missing. Changing anything runs `git lfs`.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppError, invalidError } from "./lib/errors.ts";
import { checked, checkedStdout, repositoryRoot, runGit, type CommandResult } from "./lib/git.ts";
import { gitProcessEnv } from "./lib/gitCredentials.ts";
import { finishStream, runGitStreaming } from "./lib/streams.ts";

export interface LfsPattern {
  pattern: string;
  /** .gitattributes file that declares it, relative to the repository. */
  source: string;
  lockable: boolean;
}

export interface LfsFile {
  path: string;
  /** sha256 of the content; null when the committed blob is not a pointer. */
  oid: string | null;
  size: number;
  /** The content is in the local LFS store. */
  downloaded: boolean;
  /** The working-tree file still holds the pointer text, not the content. */
  pointerInWorktree: boolean;
}

export interface LfsLock {
  id: string;
  path: string;
  owner: string;
  lockedAt: string;
}

export interface LfsStatus {
  root: string;
  installed: boolean;
  version: string | null;
  /** .gitattributes route some paths through the LFS filter. */
  used: boolean;
  /** pre-push hook and filter configured, so pushes upload LFS objects. */
  hooks: boolean;
  patterns: LfsPattern[];
  files: LfsFile[];
  /** Files matched by an LFS pattern but committed as ordinary git blobs. */
  unconverted: number;
  missing: number;
  storeBytes: number;
}

const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n?/;

export function parsePointer(text: string): { oid: string; size: number } | null {
  const match = POINTER.exec(text.replace(/\r\n/g, "\n"));
  return match ? { oid: match[1], size: Number(match[2]) } : null;
}

/** LFS patterns of one .gitattributes text. */
export function parseLfsAttributes(text: string, source: string): LfsPattern[] {
  const result: LfsPattern[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[attr]")) continue;
    const [pattern, ...attributes] = line.split(/\s+/);
    if (!attributes.includes("filter=lfs")) continue;
    const dir = path.posix.dirname(source);
    result.push({ pattern: dir === "." ? pattern : `${dir}/${pattern}`, source, lockable: attributes.includes("lockable") });
  }
  return result;
}

/** git with stdin, for `cat-file --batch`. */
function gitWithInput(cwd: string, args: string[], input: string): Promise<{ stdout: Buffer; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...gitProcessEnv(cwd) } });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.on("error", () => resolve({ stdout: Buffer.alloc(0), code: 1 }));
    child.on("close", (code) => resolve({ stdout: Buffer.concat(chunks), code: code ?? 1 }));
    child.stdin.end(input);
  });
}

/** Contents of small blobs by sha (pointers are about 130 bytes). */
async function readBlobs(root: string, shas: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!shas.length) return result;
  const out = await gitWithInput(root, ["cat-file", "--batch"], `${shas.join("\n")}\n`);
  let offset = 0;
  const buffer = out.stdout;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(10, offset);
    if (newline < 0) break;
    const header = buffer.subarray(offset, newline).toString("utf8").split(" ");
    offset = newline + 1;
    if (header[1] === "missing") continue;
    const size = Number(header[2]);
    // Only pointer-sized blobs matter; skip the bytes of anything larger.
    if (size < 1024) result.set(header[0], buffer.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  return result;
}

async function lfsStoreDir(root: string): Promise<string> {
  const common = (await checkedStdout(root, ["rev-parse", "--git-common-dir"])).trim();
  return path.join(path.resolve(root, common), "lfs", "objects");
}

/** Where the content of an LFS object lives in the local store. */
export function objectPath(store: string, oid: string): string {
  return path.join(store, oid.slice(0, 2), oid.slice(2, 4), oid);
}

function storeSize(store: string): number {
  let total = 0;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile()) { try { total += fs.statSync(full).size; } catch { /* gone */ } }
    }
  };
  walk(store, 0);
  return total;
}

export async function lfsVersion(): Promise<string | null> {
  const output = await runGit(null, ["lfs", "version"]);
  return output.code === 0 ? output.stdout.trim() : null;
}

/** Quick check for the toolbar: does the repository use LFS, and is git-lfs there? */
export async function lfsCheck(inputPath: string): Promise<{ used: boolean; installed: boolean; setUp: boolean }> {
  const root = await repositoryRoot(inputPath);
  const [patterns, version, setUp] = await Promise.all([readPatterns(root), lfsVersion(), isSetUp(root)]);
  return { used: patterns.length > 0, installed: version !== null, setUp };
}

/** The LFS filter is configured (repository or global) and the pre-push hook uploads objects. */
async function isSetUp(root: string): Promise<boolean> {
  const [prePush, filter] = await Promise.all([
    runGit(root, ["rev-parse", "--git-path", "hooks/pre-push"]),
    runGit(root, ["config", "--get", "filter.lfs.process"]),
  ]);
  if (filter.code !== 0 || prePush.code !== 0) return false;
  try {
    const hook = fs.readFileSync(path.resolve(root, prePush.stdout.trim()), "utf8");
    return hook.includes("git lfs pre-push") || hook.includes("git-lfs pre-push");
  } catch {
    return false;
  }
}

export interface LfsAutoResult {
  /** git-lfs is missing although the repository uses LFS. */
  missing: boolean;
  setUp: boolean;
  /** LFS files whose content was downloaded into the folder. */
  downloaded: number;
  message: string | null;
}

/** What Chrono does on its own for a repository that uses LFS: set it up
 *  (`git lfs install --local`) when it is not, then put the content of LFS
 *  files in place of their pointers (`git lfs pull`), as a clone with LFS
 *  configured would have. Repositories that do not use LFS are untouched. */
export async function lfsAuto(inputPath: string, options: { pull?: boolean } = {}): Promise<LfsAutoResult> {
  const root = await repositoryRoot(inputPath);
  const [patterns, version] = await Promise.all([readPatterns(root), lfsVersion()]);
  if (!patterns.length) return { missing: false, setUp: false, downloaded: 0, message: null };
  if (!version) return { missing: true, setUp: false, downloaded: 0, message: "This repository uses Git LFS, but git-lfs is not installed" };
  let setUp = false;
  if (!(await isSetUp(root))) {
    await checked(root, ["lfs", "install", "--local"]);
    setUp = true;
  }
  let downloaded = 0;
  if (options.pull !== false) {
    const pending = (await lfsStatus(root)).files.filter((file) => file.oid && (!file.downloaded || file.pointerInWorktree));
    if (pending.length) {
      // A missing object on the server must not stop the others from arriving.
      const result = await runGit(root, ["lfs", "pull"]);
      const after = new Map((await lfsStatus(root)).files.map((file) => [file.path, file]));
      downloaded = pending.filter((file) => { const now = after.get(file.path); return now?.downloaded && !now.pointerInWorktree; }).length;
      if (result.code !== 0 && downloaded < pending.length) {
        return { missing: false, setUp, downloaded, message: `Git LFS${setUp ? " is set up, but" : ":"} ${pending.length - downloaded} file(s) could not be downloaded (${result.stderr.trim().split("\n").pop() ?? "git lfs pull failed"})` };
      }
    }
  }
  const parts = [setUp ? "set up Git LFS in this repository" : "", downloaded ? `downloaded ${downloaded} LFS file${downloaded === 1 ? "" : "s"}` : ""].filter(Boolean);
  return { missing: false, setUp, downloaded, message: parts.length ? `Chrono ${parts.join(" and ")}` : null };
}

async function readPatterns(root: string): Promise<LfsPattern[]> {
  const listed = await runGit(root, ["ls-files", "-z", "--", ".gitattributes", ":(glob)**/.gitattributes"]);
  const sources = new Set(listed.stdout.split("\0").filter(Boolean));
  if (fs.existsSync(path.join(root, ".gitattributes"))) sources.add(".gitattributes");
  const patterns: LfsPattern[] = [];
  for (const source of [...sources].sort()) {
    try { patterns.push(...parseLfsAttributes(fs.readFileSync(path.join(root, source), "utf8"), source)); } catch { /* deleted in the work tree */ }
  }
  return patterns;
}

export async function lfsStatus(inputPath: string): Promise<LfsStatus> {
  const root = await repositoryRoot(inputPath);
  const [version, patterns, store, hooks] = await Promise.all([lfsVersion(), readPatterns(root), lfsStoreDir(root), isSetUp(root)]);

  const files: LfsFile[] = [];
  if (patterns.length) {
    const listed = await runGit(root, ["ls-files", "-s", "-z", "--", ":(attr:filter=lfs)"]);
    const entries: Array<{ path: string; sha: string }> = [];
    for (const record of listed.stdout.split("\0")) {
      const match = /^\d+ ([0-9a-f]+) 0\t(.+)$/s.exec(record);
      if (match) entries.push({ sha: match[1], path: match[2] });
    }
    const blobs = await readBlobs(root, [...new Set(entries.map((entry) => entry.sha))]);
    for (const entry of entries) {
      const pointer = parsePointer(blobs.get(entry.sha) ?? "");
      let worktreePointer = false;
      let size = pointer?.size ?? 0;
      try {
        const stat = fs.statSync(path.join(root, entry.path));
        if (!pointer) size = stat.size;
        if (pointer && stat.size < 1024 && stat.size !== pointer.size) worktreePointer = parsePointer(fs.readFileSync(path.join(root, entry.path), "utf8")) !== null;
      } catch { /* deleted in the work tree */ }
      files.push({
        path: entry.path,
        oid: pointer?.oid ?? null,
        size,
        downloaded: pointer ? fs.existsSync(objectPath(store, pointer.oid)) : true,
        pointerInWorktree: worktreePointer,
      });
    }
  }
  return {
    root,
    installed: version !== null,
    version,
    used: patterns.length > 0,
    hooks,
    patterns,
    files,
    unconverted: files.filter((file) => !file.oid).length,
    missing: files.filter((file) => file.oid && !file.downloaded).length,
    storeBytes: storeSize(store),
  };
}

export function parseLocks(json: string): LfsLock[] {
  if (!json.trim()) return [];
  const data = JSON.parse(json) as Array<{ id: string; path: string; owner?: { name?: string }; locked_at?: string }>;
  return data.map((lock) => ({ id: String(lock.id), path: lock.path, owner: lock.owner?.name ?? "", lockedAt: lock.locked_at ?? "" }));
}

async function requireLfs(): Promise<void> {
  if (!(await lfsVersion())) throw new AppError("command", "git-lfs is not installed. Install it (Ubuntu: sudo apt install git-lfs; macOS: brew install git-lfs; Windows: it comes with Git for Windows), then try again.");
}

export async function lfsLocks(inputPath: string): Promise<LfsLock[]> {
  await requireLfs();
  const root = await repositoryRoot(inputPath);
  return parseLocks(await checkedStdout(root, ["lfs", "locks", "--json"]));
}

function safePattern(value: string): string {
  const pattern = value.trim();
  if (!pattern || pattern.startsWith("-") || /[\0\n\r]/.test(pattern)) throw invalidError("invalid LFS pattern");
  return pattern;
}

function safePaths(root: string, files: string[]): string[] {
  if (!files.length) throw invalidError("choose at least one file");
  return files.map((file) => {
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || file.startsWith("-") || file.includes("\0")) throw invalidError(`invalid path: ${file}`);
    if (!path.resolve(root, file).startsWith(root)) throw invalidError(`invalid path: ${file}`);
    return file;
  });
}

async function streamed(root: string, args: string[], streamId: string | null | undefined): Promise<CommandResult> {
  if (!streamId) return checked(root, args);
  const out = await runGitStreaming(root, args, streamId);
  finishStream(streamId, out.code);
  if (out.code !== 0) throw new AppError("command", `git ${args.join(" ")}: ${out.stderr.replace(/\s+/g, " ").trim() || `exit code ${out.code}`}`);
  return { stdout: out.stdout, stderr: out.stderr, exitCode: 0 };
}

export type LfsAction =
  | { action: "install" }
  | { action: "track"; pattern: string; lockable?: boolean }
  | { action: "untrack"; pattern: string }
  | { action: "convert"; files: string[] }
  | { action: "fetch"; all?: boolean }
  | { action: "pull"; files?: string[] }
  | { action: "push"; all?: boolean }
  | { action: "prune" }
  | { action: "lock"; files: string[] }
  | { action: "unlock"; files?: string[]; id?: string; force?: boolean };

export async function lfsAction(inputPath: string, request: LfsAction, streamId: string | null = null): Promise<string> {
  await requireLfs();
  const root = await repositoryRoot(inputPath);
  switch (request.action) {
    case "install":
      // Repository-local: the filter and the hooks that upload objects on push.
      await checked(root, ["lfs", "install", "--local"]);
      return "Git LFS is set up in this repository";
    case "track": {
      const pattern = safePattern(request.pattern);
      await checked(root, ["lfs", "track", ...(request.lockable ? ["--lockable"] : []), "--", pattern]);
      return `Tracking ${pattern} with LFS; .gitattributes changed`;
    }
    case "untrack": {
      const pattern = safePattern(request.pattern);
      await checked(root, ["lfs", "untrack", "--", pattern]);
      return `${pattern} is no longer tracked with LFS; .gitattributes changed`;
    }
    case "convert": {
      // Re-adding runs the clean filter: matching files become LFS pointers in the index.
      const files = safePaths(root, request.files);
      await checked(root, ["add", "--renormalize", "--", ...files]);
      return `Staged ${files.length} file(s) as LFS objects; commit to finish`;
    }
    case "fetch":
      await streamed(root, ["lfs", "fetch", ...(request.all ? ["--all"] : [])], streamId);
      return request.all ? "Fetched LFS objects for every ref" : "Fetched LFS objects";
    case "pull": {
      const include = request.files?.length ? [`--include=${safePaths(root, request.files).join(",")}`, "--exclude="] : [];
      await streamed(root, ["lfs", "pull", ...include], streamId);
      return request.files?.length ? `Downloaded ${request.files.length} LFS file(s)` : "Downloaded LFS files";
    }
    case "push": {
      const remote = (await runGit(root, ["remote"])).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      const target = remote.includes("origin") ? "origin" : remote[0];
      if (!target) throw invalidError("this repository has no remote");
      await streamed(root, ["lfs", "push", ...(request.all ? ["--all"] : []), target, ...(request.all ? [] : ["HEAD"])], streamId);
      return `Uploaded LFS objects to ${target}`;
    }
    case "prune":
      await streamed(root, ["lfs", "prune"], streamId);
      return "Removed old local LFS objects";
    case "lock": {
      const files = safePaths(root, request.files);
      for (const file of files) await checked(root, ["lfs", "lock", "--", file]);
      return `Locked ${files.length} file(s)`;
    }
    case "unlock": {
      const force = request.force ? ["--force"] : [];
      if (request.id) {
        if (!/^[\w-]+$/.test(request.id)) throw invalidError("invalid lock id");
        await checked(root, ["lfs", "unlock", ...force, `--id=${request.id}`]);
        return "Unlocked";
      }
      const files = safePaths(root, request.files ?? []);
      for (const file of files) await checked(root, ["lfs", "unlock", ...force, "--", file]);
      return `Unlocked ${files.length} file(s)`;
    }
    default:
      throw invalidError("unknown LFS action");
  }
}

/** Content of an LFS pointer from the local store, if downloaded. */
export async function lfsContent(root: string, pointerText: string): Promise<Buffer | null> {
  const pointer = parsePointer(pointerText);
  if (!pointer) return null;
  try {
    const file = objectPath(await lfsStoreDir(root), pointer.oid);
    const stat = fs.statSync(file);
    if (stat.size !== pointer.size || stat.size > 64 * 1024 * 1024) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// TortoiseGit-style working-copy explorer.
//
// Lists a working-tree folder the way Windows Explorer does with TortoiseGit
// installed: every entry carries an "overlay" status (normal, modified,
// added, conflicted, untracked, ignored, deleted, …) and the context-menu
// actions TortoiseGit exposes (Add, Revert, Resolve, Delete (keep local),
// Rename, Add to ignore list, Clean up, Assume unchanged, LFS lock, …) are
// implemented here as one dispatcher.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError, invalidError } from "./lib/errors.ts";
import {
  checked,
  checkedStdout,
  COMMIT_FORMAT,
  hasHead,
  literalPathspec,
  parseCommits,
  repositoryRoot,
  runGit,
  type CommandResult,
  type CommitRecord,
} from "./lib/git.ts";
import { parseUnifiedHunks, type CommitDiffHunk } from "./insights.ts";
import { diffRevisions, type RevisionDiff } from "./repo.ts";

export type OverlayStatus =
  | "normal"
  | "modified"
  | "staged"
  | "added"
  | "deleted"
  | "renamed"
  | "conflicted"
  | "untracked"
  | "ignored"
  | "unversioned-dir";

export interface ExplorerEntry {
  name: string;
  /** repository-relative, forward slashes */
  path: string;
  type: "dir" | "file" | "submodule" | "symlink";
  size: number | null;
  modifiedAt: string | null;
  status: OverlayStatus;
  indexStatus: string;
  worktreeStatus: string;
  tracked: boolean;
  assumeUnchanged: boolean;
  skipWorktree: boolean;
  /** missing on disk but still tracked (deleted in the working tree) */
  missing: boolean;
  /** number of changed descendants for folders */
  changedCount: number;
}

export interface ExplorerListing {
  root: string;
  dir: string;
  branch: string | null;
  entries: ExplorerEntry[];
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function cleanRelative(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") return "";
  if (normalized.startsWith("/") || normalized.startsWith("-") || normalized.includes("\0") || /(^|\/)\.\.(\/|$)/.test(normalized)) {
    throw invalidError(`invalid repository-relative path: ${value}`);
  }
  if (normalized === ".git" || normalized.startsWith(".git/")) throw invalidError("the .git directory is not browsable");
  return normalized;
}

function cleanFiles(files: string[]): string[] {
  if (files.length === 0) throw invalidError("select at least one file or folder");
  return files.map(cleanRelative).map((file) => file || ".");
}

function absolute(root: string, rel: string): string {
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw invalidError("path escapes the repository");
  return resolved;
}

function pathspecs(files: string[]): string[] {
  return files.map((file) => (file === "." ? "." : literalPathspec(file)));
}

// ---------------------------------------------------------------------------
// Status collection
// ---------------------------------------------------------------------------

type StatusRecord = { index: string; worktree: string };

async function collectStatus(root: string, dir: string): Promise<{ status: Map<string, StatusRecord>; ignoredDirs: string[] }> {
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"];
  if (dir) args.push("--", literalPathspec(dir));
  const output = await runGit(root, args);
  const status = new Map<string, StatusRecord>();
  const ignoredDirs: string[] = [];
  if (output.code !== 0) return { status, ignoredDirs };
  const entries = output.stdout.split("\0").filter((entry) => entry.length > 0);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const index = entry[0] ?? " ";
    const worktree = entry[1] ?? " ";
    let file = entry.slice(3);
    if (index === "R" || index === "C") i += 1; // skip original path
    if (index === "!" && file.endsWith("/")) {
      ignoredDirs.push(file.slice(0, -1));
      continue;
    }
    if (file.endsWith("/")) file = file.slice(0, -1);
    status.set(file, { index, worktree });
  }
  return { status, ignoredDirs };
}

function isConflict(record: StatusRecord): boolean {
  const pair = record.index + record.worktree;
  return record.index === "U" || record.worktree === "U" || pair === "AA" || pair === "DD";
}

function overlayFor(record: StatusRecord | undefined, tracked: boolean): OverlayStatus {
  if (!record) return tracked ? "normal" : "untracked";
  if (record.index === "!") return "ignored";
  if (record.index === "?") return "untracked";
  if (isConflict(record)) return "conflicted";
  if (record.worktree === "D" || record.index === "D") return "deleted";
  if (record.index === "R") return "renamed";
  if (record.index === "A") return "added";
  if (record.worktree === "M" || record.worktree === "T") return "modified";
  if (record.index === "M" || record.index === "T") return "staged";
  return "normal";
}

const SEVERITY: OverlayStatus[] = ["conflicted", "deleted", "modified", "renamed", "added", "staged", "untracked"];

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export async function listDirectory(inputPath: string, dirInput: string): Promise<ExplorerListing> {
  const root = await repositoryRoot(inputPath);
  const dir = cleanRelative(dirInput);
  const absDir = absolute(root, dir);
  const prefix = dir ? `${dir}/` : "";

  const [dirents, { status, ignoredDirs }, lsFiles, lsStage, branchOut] = await Promise.all([
    fs.readdir(absDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      throw new AppError("io", `cannot read ${absDir}: ${error.message}`);
    }),
    collectStatus(root, dir),
    runGit(root, ["ls-files", "-v", "-z", "--", dir ? literalPathspec(dir) : "."]),
    runGit(root, ["ls-files", "-s", "-z", "--", dir ? literalPathspec(dir) : "."]),
    runGit(root, ["branch", "--show-current"]),
  ]);

  // Tracked child names, assume-unchanged/skip-worktree flags and gitlinks.
  const trackedChildren = new Set<string>();
  const trackedFiles = new Set<string>();
  const assume = new Set<string>();
  const skip = new Set<string>();
  for (const record of lsFiles.stdout.split("\0")) {
    if (record.length < 3) continue;
    const tag = record[0];
    const file = record.slice(2);
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const child = rest.split("/")[0];
    trackedChildren.add(child);
    if (!rest.includes("/")) trackedFiles.add(child);
    if (tag === "S" || tag === "s") skip.add(file);
    if (tag >= "a" && tag <= "z") assume.add(file);
  }
  const gitlinks = new Set<string>();
  for (const record of lsStage.stdout.split("\0")) {
    const match = /^160000 [0-9a-f]+ \d\t(.*)$/.exec(record);
    if (match) gitlinks.add(match[1]);
  }

  // Aggregate descendant status per direct child folder.
  const childAggregate = new Map<string, { worst: OverlayStatus; count: number }>();
  for (const [file, record] of status) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    if (!rest.includes("/")) continue;
    const child = rest.split("/")[0];
    const overlay = overlayFor(record, true);
    if (overlay === "ignored" || overlay === "normal") continue;
    const current = childAggregate.get(child) ?? { worst: "normal" as OverlayStatus, count: 0 };
    current.count += 1;
    const rank = (value: OverlayStatus) => { const at = SEVERITY.indexOf(value); return at < 0 ? 99 : at; };
    if (rank(overlay) < rank(current.worst)) current.worst = overlay;
    childAggregate.set(child, current);
  }
  const ignoredSet = new Set(ignoredDirs);

  const entries: ExplorerEntry[] = [];
  const seen = new Set<string>();
  for (const dirent of dirents) {
    if (dirent.name === ".git") continue;
    const rel = prefix + dirent.name;
    seen.add(dirent.name);
    let info: import("node:fs").Stats | null = null;
    try { info = await fs.lstat(path.join(absDir, dirent.name)); } catch { info = null; }
    const isDir = dirent.isDirectory();
    const isLink = dirent.isSymbolicLink();
    const type: ExplorerEntry["type"] = gitlinks.has(rel) ? "submodule" : isLink ? "symlink" : isDir ? "dir" : "file";
    const record = status.get(rel);
    let overlay: OverlayStatus;
    let changedCount = 0;
    if (type === "dir") {
      const aggregate = childAggregate.get(dirent.name);
      if (ignoredSet.has(rel)) overlay = "ignored";
      else if (aggregate && aggregate.worst !== "untracked") overlay = aggregate.worst;
      else if (!trackedChildren.has(dirent.name)) overlay = aggregate ? "untracked" : "unversioned-dir";
      else overlay = "normal"; // tracked folder whose only changes are unversioned files
      changedCount = aggregate?.count ?? 0;
    } else {
      overlay = overlayFor(record, trackedFiles.has(dirent.name) || gitlinks.has(rel));
      if (record) changedCount = 1;
    }
    entries.push({
      name: dirent.name,
      path: rel,
      type,
      size: info && !isDir ? info.size : null,
      modifiedAt: info ? info.mtime.toISOString() : null,
      status: overlay,
      indexStatus: record?.index.trim() ?? "",
      worktreeStatus: record?.worktree.trim() ?? "",
      tracked: type === "dir" ? trackedChildren.has(dirent.name) : trackedFiles.has(dirent.name) || gitlinks.has(rel),
      assumeUnchanged: assume.has(rel),
      skipWorktree: skip.has(rel),
      missing: false,
      changedCount,
    });
  }
  // Tracked files deleted from disk still deserve a row (TortoiseGit shows
  // them in "Check for modifications"; we surface them inline).
  for (const [file, record] of status) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    if (rest.includes("/") || seen.has(rest)) continue;
    if (record.worktree !== "D" && record.index !== "D") continue;
    entries.push({
      name: rest, path: file, type: "file", size: null, modifiedAt: null,
      status: isConflict(record) ? "conflicted" : "deleted",
      indexStatus: record.index.trim(), worktreeStatus: record.worktree.trim(),
      tracked: true, assumeUnchanged: false, skipWorktree: false, missing: true, changedCount: 1,
    });
  }
  entries.sort((a, b) => {
    const aDir = a.type === "dir" || a.type === "submodule" ? 0 : 1;
    const bDir = b.type === "dir" || b.type === "submodule" ? 0 : 1;
    return aDir - bDir || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  });
  const branch = branchOut.code === 0 ? branchOut.stdout.trim() : "";
  return { root, dir, branch: branch || null, entries };
}

// ---------------------------------------------------------------------------
// Properties (TortoiseGit "Properties → Git" tab)
// ---------------------------------------------------------------------------

export interface ExplorerProperties {
  path: string;
  absolutePath: string;
  exists: boolean;
  type: "dir" | "file" | "symlink" | "missing";
  size: number | null;
  modifiedAt: string | null;
  mode: string | null;
  blob: string | null;
  tracked: boolean;
  status: OverlayStatus;
  lastCommit: CommitRecord | null;
  firstCommit: CommitRecord | null;
  commitCount: number;
  attributes: Array<{ name: string; value: string }>;
  ignoredBy: string | null;
  lfs: boolean;
  assumeUnchanged: boolean;
  skipWorktree: boolean;
}

export async function properties(inputPath: string, fileInput: string): Promise<ExplorerProperties> {
  const root = await repositoryRoot(inputPath);
  const rel = cleanRelative(fileInput) || ".";
  const abs = absolute(root, rel);
  let info: import("node:fs").Stats | null = null;
  try { info = await fs.lstat(abs); } catch { info = null; }
  const spec = rel === "." ? "." : literalPathspec(rel);
  const head = await hasHead(root);
  const [stage, lsv, attrs, ignore, last, first, count, st] = await Promise.all([
    runGit(root, ["ls-files", "-s", "--", spec]),
    runGit(root, ["ls-files", "-v", "--", spec]),
    rel === "." ? Promise.resolve({ stdout: "", stderr: "", code: 0 }) : runGit(root, ["check-attr", "-a", "--", rel]),
    rel === "." ? Promise.resolve({ stdout: "", stderr: "", code: 1 }) : runGit(root, ["check-ignore", "-v", "--no-index", "--", rel]),
    head ? runGit(root, ["log", "-1", "--date=iso-strict", `--pretty=format:${COMMIT_FORMAT}`, "--", spec]) : null,
    head ? runGit(root, ["log", "--reverse", "--date=iso-strict", `--pretty=format:${COMMIT_FORMAT}`, "--", spec]) : null,
    head ? runGit(root, ["rev-list", "--count", "HEAD", "--", spec]) : null,
    runGit(root, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all", "--", spec]),
  ]);
  const stageLines = stage.stdout.split(/\r?\n/).filter(Boolean);
  const single = stageLines.length === 1 ? /^(\d+) ([0-9a-f]+) \d\t(.*)$/.exec(stageLines[0]) : null;
  const attributes = attrs.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split(": ");
    return { name: parts[1] ?? "", value: parts.slice(2).join(": ") };
  }).filter((attr) => attr.name);
  const statusEntry = st.stdout.split("\0").find((entry) => entry.length > 3);
  const record = statusEntry ? { index: statusEntry[0], worktree: statusEntry[1] } : undefined;
  const flags = lsv.stdout.split(/\r?\n/).filter(Boolean);
  const firstCommits = first ? parseCommits(first.stdout.split("\u001e")[0] + "\u001e") : [];
  return {
    path: rel,
    absolutePath: abs,
    exists: info !== null,
    type: info === null ? "missing" : info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "dir" : "file",
    size: info && !info.isDirectory() ? info.size : null,
    modifiedAt: info ? info.mtime.toISOString() : null,
    mode: single ? single[1] : null,
    blob: single ? single[2] : null,
    tracked: stageLines.length > 0,
    status: overlayFor(record, stageLines.length > 0),
    lastCommit: last ? parseCommits(last.stdout)[0] ?? null : null,
    firstCommit: firstCommits[0] ?? null,
    commitCount: count && count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) || 0 : 0,
    attributes,
    ignoredBy: ignore.code === 0 ? ignore.stdout.trim() || null : null,
    lfs: attributes.some((attr) => attr.name === "filter" && attr.value === "lfs"),
    assumeUnchanged: flags.length === 1 && flags[0][0] >= "a" && flags[0][0] <= "z",
    skipWorktree: flags.length === 1 && (flags[0][0] === "S" || flags[0][0] === "s"),
  };
}

// ---------------------------------------------------------------------------
// Diffs: "Diff with…" two arbitrary files and "Diff with previous version"
// ---------------------------------------------------------------------------

export interface FilePairDiff {
  left: string;
  right: string;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: CommitDiffHunk[];
}

export async function diffTwoFiles(inputPath: string, leftInput: string, rightInput: string): Promise<FilePairDiff> {
  const root = await repositoryRoot(inputPath);
  const left = cleanRelative(leftInput);
  const right = cleanRelative(rightInput);
  if (!left || !right) throw invalidError("two files are required");
  absolute(root, left); absolute(root, right);
  // --no-index exits 1 when files differ; that's not an error.
  const numstat = await runGit(root, ["diff", "--no-index", "--numstat", "--", left, right]);
  const line = numstat.stdout.split(/\r?\n/).find(Boolean) ?? "";
  const [add, del] = line.split("\t");
  const binary = add === "-" || del === "-";
  const raw = binary ? "" : (await runGit(root, ["diff", "--no-index", "--unified=3", "--", left, right])).stdout;
  if (numstat.code > 1) throw new AppError("command", numstat.stderr.trim() || "git diff --no-index failed");
  return {
    left, right, binary,
    additions: binary ? 0 : Number.parseInt(add ?? "0", 10) || 0,
    deletions: binary ? 0 : Number.parseInt(del ?? "0", 10) || 0,
    hunks: raw ? parseUnifiedHunks(raw) : [],
  };
}

export interface PreviousVersionDiff extends RevisionDiff {
  from: string;
  to: string;
  subject: string;
}

export async function diffWithPrevious(inputPath: string, fileInput: string): Promise<PreviousVersionDiff> {
  const root = await repositoryRoot(inputPath);
  const rel = cleanRelative(fileInput);
  if (!rel) throw invalidError("choose a file");
  if (!(await hasHead(root))) throw invalidError("the repository has no commits yet");
  const commits = parseCommits(await checkedStdout(root, ["log", "-2", "--date=iso-strict", `--pretty=format:${COMMIT_FORMAT}`, "--", literalPathspec(rel)]));
  if (commits.length === 0) throw invalidError(`${rel} has no committed history`);
  const to = commits[0].id;
  const from = commits[0].parents[0] ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const diff = await diffRevisions(root, from, to, rel);
  return { ...diff, from, to, subject: commits[0].subject };
}

// ---------------------------------------------------------------------------
// Patch from working-copy changes (TortoiseGit "Create Patch…" on a selection)
// ---------------------------------------------------------------------------

export async function workingPatch(inputPath: string, filesInput: string[]): Promise<{ name: string; text: string }> {
  const root = await repositoryRoot(inputPath);
  const files = cleanFiles(filesInput);
  const base = (await hasHead(root)) ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const text = await checkedStdout(root, ["diff", "--binary", base, "--", ...pathspecs(files)]);
  const stem = files.length === 1 ? path.basename(files[0] === "." ? root : files[0]) : "selection";
  return { name: `${stem.replace(/[^A-Za-z0-9._-]+/g, "_")}.patch`, text };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ExplorerAction =
  | "add"
  | "unstage"
  | "revert"
  | "delete"
  | "remove_keep_local"
  | "rename"
  | "ignore_name"
  | "ignore_ext"
  | "ignore_and_remove"
  | "resolve"
  | "resolve_ours"
  | "resolve_theirs"
  | "assume_unchanged"
  | "no_assume_unchanged"
  | "skip_worktree"
  | "no_skip_worktree"
  | "clean"
  | "stash_save"
  | "checkout_revision"
  | "lfs_lock"
  | "lfs_unlock"
  | "lfs_track"
  | "submodule_update"
  | "commit"
  | "export"
  | "new_folder"
  | "new_file";

export interface ExplorerActionRequest {
  action: ExplorerAction;
  files: string[];
  /** action-specific options */
  message?: string;
  newName?: string;
  revision?: string;
  scope?: "local" | "root";
  cleanMode?: "untracked" | "ignored" | "all";
  dryRun?: boolean;
  amend?: boolean;
  destination?: string;
}

export interface ExplorerActionResult extends CommandResult {
  action: ExplorerAction;
  summary: string;
}

async function appendIgnore(root: string, ignoreDir: string, patterns: string[]): Promise<string> {
  const file = path.join(absolute(root, ignoreDir || "."), ".gitignore");
  let existing = "";
  try { existing = await fs.readFile(file, "utf8"); } catch { existing = ""; }
  const lines = new Set(existing.split(/\r?\n/));
  const additions = patterns.filter((pattern) => !lines.has(pattern));
  if (additions.length) {
    const prefix = existing.length && !existing.endsWith("\n") ? "\n" : "";
    await fs.writeFile(file, existing + prefix + additions.join("\n") + "\n", "utf8");
  }
  return path.relative(root, file).replace(/\\/g, "/");
}

function escapeIgnore(name: string): string {
  return name.replace(/([\\*?[\]!# ])/g, "\\$1");
}

async function trackedSubset(root: string, files: string[]): Promise<{ tracked: string[]; untracked: string[]; added: string[] }> {
  const tracked: string[] = [];
  const untracked: string[] = [];
  const added: string[] = [];
  const headExists = await hasHead(root);
  for (const file of files) {
    const ls = await runGit(root, ["ls-files", "--", file === "." ? "." : literalPathspec(file)]);
    if (ls.stdout.trim().length === 0) { untracked.push(file); continue; }
    if (headExists && file !== ".") {
      const inHead = await runGit(root, ["ls-tree", "--name-only", "HEAD", "--", file]);
      if (inHead.stdout.trim().length === 0) { added.push(file); continue; }
    } else if (!headExists) { added.push(file); continue; }
    tracked.push(file);
  }
  return { tracked, untracked, added };
}

function merge(results: CommandResult[]): CommandResult {
  return {
    stdout: results.map((result) => result.stdout).filter(Boolean).join("\n"),
    stderr: results.map((result) => result.stderr).filter(Boolean).join("\n"),
    exitCode: results.reduce((code, result) => code || result.exitCode, 0),
  };
}

const OK: CommandResult = { stdout: "", stderr: "", exitCode: 0 };

export async function runAction(inputPath: string, request: ExplorerActionRequest): Promise<ExplorerActionResult> {
  const root = await repositoryRoot(inputPath);
  const action = request.action;
  const done = (result: CommandResult, summary: string): ExplorerActionResult => ({ ...result, action, summary });

  if (action === "new_folder" || action === "new_file") {
    const parent = cleanRelative(request.files[0] ?? "");
    const name = (request.newName ?? "").trim();
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") throw invalidError("enter a valid name");
    const target = absolute(root, parent ? `${parent}/${name}` : name);
    if (action === "new_folder") await fs.mkdir(target);
    else await fs.writeFile(target, "", { flag: "wx" });
    return done(OK, `Created ${path.relative(root, target)}`);
  }

  const files = cleanFiles(request.files);
  for (const file of files) absolute(root, file);
  const specs = pathspecs(files);

  switch (action) {
    case "add":
      return done(await checked(root, ["add", "--", ...specs]), `Added ${files.length} item(s)`);
    case "unstage": {
      const headExists = await hasHead(root);
      const result = headExists
        ? await checked(root, ["restore", "--staged", "--", ...specs])
        : await checked(root, ["rm", "-r", "--cached", "--quiet", "--", ...specs]);
      return done(result, `Unstaged ${files.length} item(s)`);
    }
    case "revert": {
      // TortoiseGit Revert: tracked → restore index + worktree from HEAD;
      // newly added → unstage only (file is kept, like TortoiseGit).
      const { tracked, added } = await trackedSubset(root, files);
      const results: CommandResult[] = [];
      if (tracked.length) results.push(await checked(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...pathspecs(tracked)]));
      if (added.length) results.push(await checked(root, ["rm", "-r", "--cached", "--quiet", "--", ...pathspecs(added)]));
      return done(merge(results.length ? results : [OK]), `Reverted ${tracked.length + added.length} item(s)`);
    }
    case "delete": {
      const { tracked, untracked, added } = await trackedSubset(root, files);
      const results: CommandResult[] = [];
      const versioned = [...tracked, ...added];
      if (versioned.length) results.push(await checked(root, ["rm", "-r", "-f", "--", ...pathspecs(versioned)]));
      for (const file of untracked) await fs.rm(absolute(root, file), { recursive: true, force: true });
      return done(merge(results.length ? results : [OK]), `Deleted ${files.length} item(s)`);
    }
    case "remove_keep_local":
      return done(await checked(root, ["rm", "-r", "--cached", "--", ...specs]), `Removed ${files.length} item(s) from version control (kept on disk)`);
    case "rename": {
      if (files.length !== 1) throw invalidError("rename one item at a time");
      const from = files[0];
      const name = (request.newName ?? "").trim().replace(/\\/g, "/");
      if (!name || name.includes("\0") || name.startsWith("-")) throw invalidError("enter a new name");
      const to = cleanRelative(name.includes("/") ? name : path.posix.join(path.posix.dirname(from), name));
      absolute(root, to);
      const ls = await runGit(root, ["ls-files", "--", literalPathspec(from)]);
      if (ls.stdout.trim()) return done(await checked(root, ["mv", "--", from, to]), `Renamed ${from} → ${to}`);
      await fs.rename(absolute(root, from), absolute(root, to));
      return done(OK, `Renamed ${from} → ${to}`);
    }
    case "ignore_name":
    case "ignore_ext":
    case "ignore_and_remove": {
      const written = new Set<string>();
      if (action === "ignore_and_remove") {
        const tracked = (await trackedSubset(root, files)).tracked;
        if (tracked.length) await checked(root, ["rm", "-r", "--cached", "--quiet", "--", ...pathspecs(tracked)]);
      }
      for (const file of files) {
        if (file === ".") continue;
        let isDir = false;
        try { isDir = (await fs.stat(absolute(root, file))).isDirectory(); } catch { isDir = false; }
        const base = path.posix.basename(file);
        const parent = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
        let pattern: string;
        if (action === "ignore_ext") {
          const ext = path.posix.extname(base);
          if (!ext) throw invalidError(`${base} has no extension`);
          pattern = `*${escapeIgnore(ext)}`;
        } else {
          pattern = request.scope === "root" ? `/${file.split("/").map(escapeIgnore).join("/")}` : `/${escapeIgnore(base)}`;
          if (isDir) pattern += "/";
        }
        written.add(await appendIgnore(root, request.scope === "root" ? "" : parent, [pattern]));
      }
      return done(OK, `Updated ${[...written].join(", ")}`);
    }
    case "resolve":
      return done(await checked(root, ["add", "--", ...specs]), `Marked ${files.length} item(s) as resolved`);
    case "resolve_ours":
    case "resolve_theirs": {
      const side = action === "resolve_ours" ? "--ours" : "--theirs";
      const results = [await checked(root, ["checkout", side, "--", ...specs]), await checked(root, ["add", "--", ...specs])];
      return done(merge(results), `Resolved ${files.length} item(s) using ${action === "resolve_ours" ? "mine" : "theirs"}`);
    }
    case "assume_unchanged":
    case "no_assume_unchanged":
    case "skip_worktree":
    case "no_skip_worktree": {
      const flag = { assume_unchanged: "--assume-unchanged", no_assume_unchanged: "--no-assume-unchanged", skip_worktree: "--skip-worktree", no_skip_worktree: "--no-skip-worktree" }[action];
      const listed = (await checkedStdout(root, ["ls-files", "-z", "--", ...specs])).split("\0").filter(Boolean);
      if (!listed.length) throw invalidError("no tracked files in the selection");
      return done(await checked(root, ["update-index", flag, "--", ...listed]), `${flag.replace(/^--/, "")} set on ${listed.length} file(s)`);
    }
    case "clean": {
      const mode = request.cleanMode ?? "untracked";
      const args = ["clean", "-d", request.dryRun ? "-n" : "-f"];
      if (mode === "ignored") args.push("-X");
      if (mode === "all") args.push("-x");
      args.push("--", ...specs);
      const result = await checked(root, args);
      const count = result.stdout.split(/\r?\n/).filter(Boolean).length;
      return done(result, request.dryRun ? `${count} item(s) would be removed` : `Removed ${count} item(s)`);
    }
    case "stash_save": {
      const message = request.message?.trim() || `Chrono stash of ${files.join(", ")}`;
      return done(await checked(root, ["stash", "push", "--include-untracked", "-m", message, "--", ...specs]), `Stashed ${files.length} item(s)`);
    }
    case "checkout_revision": {
      const revision = (request.revision ?? "").trim();
      if (!revision || revision.startsWith("-")) throw invalidError("choose a revision");
      return done(await checked(root, ["checkout", revision, "--", ...specs]), `Reverted ${files.length} item(s) to ${revision.slice(0, 12)}`);
    }
    case "lfs_lock":
    case "lfs_unlock": {
      const results: CommandResult[] = [];
      for (const file of files) results.push(await checked(root, ["lfs", action === "lfs_lock" ? "lock" : "unlock", file]));
      return done(merge(results), `${action === "lfs_lock" ? "Locked" : "Unlocked"} ${files.length} file(s)`);
    }
    case "lfs_track": {
      const results: CommandResult[] = [];
      for (const file of files) {
        const ext = path.posix.extname(file);
        results.push(await checked(root, ["lfs", "track", ext ? `*${ext}` : file]));
      }
      return done(merge(results), "Updated .gitattributes for LFS");
    }
    case "submodule_update":
      return done(await checked(root, ["submodule", "update", "--init", "--recursive", "--", ...files]), "Submodules updated");
    case "commit": {
      const message = (request.message ?? "").trim();
      if (!message && !request.amend) throw invalidError("commit message is empty");
      await checked(root, ["add", "-A", "--", ...specs]);
      const args = ["commit"];
      if (request.amend) args.push("--amend");
      if (message) args.push("-m", message); else args.push("--no-edit");
      args.push("--", ...specs);
      const result = await checked(root, args);
      return done(result, result.stdout.split(/\r?\n/)[0] ?? "Committed");
    }
    case "export": {
      const destination = (request.destination ?? "").trim();
      if (!destination || !path.isAbsolute(destination)) throw invalidError("export destination must be an absolute path");
      const revision = (request.revision ?? "HEAD").trim() || "HEAD";
      if (revision.startsWith("-")) throw invalidError("invalid revision");
      const format = destination.endsWith(".tar") ? "tar" : destination.endsWith(".tar.gz") || destination.endsWith(".tgz") ? "tar.gz" : "zip";
      const result = await checked(root, ["archive", `--format=${format}`, "-o", destination, revision, "--", ...files]);
      return done(result, `Exported ${files.length} item(s) at ${revision} to ${destination}`);
    }
    default:
      throw invalidError(`unknown explorer action: ${String(action)}`);
  }
}

// ---------------------------------------------------------------------------
// Open with the host's shell (only meaningful when the server is local)
// ---------------------------------------------------------------------------

export async function openOnHost(inputPath: string, fileInput: string, mode: "open" | "reveal" | "terminal"): Promise<string> {
  const root = await repositoryRoot(inputPath);
  const rel = cleanRelative(fileInput);
  const abs = absolute(root, rel || ".");
  let target = abs;
  if (mode !== "open") {
    try { if (!(await fs.stat(abs)).isDirectory()) target = path.dirname(abs); } catch { target = path.dirname(abs); }
  }
  const platform = os.platform();
  let command: string;
  let args: string[];
  if (mode === "terminal") {
    if (platform === "win32") { command = "cmd.exe"; args = ["/c", "start", "cmd.exe", "/K", `cd /d "${target}"`]; }
    else if (platform === "darwin") { command = "open"; args = ["-a", "Terminal", target]; }
    else { command = "x-terminal-emulator"; args = ["--working-directory", target]; }
  } else if (platform === "win32") {
    command = "explorer.exe"; args = mode === "reveal" && target !== abs ? [`/select,${abs}`] : [target];
  } else if (platform === "darwin") {
    command = "open"; args = mode === "reveal" && target !== abs ? ["-R", abs] : [target];
  } else {
    command = "xdg-open"; args = [target];
  }
  await new Promise<void>((resolve, reject) => {
    const child = execFile(command, args, { cwd: target, windowsHide: false }, () => undefined);
    child.once("error", (error) => reject(new AppError("unsupported", `cannot launch ${command}: ${error.message}`)));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  return abs;
}

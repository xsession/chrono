// Repository management operations for TortoiseGit-parity: tags, merge,
// clean, repo browser (tree + file content at a revision), export, patch
// create/apply, working-tree diff, revision-to-revision diff and commit
// activity for heatmaps.
//
// All git execution goes through the shared lib/git helpers (argument arrays,
// GIT_TERMINAL_PROMPT=0, no shell interpolation).

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError, invalidError } from "./lib/errors.ts";
import {
  checked,
  checkedStdout,
  runGit,
  runGitRaw,
  type CommandResult,
} from "./lib/git.ts";
import { parseUnifiedHunks, type CommitDiffHunk } from "./insights.ts";

const MAX_FILE_BYTES = 1024 * 1024; // 1MB file-content cap for the repo browser
const MAX_EXPORT_FILES = 100000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function safeRevision(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-") || trimmed.includes("\0")) {
    throw invalidError("invalid revision");
  }
  return trimmed;
}

function safeSubPath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (trimmed.length === 0 || trimmed.startsWith("-") || trimmed.startsWith("/") ||
      trimmed.includes("\0") || /(^|\/)\.\.(\/|$)/.test(trimmed)) {
    throw invalidError("invalid repository-relative path");
  }
  return trimmed;
}

function safeRefName(value: string): string {
  const ref = value.trim();
  if (!/^[A-Za-z0-9._\/-]+$/.test(ref) || ref.includes("..") || ref.endsWith(".lock")) {
    throw invalidError("invalid ref name");
  }
  return ref;
}

// --- Tags -----------------------------------------------------------------

export interface TagRecord {
  name: string;
  target: string;
  annotated: boolean;
  tagger: string;
  date: string;
  message: string;
}

export async function listTags(inputPath: string): Promise<TagRecord[]> {
  const output = await checkedStdout(inputPath, [
    "for-each-ref",
    "refs/tags",
    "--format=%(refname:short)%00%(objecttype)%00%(objectname)%00%(taggername)%00%(taggerdate:iso-strict)%00%(subject)",
  ]);
  const tags: TagRecord[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.length) continue;
    const [name, type, target, tagger, date, message] = line.split("\0");
    if (!name) continue;
    tags.push({
      name,
      target: target ?? "",
      annotated: type === "tag",
      tagger: tagger ?? "",
      date: date ?? "",
      message: message ?? "",
    });
  }
  return tags.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createTag(inputPath: string, name: string, revision: string, message: string): Promise<CommandResult> {
  const ref = safeRefName(name);
  const rev = safeRevision(revision);
  const args = message.trim()
    ? ["tag", "-a", ref, "-m", message.trim(), rev]
    : ["tag", ref, rev];
  return checked(inputPath, args);
}

export async function deleteTag(inputPath: string, name: string): Promise<CommandResult> {
  return checked(inputPath, ["tag", "-d", safeRefName(name)]);
}

// --- Merge ------------------------------------------------------------------

export type MergeStrategy = "no-ff" | "squash" | "ff-only";

export async function mergeBranch(inputPath: string, branch: string, strategy: MergeStrategy): Promise<CommandResult> {
  const ref = safeRevision(branch);
  if (strategy === "squash") {
    const result = await runGit(inputPath, ["merge", "--squash", "--no-commit", ref]);
    if (result.code !== 0) throw new AppError("command", `git merge --squash ${ref}: ${result.stderr.trim()}`);
    return {
      stdout: `Squash of ${ref} is staged. Review the Changes view, then create the merge commit.`,
      stderr: "",
      exitCode: 0,
    };
  }
  const args = ["merge", "--no-edit", strategy === "no-ff" ? "--no-ff" : "--ff-only", ref];
  return checked(inputPath, args);
}

// --- Working tree ------------------------------------------------------------

export interface WorkingTreeDiff {
  path: string;
  binary: boolean;
  additions: number;
  deletions: number;
  status: string;
  hunks: CommitDiffHunk[];
}

/** Diff of the working tree against HEAD for a single file — the
 *  TortoiseGit "Diff with previous version" action. */
export async function workingTreeDiff(inputPath: string, file: string): Promise<WorkingTreeDiff> {
  const rel = safeSubPath(file);
  const statusLine = (await checkedStdout(inputPath, ["status", "--porcelain", "--", rel])).split(/\r?\n/).find((line) => line.length) ?? "";
  const status = statusLine.slice(0, 2).trim() || "??";
  const numstatLine = (await checkedStdout(inputPath, ["diff", "HEAD", "--numstat", "--", rel])).split(/\r?\n/).find((line) => line.length) ?? "";
  const [addRaw, delRaw] = numstatLine.split("\t");
  const binary = addRaw === "-" || delRaw === "-";
  const additions = binary ? 0 : Number.parseInt(addRaw, 10) || 0;
  const deletions = binary ? 0 : Number.parseInt(delRaw, 10) || 0;
  let raw = "";
  if (!binary && (additions > 0 || deletions > 0)) {
    raw = await checkedStdout(inputPath, ["diff", "HEAD", "--unified=3", "--", rel]);
  }
  return { path: rel, binary, additions, deletions, status, hunks: raw ? parseUnifiedHunks(raw) : [] };
}

/** Remove untracked files/directories. `dryRun` previews (`git clean -nd`). */
export async function cleanUntracked(inputPath: string, dryRun: boolean): Promise<CommandResult> {
  return dryRun
    ? checked(inputPath, ["clean", "-n", "-d"])
    : checked(inputPath, ["clean", "-f", "-d"]);
}

// --- Repo browser (file tree at a revision) -----------------------------------

export interface TreeEntry {
  name: string;
  path: string;
  type: "tree" | "blob";
  mode: string;
  size: number | null;
}

export async function listTree(inputPath: string, revision: string, dirPath: string): Promise<TreeEntry[]> {
  const rev = safeRevision(revision);
  const dir = dirPath ? safeSubPath(dirPath).replace(/\/+$/, "") : "";
  const target = dir ? `${rev}:${dir}/` : `${rev}:`;
  const output = await checkedStdout(inputPath, ["ls-tree", "--long", target]);
  const entries: TreeEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.length) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const fields = line.slice(0, tab).split(" ");
    const name = line.slice(tab + 1);
    entries.push({
      name,
      path: dir ? `${dir}/${name}` : name,
      type: fields[1] === "40000" ? "tree" : "blob",
      mode: fields[0] ?? "",
      size: Number.parseInt(fields[3] ?? "", 10) || null,
    });
  }
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1));
}

export interface FileAtRevision {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  binary: boolean;
}

export async function fileAtRevision(inputPath: string, revision: string, filePath: string): Promise<FileAtRevision> {
  const rev = safeRevision(revision);
  const rel = safeSubPath(filePath);
  const output = await runGitRaw(inputPath, ["show", `${rev}:${rel}`]);
  if (output.code !== 0) throw new AppError("command", `unable to read ${rel} at ${rev}: ${output.stderr.trim()}`);
  const size = output.stdout.length;
  const capped = size > MAX_FILE_BYTES;
  const head = output.stdout.subarray(0, 8000);
  const binary = head.includes(0);
  const bytes = capped ? output.stdout.subarray(0, MAX_FILE_BYTES) : output.stdout;
  return {
    path: rel,
    content: binary ? "" : bytes.toString("utf8"),
    truncated: capped,
    size,
    binary,
  };
}

// --- Export -------------------------------------------------------------------

export async function exportRevision(inputPath: string, revision: string, destination: string): Promise<CommandResult> {
  const rev = safeRevision(revision);
  const dest = destination.trim().replace(/\//g, path.sep);
  if (dest.length === 0 || dest.startsWith("-") || dest.includes("\0")) throw invalidError("invalid export destination");
  const normDest = path.resolve(dest);
  const normRepo = path.resolve(inputPath);
  if (normDest === normRepo || normDest.startsWith(normRepo + path.sep) || normRepo.startsWith(normDest + path.sep)) {
    throw invalidError("export destination must be outside the repository");
  }
  await fs.mkdir(normDest, { recursive: true });
  const archive = await runGit(inputPath, ["archive", "--format=tar", rev]);
  if (archive.code !== 0) throw new AppError("command", `git archive ${rev}: ${archive.stderr.trim()}`);
  const tarError = await new Promise<string>((resolve) => {
    const child = spawn("tar", ["-x", "-f", "-"], { cwd: normDest });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("error", (error: Error) => resolve(`tar: ${error.message}`));
    child.on("close", (code: number) => resolve(code === 0 ? "" : `tar exited ${code}: ${stderr}`));
    child.stdin.end(archive.stdout);
  });
  if (tarError) throw new AppError("command", tarError);
  const count = await countEntries(normDest);
  return { stdout: `Exported ${rev} to ${normDest} (${count} entries).`, stderr: "", exitCode: 0 };
}

async function countEntries(dir: string): Promise<number> {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0 && count < MAX_EXPORT_FILES) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      count += 1;
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  return count;
}

// --- Patches -------------------------------------------------------------------

export interface PatchExport {
  name: string;
  size: number;
  base64: string;
}

/** Create a unified-diff patch (binary-safe). With `toRef`: the range diff
 *  from→to. Without: the single revision's diff against its first parent
 *  (root commits against the empty tree). */
export async function createPatch(inputPath: string, fromRef: string, toRef: string): Promise<PatchExport> {
  const from = safeRevision(fromRef);
  const to = toRef ? safeRevision(toRef) : null;
  let patchArgs: string[];
  if (to) {
    patchArgs = ["diff", "--binary", "--no-renames", from, to];
  } else {
    const parents = (await checkedStdout(inputPath, ["rev-list", "--parents", "-n", "1", from])).trim().split(/\s+/).slice(1);
    const base = parents[0] ?? EMPTY_TREE;
    patchArgs = ["diff", "--binary", "--no-renames", base, from];
  }
  const output = await checked(inputPath, patchArgs);
  if (!output.stdout.trim()) throw new AppError("invalid", "the selected range has no diff content");
  const name = `${(to ?? from).replace(/[\\/: ]+/g, "_")}.patch`;
  return { name, size: output.stdout.length, base64: Buffer.from(output.stdout, "utf8").toString("base64") };
}

/** Create the same diff as createPatch and write it straight to a
 *  destination file (TortoiseGit "Create patch"). */
export async function savePatch(inputPath: string, fromRef: string, toRef: string, destination: string): Promise<string> {
  const { base64, name } = await createPatch(inputPath, fromRef, toRef);
  const buffer = Buffer.from(base64, "base64");
  const target = destination.trim().replace(/\\/g, path.sep);
  if (!target || target.startsWith("-") || target.includes("\0")) throw invalidError("patch destination is required");
  const lower = target.toLowerCase();
  const finalPath = lower.endsWith(".patch") || lower.endsWith(".diff") ? target : `${target}.patch`;
  await fs.mkdir(path.dirname(path.resolve(finalPath)), { recursive: true });
  await fs.writeFile(finalPath, buffer);
  return `Wrote ${buffer.length} bytes to ${finalPath} (suggested name ${name}).`;
}

export async function applyPatch(inputPath: string, data: string, destDir: string): Promise<CommandResult> {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(data, "base64");
  } catch {
    throw invalidError("patch data is not valid base64");
  }
  const dir = destDir ? destDir.trim().replace(/\\/g, path.sep) : inputPath;
  if (dir.startsWith("-") || dir.includes("\0")) throw invalidError("invalid destination directory");
  const temp = path.join(os.tmpdir(), `chrono-patch-${Date.now()}.patch`);
  await fs.writeFile(temp, buffer);
  try {
    const plain = await runGit(inputPath, ["-C", dir, "apply", "--verbose", temp]);
    if (plain.code === 0) return { stdout: plain.stdout.trim() || "Patch applied.", stderr: "", exitCode: 0 };
    const threeWay = await runGit(inputPath, ["-C", dir, "apply", "--3way", "--verbose", temp]);
    if (threeWay.code === 0) {
      return { stdout: `${threeWay.stdout.trim()}\n(3-way apply: conflicts, if any, are staged for resolution.)`, stderr: "", exitCode: 0 };
    }
    throw new AppError("command", `git apply failed: ${threeWay.stderr.trim() || plain.stderr.trim()}`);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

// --- Commit activity (heatmap source) -------------------------------------------

export interface ActivityDay {
  date: string; // YYYY-MM-DD
  count: number;
}

export async function commitActivity(inputPath: string, days: number, maxCommits = 200000): Promise<ActivityDay[]> {
  const clampedDays = Math.min(Math.max(days, 1), 1500);
  const clampedMax = Math.min(Math.max(maxCommits, 100), 1000000);
  const output = await checkedStdout(inputPath, [
    "log",
    "--all",
    "-n", String(clampedMax),
    "--date=format:%Y-%m-%d",
    "--pretty=format:%ad",
  ]);
  const counts = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    if (line.length) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const result: ActivityDay[] = [];
  const today = new Date();
  for (let offset = clampedDays - 1; offset >= 0; offset -= 1) {
    const day = new Date(today.getTime() - offset * 86400000);
    const key = day.toISOString().slice(0, 10);
    result.push({ date: key, count: counts.get(key) ?? 0 });
  }
  return result;
}

// --- Revision-to-revision diff (file history viewer) ------------------------------

export interface RevisionDiff {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: CommitDiffHunk[];
}

/** Diff a file between two explicit revisions (revision viewer prev/next). */
export async function diffRevisions(inputPath: string, fromRef: string, toRef: string, file: string): Promise<RevisionDiff> {
  const from = safeRevision(fromRef);
  const to = safeRevision(toRef);
  const rel = safeSubPath(file);
  const numstatLine = (await checkedStdout(inputPath, ["diff", "--numstat", "--", from, to, rel])).split(/\r?\n/).find((line) => line.length) ?? "";
  const [addRaw, delRaw] = numstatLine.split("\t");
  const binary = addRaw === "-" || delRaw === "-";
  const additions = binary ? 0 : Number.parseInt(addRaw, 10) || 0;
  const deletions = binary ? 0 : Number.parseInt(delRaw, 10) || 0;
  let raw = "";
  if (!binary && (additions > 0 || deletions > 0)) {
    raw = await checkedStdout(inputPath, ["diff", "--unified=3", "--", from, to, rel]);
  }
  return { path: rel, binary, additions, deletions, hunks: raw ? parseUnifiedHunks(raw) : [] };
}

// --- Branch deletion (TortoiseGit "Branch → Delete") ------------------------------

/** Delete a local branch. Without force, git refuses if the branch is not
 *  fully merged; with force, -D is used. Refuses to delete the current
 *  branch. */
export async function deleteBranch(inputPath: string, branch: string, force: boolean): Promise<string> {
  const name = branch.trim();
  if (!name || name.startsWith("-") || name.includes("\0")) throw invalidError("invalid branch name");
  const current = (await runGit(inputPath, ["branch", "--show-current"])).stdout.trim();
  if (current === name) {
    throw new AppError("invalid", `cannot delete the current branch “${name}” — switch first`);
  }
  const args = ["branch", force ? "-D" : "-d", name];
  try {
    const result = await checked(inputPath, args);
    return `Deleted branch ${name}. ${result.stdout.trim()}`.trim();
  } catch (error) {
    if (!force) {
      // Surface the not-fully-merged hint and let the UI offer -f.
      throw new AppError("command", `${String(error)} (branch not fully merged — use force delete if intended)`);
    }
    throw error;
  }
}

// Three-way Conflict Center: index stages 1/2/3 inspection and resolution.
//
// Ported from `src-tauri/src/conflict_center.rs` (desktop module).

import fs from "node:fs/promises";
import path from "node:path";
import { AppError, invalidError } from "./lib/errors.ts";
import { checkedStdout, runGitRaw } from "./lib/git.ts";
import { repositoryOperationState } from "./operationState.ts";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

interface StageEntry {
  mode: string;
  oid: string;
}

interface ConflictEntries {
  base?: StageEntry;
  current?: StageEntry;
  incoming?: StageEntry;
}

export interface ConflictStage {
  oid: string;
  mode: string;
  kind: "blob" | "symlink" | "gitlink";
  text: string | null;
  binary: boolean;
  truncated: boolean;
  size: number;
}

export interface ConflictLabels {
  base: string;
  current: string;
  incoming: string;
}

export interface ConflictFileSummary {
  path: string;
  kind: ConflictKind;
  hasBase: boolean;
  hasCurrent: boolean;
  hasIncoming: boolean;
  binary: boolean;
  special: boolean;
  tooLarge: boolean;
}

export interface ConflictFileDetail {
  path: string;
  kind: ConflictKind;
  labels: ConflictLabels;
  base: ConflictStage | null;
  current: ConflictStage | null;
  incoming: ConflictStage | null;
  workingText: string | null;
  workingBinary: boolean;
  workingTruncated: boolean;
  workingSize: number;
}

export type ConflictKind =
  | "content"
  | "addAdd"
  | "currentDeleted"
  | "incomingDeleted"
  | "bothDeleted"
  | "complex";

export interface ConflictResolutionRequest {
  file: string;
  strategy: "current" | "incoming" | "merged" | "working" | "delete";
  content?: string | null;
}

export interface ConflictResolutionResult {
  remaining: number;
  nextPath: string | null;
}

type ConflictMap = Map<string, ConflictEntries>;

async function parseConflicts(inputPath: string): Promise<ConflictMap> {
  const output = await runGitRaw(inputPath, ["ls-files", "--unmerged", "-z", "--"]);
  if (output.code !== 0) {
    throw new AppError("command", `git ls-files --unmerged: ${output.stderr.trim()}`);
  }
  const conflicts: ConflictMap = new Map();
  for (const record of output.stdout.toString("utf8").split("\0")) {
    if (!record.length) continue;
    const text = record;
    const tab = text.indexOf("\t");
    if (tab < 0) continue;
    const header = text.slice(0, tab);
    const relative = text.slice(tab + 1);
    const fields = header.split(/\s+/).filter((value) => value.length > 0);
    if (fields.length < 3) continue;
    const [mode, oid] = fields;
    const stage = Number.parseInt(fields[2], 10);
    const entry: StageEntry = { mode, oid };
    let entries = conflicts.get(relative);
    if (!entries) {
      entries = {};
      conflicts.set(relative, entries);
    }
    if (stage === 1) entries.base = entry;
    else if (stage === 2) entries.current = entry;
    else if (stage === 3) entries.incoming = entry;
  }
  return conflicts;
}

// Mirrors Rust `path_is_safe`: no absolute path, no `.`/`..` components.
function pathIsSafe(relative: string): boolean {
  if (path.isAbsolute(relative)) return false;
  return relative.split(/[\\/]/).every((part) => part !== "." && part !== "..");
}

function stageKind(mode: string): ConflictStage["kind"] {
  if (mode === "160000") return "gitlink";
  if (mode === "120000") return "symlink";
  return "blob";
}

async function blobSize(inputPath: string, oid: string): Promise<number> {
  const output = await runGitRaw(inputPath, ["cat-file", "-s", oid]);
  if (output.code !== 0) {
    throw new (await import("./lib/errors")).AppError(
      "command",
      `git cat-file -s ${oid}: ${output.stderr.trim()}`,
    );
  }
  const size = Number.parseInt(output.stdout.toString("utf8").trim(), 10);
  if (!Number.isFinite(size)) {
    throw new AppError("invalid", `invalid blob size for ${oid}`);
  }
  return size;
}

function isBinaryBuffer(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true;
  try {
    // Round-trip check equivalent to Rust `str::from_utf8`.
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

async function stageDetail(inputPath: string, entry: StageEntry): Promise<ConflictStage> {
  const kind = stageKind(entry.mode);
  if (kind === "gitlink") {
    return { oid: entry.oid, mode: entry.mode, kind, text: null, binary: false, truncated: false, size: 0 };
  }
  const size = await blobSize(inputPath, entry.oid);
  if (size > MAX_TEXT_BYTES) {
    return { oid: entry.oid, mode: entry.mode, kind, text: null, binary: false, truncated: true, size };
  }
  const output = await runGitRaw(inputPath, ["cat-file", "blob", entry.oid]);
  if (output.code !== 0) {
    throw new AppError("command", `git cat-file blob ${entry.oid}: ${output.stderr.trim()}`);
  }
  const binary = isBinaryBuffer(output.stdout);
  const text = binary ? null : output.stdout.toString("utf8");
  return { oid: entry.oid, mode: entry.mode, kind, text, binary, truncated: false, size };
}

function conflictKind(entries: ConflictEntries): ConflictKind {
  const b = entries.base !== undefined;
  const c = entries.current !== undefined;
  const i = entries.incoming !== undefined;
  if (!b && c && i) return "addAdd";
  if (b && !c && i) return "currentDeleted";
  if (b && c && !i) return "incomingDeleted";
  if (b && c && i) return "content";
  if (b && !c && !i) return "bothDeleted";
  return "complex";
}

async function labels(inputPath: string): Promise<ConflictLabels> {
  const operation = (await repositoryOperationState(inputPath).catch(() => null))?.operation ?? null;
  const [current, incoming] =
    operation === "rebase"
      ? ["Current base", "Replayed commit"]
      : operation === "cherryPick"
        ? ["Current branch", "Cherry-picked commit"]
        : operation === "revert"
          ? ["Current branch", "Revert result"]
          : operation === "merge"
            ? ["Current branch", "Incoming branch"]
            : ["Current version", "Incoming version"];
  return { base: "Base", current, incoming };
}

// Mirrors Rust `safe_working_target`: canonicalize an existing ancestor and
// verify the target cannot escape the repository root through symlink parents.
async function safeWorkingTarget(root: string, relative: string): Promise<string> {
  const canonicalRoot = await fs.realpath(root);
  const target = path.join(root, relative);
  let ancestor = path.dirname(target);
  while (true) {
    try {
      await fs.lstat(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw invalidError("conflict path has no existing repository ancestor");
      }
      ancestor = parent;
    }
  }
  const canonicalAncestor = await fs.realpath(ancestor);
  if (
    canonicalAncestor !== canonicalRoot &&
    !canonicalAncestor.startsWith(canonicalRoot + path.sep)
  ) {
    throw invalidError("conflict path escapes the repository through a symbolic-link parent");
  }
  return target;
}

async function readWorking(
  root: string,
  relative: string,
): Promise<{ text: string | null; binary: boolean; truncated: boolean; size: number }> {
  const file = await safeWorkingTarget(root, relative);
  let metadata: import("node:fs").Stats;
  try {
    metadata = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: null, binary: false, truncated: false, size: 0 };
    }
    throw error;
  }
  if (metadata.isSymbolicLink()) return { text: null, binary: false, truncated: false, size: 0 };
  if (!metadata.isFile()) return { text: null, binary: true, truncated: false, size: metadata.size };
  const size = metadata.size;
  if (size > MAX_TEXT_BYTES) return { text: null, binary: false, truncated: true, size };
  const bytes = await fs.readFile(file);
  const binary = isBinaryBuffer(bytes);
  return { text: binary ? null : bytes.toString("utf8"), binary, truncated: false, size };
}

async function summarize(
  inputPath: string,
  relative: string,
  entries: ConflictEntries,
): Promise<ConflictFileSummary> {
  let special = false;
  let tooLarge = false;
  for (const entry of [entries.base, entries.current, entries.incoming]) {
    if (!entry) continue;
    const kind = stageKind(entry.mode);
    special = special || kind !== "blob";
    if (kind !== "gitlink") {
      tooLarge = tooLarge || (await blobSize(inputPath, entry.oid)) > MAX_TEXT_BYTES;
    }
  }
  return {
    path: relative,
    kind: conflictKind(entries),
    hasBase: entries.base !== undefined,
    hasCurrent: entries.current !== undefined,
    hasIncoming: entries.incoming !== undefined,
    binary: false,
    special,
    tooLarge,
  };
}

export async function repositoryConflicts(inputPath: string): Promise<ConflictFileSummary[]> {
  const conflicts = await parseConflicts(inputPath);
  const result: ConflictFileSummary[] = [];
  for (const [relative, entries] of conflicts) {
    result.push(await summarize(inputPath, relative, entries));
  }
  return result;
}

export async function conflictDetail(inputPath: string, relative: string): Promise<ConflictFileDetail> {
  if (!pathIsSafe(relative)) {
    throw invalidError("conflict path is not a safe repository-relative path");
  }
  const conflicts = await parseConflicts(inputPath);
  const entries = conflicts.get(relative);
  if (!entries) throw invalidError(`${relative} is not currently conflicted`);
  const root = await repositoryRootFor(inputPath);
  const working = await readWorking(root, relative);
  const [base, current, incoming] = await Promise.all([
    entries.base ? stageDetail(inputPath, entries.base) : Promise.resolve(null),
    entries.current ? stageDetail(inputPath, entries.current) : Promise.resolve(null),
    entries.incoming ? stageDetail(inputPath, entries.incoming) : Promise.resolve(null),
  ]);
  return {
    path: relative,
    kind: conflictKind(entries),
    labels: await labels(inputPath),
    base,
    current,
    incoming,
    workingText: working.text,
    workingBinary: working.binary,
    workingTruncated: working.truncated,
    workingSize: working.size,
  };
}

async function repositoryRootFor(inputPath: string): Promise<string> {
  return (await checkedStdout(inputPath, ["rev-parse", "--show-toplevel"])).trim();
}

function selectedStage(entries: ConflictEntries, strategy: string): StageEntry | null {
  if (strategy === "current") return entries.current ?? null;
  if (strategy === "incoming") return entries.incoming ?? null;
  return null;
}

async function removeWorkingPath(root: string, relative: string): Promise<void> {
  const target = await safeWorkingTarget(root, relative);
  let metadata: import("node:fs").Stats;
  try {
    metadata = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    throw invalidError("refusing to recursively remove a directory while resolving a file conflict");
  }
  await fs.rm(target);
}

async function stageDeletion(
  inputPath: string,
  root: string,
  relative: string,
  gitlink: boolean,
): Promise<void> {
  if (gitlink) {
    await checkedStdout(inputPath, ["update-index", "--force-remove", "--", relative]);
    return;
  }
  await removeWorkingPath(root, relative);
  await checkedStdout(inputPath, ["add", "-A", "--", relative]);
}

async function resolveSide(
  inputPath: string,
  root: string,
  relative: string,
  entries: ConflictEntries,
  strategy: string,
): Promise<void> {
  const stage = selectedStage(entries, strategy);
  if (!stage) {
    const gitlink = [entries.base, entries.current, entries.incoming].some(
      (entry) => entry && stageKind(entry.mode) === "gitlink",
    );
    await stageDeletion(inputPath, root, relative, gitlink);
    return;
  }
  if (stageKind(stage.mode) === "gitlink") {
    await checkedStdout(inputPath, ["update-index", "--add", "--cacheinfo", stage.mode, stage.oid, relative]);
    return;
  }
  const stageNumber = strategy === "current" ? "2" : "3";
  await checkedStdout(inputPath, ["checkout-index", `--stage=${stageNumber}`, "--force", "--", relative]);
  await checkedStdout(inputPath, ["add", "-A", "--", relative]);
}

async function applyExecutableMode(target: string, entries: ConflictEntries): Promise<void> {
  if (process.platform === "win32") return;
  const executable = [entries.current, entries.incoming, entries.base].some(
    (entry) => entry && entry.mode === "100755",
  );
  if (!executable) return;
  try {
    const permissions = await fs.stat(target);
    if (!permissions.isFile()) return;
    await fs.chmod(target, 0o755);
  } catch {
    // best-effort, matching Rust's ignore-on-error behavior
  }
}

async function resolveMerged(
  inputPath: string,
  root: string,
  relative: string,
  entries: ConflictEntries,
  content: string,
): Promise<void> {
  const special = [entries.base, entries.current, entries.incoming].some(
    (entry) => entry && stageKind(entry.mode) !== "blob",
  );
  if (special) {
    throw invalidError(
      "manual text editing is disabled for symlink and submodule conflicts; choose a side instead",
    );
  }
  const target = await safeWorkingTarget(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    const metadata = await fs.lstat(target);
    if (metadata.isSymbolicLink()) await fs.rm(target);
  } catch {
    // missing file: nothing to replace
  }
  await fs.writeFile(target, content);
  await applyExecutableMode(target, entries);
  await checkedStdout(inputPath, ["add", "-A", "--", relative]);
}

export async function resolveConflict(
  inputPath: string,
  request: ConflictResolutionRequest,
): Promise<ConflictResolutionResult> {
  if (!pathIsSafe(request.file)) {
    throw invalidError("conflict path is not a safe repository-relative path");
  }
  const conflicts = await parseConflicts(inputPath);
  const entries = conflicts.get(request.file);
  if (!entries) throw invalidError(`${request.file} is not currently conflicted`);
  const root = await repositoryRootFor(inputPath);

  switch (request.strategy) {
    case "current":
    case "incoming":
      await resolveSide(inputPath, root, request.file, entries, request.strategy);
      break;
    case "merged": {
      const content = request.content;
      if (content === undefined || content === null) {
        throw invalidError("merged resolution requires content");
      }
      await resolveMerged(inputPath, root, request.file, entries, content);
      break;
    }
    case "working":
      await checkedStdout(inputPath, ["add", "-A", "--", request.file]);
      break;
    case "delete": {
      const gitlink = [entries.base, entries.current, entries.incoming].some(
        (entry) => entry && stageKind(entry.mode) === "gitlink",
      );
      await stageDeletion(inputPath, root, request.file, gitlink);
      break;
    }
    default:
      throw invalidError(`unknown conflict resolution strategy: ${request.strategy}`);
  }

  const remaining = await parseConflicts(inputPath);
  const keys = [...remaining.keys()].sort();
  const nextPath =
    keys.find((candidate) => candidate > request.file) ?? keys[0] ?? null;
  return { remaining: keys.length, nextPath };
}

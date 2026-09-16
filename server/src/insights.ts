// Git Intelligence workbench: search, compare, file/line history, blame,
// contributors and worktree summaries.
//
// Ported from `src-tauri/src/insights.rs` (desktop module).

import { AppError, invalidError } from "./lib/errors.ts";
import {
  checkedStdout,
  COMMIT_FORMAT,
  parseCommits,
  parseNumstat,
  type CommitRecord,
} from "./lib/git.ts";

export interface CommitFileChange {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface CommitDetails {
  id: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  body: string;
  additions: number;
  deletions: number;
  files: CommitFileChange[];
}

export interface HistoryChangeStat {
  commit: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  binaryFiles: number;
}

export interface CommitSearchResult {
  query: string;
  commits: CommitRecord[];
}

export interface RefComparison {
  left: string;
  right: string;
  leftId: string;
  rightId: string;
  mergeBase: string;
  leftOnlyCount: number;
  rightOnlyCount: number;
  leftOnly: CommitRecord[];
  rightOnly: CommitRecord[];
  filesFromBaseToLeft: CommitFileChange[];
  filesFromBaseToRight: CommitFileChange[];
}

export interface FileHistoryRequest {
  file: string;
  followRenames: boolean;
  allRefs: boolean;
  limit: number;
}

export interface BlameLine {
  lineNumber: number;
  commit: string;
  author: string;
  authorEmail: string;
  authoredAt: number;
  summary: string;
  content: string;
}

export interface BlameResult {
  file: string;
  lines: BlameLine[];
  truncated: boolean;
}

export interface ContributorRecord {
  name: string;
  email: string;
  commits: number;
  firstCommit: string;
  lastCommit: string;
}

export interface WorktreeSummary {
  path: string;
  head: string;
  branch: string | null;
  isMain: boolean;
  locked: string | null;
  prunable: string | null;
  dirtyCount: number;
  conflictCount: number;
}

// Port of Rust `tokenize`: whitespace-split with single/double quotes and
// backslash escapes.
function tokenize(input: string): string[] {
  const output: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (/\s/.test(ch)) {
      if (current.length > 0) output.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0) output.push(current);
  return output;
}

function safeRevision(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-") || trimmed.includes("\0")) {
    throw invalidError("invalid revision or range");
  }
  return trimmed;
}

async function currentIdentity(inputPath: string): Promise<string> {
  const name = (await checkedStdout(inputPath, ["config", "user.name"]).catch(() => "")).trim();
  const email = (await checkedStdout(inputPath, ["config", "user.email"]).catch(() => "")).trim();
  return email.length > 0 ? email : name;
}

export async function searchCommits(
  inputPath: string,
  request: { query: string; limit: number },
): Promise<CommitSearchResult> {
  const messages: string[] = [];
  const authors: string[] = [];
  const files: string[] = [];
  const changes: string[] = [];
  let revision: string | null = null;
  let commitExact: string | null = null;

  for (const token of tokenize(request.query)) {
    const separator = token.indexOf(":");
    if (separator < 0) {
      if (token === "@me") {
        const identity = await currentIdentity(inputPath);
        if (identity.length > 0) authors.push(identity);
      } else {
        messages.push(token);
      }
      continue;
    }
    const prefix = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1);
    if (value.trim().length === 0) continue;
    switch (prefix) {
      case "message":
      case "msg":
        messages.push(value);
        break;
      case "author":
        authors.push(value);
        break;
      case "file":
        files.push(value);
        break;
      case "change":
      case "patch":
        changes.push(value);
        break;
      case "ref":
      case "range":
        revision = safeRevision(value);
        break;
      case "commit":
      case "sha":
        commitExact = safeRevision(value);
        break;
      default:
        messages.push(token);
    }
  }

  const limit = Math.min(Math.max(request.limit, 1), 1000);
  const args = ["log", "--date=iso-strict", `--pretty=format:${COMMIT_FORMAT}`, "-n", String(limit)];
  if (commitExact !== null) {
    args.push(commitExact, "--no-walk");
  } else {
    args.push(revision ?? "--all");
  }
  if (messages.length > 1) args.push("--all-match");
  for (const value of messages) args.push(`--grep=${value}`);
  for (const value of authors) args.push(`--author=${value}`);
  for (const value of changes) args.push(`-G${value}`);
  if (files.length > 0) args.push("--", ...files);

  const output = await checkedStdout(inputPath, args);
  return { query: request.query, commits: parseCommits(output) };
}

export async function commitDetails(inputPath: string, commit: string): Promise<CommitDetails> {
  const revision = safeRevision(commit);
  const metadata = (
    await checkedStdout(inputPath, [
      "show",
      "-s",
      "--date=iso-strict",
      "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%B",
      revision,
    ])
  ).trim();
  const fields = metadata.split("\u001f");
  if (fields.length !== 7) throw new AppError("command", "unable to parse commit details");
  const files = parseNumstat(
    await checkedStdout(inputPath, ["show", "--numstat", "--format=", "--find-renames", revision]),
  );
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return {
    id: fields[0],
    parents: fields[1].split(/\s+/).filter((value) => value.length > 0),
    authorName: fields[2],
    authorEmail: fields[3],
    authoredAt: fields[4],
    subject: fields[5],
    body: fields[6].trim(),
    additions,
    deletions,
    files: files.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
    })),
  };
}

export interface CommitDiffLine {
  kind: "add" | "del" | "ctx";
  number: number | null;
  text: string;
}

export interface CommitDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: CommitDiffLine[];
}

export interface CommitFileDiff {
  path: string;
  status: string;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: CommitDiffHunk[];
}

const MAX_DIFF_LINES = 4000;

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Per-file diff of one commit against its first parent (root commits diff
 *  against the empty tree). Binary files and oversized diffs report counts
 *  only, with empty hunks. */
export async function commitFileDiff(inputPath: string, commit: string, filePath: string): Promise<CommitFileDiff> {
  const revision = safeRevision(commit);
  const file = filePath.trim();
  if (file.length === 0 || file.startsWith("-") || file.includes("\0")) {
    throw invalidError("invalid file path");
  }

  // First parent is the base; a root commit diffs against the empty tree.
  const parentsField = (await checkedStdout(inputPath, ["show", "-s", "--format=%P", revision])).trim();
  const parents = parentsField.split(/\s+/).filter((value) => value.length > 0);
  const base = parents[0] ?? EMPTY_TREE;
  const diffBase = ["--no-renames", base, revision, "--", file];

  // Counts + binary flag.
  const numstatLine = (await checkedStdout(inputPath, ["diff", "--numstat", ...diffBase])).split(/\r?\n/).find((line) => line.length) ?? "";
  const [addRaw, delRaw] = numstatLine.split("\t");
  const binary = addRaw === "-" || delRaw === "-";
  const additions = binary ? 0 : Number.parseInt(addRaw, 10) || 0;
  const deletions = binary ? 0 : Number.parseInt(delRaw, 10) || 0;

  // Status letter (A/M/D/T). Falls back to "modified" if git reports nothing
  // (e.g. a rename recorded under a combined "old => new" path in the list).
  const statusLine = (await checkedStdout(inputPath, ["diff", "--name-status", ...diffBase])).split(/\r?\n/).find((line) => line.length)?.trim() ?? "";
  const letter = statusLine.charAt(0).toUpperCase();
  const status = letter === "A" ? "added" : letter === "D" ? "deleted" : letter === "T" ? "typechange" : "modified";

  if (binary || additions === 0 && deletions === 0) {
    return { path: file, status, binary, additions, deletions, hunks: [] };
  }

  const raw = await checkedStdout(inputPath, ["diff", "--unified=3", ...diffBase]);
  const hunks = parseUnifiedHunks(raw);
  return { path: file, status, binary: false, additions, deletions, hunks };
}

export function parseUnifiedHunks(raw: string): CommitDiffHunk[] {
  const hunks: CommitDiffHunk[] = [];
  let current: CommitDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let counted = 0;
  for (const line of raw.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s*(.*)$/.exec(line);
    if (header) {
      current = {
        oldStart: Number.parseInt(header[1], 10),
        oldLines: header[2] === undefined ? 1 : Number.parseInt(header[2], 10),
        newStart: Number.parseInt(header[3], 10),
        newLines: header[4] === undefined ? 1 : Number.parseInt(header[4], 10),
        header: header[5] || "",
        lines: [],
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) continue; // file headers / index / mode lines
    if (counted >= MAX_DIFF_LINES) continue;
    if (line.startsWith("+")) {
      current.lines.push({ kind: "add", number: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "del", number: oldLine, text: line.slice(1) });
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      current.lines.push({ kind: "ctx", number: null, text: line.slice(1) }); // "\ No newline at end of file"
    } else {
      current.lines.push({ kind: "ctx", number: oldLine, text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
    counted += 1;
  }
  return hunks;
}

export async function historyChangeStats(inputPath: string, limit: number): Promise<HistoryChangeStat[]> {
  const clamped = Math.min(Math.max(limit, 1), 1000);
  const output = await checkedStdout(inputPath, [
    "log",
    "-n",
    String(clamped),
    "--format=@@%H",
    "--numstat",
    "--no-renames",
  ]);
  const result: HistoryChangeStat[] = [];
  let current: HistoryChangeStat | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      if (current) result.push(current);
      current = {
        commit: line.slice(2).trim(),
        additions: 0,
        deletions: 0,
        filesChanged: 0,
        binaryFiles: 0,
      };
      continue;
    }
    if (!current) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [add, del] = parts;
    current.filesChanged += 1;
    if (add === "-" || del === "-") current.binaryFiles += 1;
    if (add !== "-") current.additions += Number.parseInt(add, 10) || 0;
    if (del !== "-") current.deletions += Number.parseInt(del, 10) || 0;
  }
  if (current) result.push(current);
  return result;
}

async function commitsForRange(inputPath: string, range: string, limit: number): Promise<CommitRecord[]> {
  const output = await checkedStdout(inputPath, [
    "log",
    "--date=iso-strict",
    `--pretty=format:${COMMIT_FORMAT}`,
    "-n",
    String(Math.min(Math.max(limit, 1), 500)),
    range,
  ]);
  return parseCommits(output);
}

async function diffNumstat(inputPath: string, from: string, to: string): Promise<CommitFileChange[]> {
  const range = `${from}..${to}`;
  return (
    await parseNumstat(await checkedStdout(inputPath, ["diff", "--numstat", "--find-renames", range]))
  ).map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions, binary: file.binary }));
}

export async function compareRefs(
  inputPath: string,
  left: string,
  right: string,
  limit: number,
): Promise<RefComparison> {
  const safeLeft = safeRevision(left);
  const safeRight = safeRevision(right);
  const leftId = (await checkedStdout(inputPath, ["rev-parse", "--verify", `${safeLeft}^{commit}`])).trim();
  const rightId = (await checkedStdout(inputPath, ["rev-parse", "--verify", `${safeRight}^{commit}`])).trim();
  const mergeBase = (await checkedStdout(inputPath, ["merge-base", leftId, rightId])).trim();
  const counts = (await checkedStdout(inputPath, ["rev-list", "--left-right", "--count", `${leftId}...${rightId}`])).trim();
  const [leftOnlyCount = "0", rightOnlyCount = "0"] = counts.split(/\s+/);
  const [leftOnly, rightOnly] = await Promise.all([
    commitsForRange(inputPath, `${rightId}..${leftId}`, limit),
    commitsForRange(inputPath, `${leftId}..${rightId}`, limit),
  ]);
  const [filesFromBaseToLeft, filesFromBaseToRight] = await Promise.all([
    diffNumstat(inputPath, mergeBase, leftId),
    diffNumstat(inputPath, mergeBase, rightId),
  ]);
  return {
    left: safeLeft,
    right: safeRight,
    leftId,
    rightId,
    mergeBase,
    leftOnlyCount: Number.parseInt(leftOnlyCount, 10) || 0,
    rightOnlyCount: Number.parseInt(rightOnlyCount, 10) || 0,
    leftOnly,
    rightOnly,
    filesFromBaseToLeft,
    filesFromBaseToRight,
  };
}

export async function fileHistory(inputPath: string, request: FileHistoryRequest): Promise<CommitRecord[]> {
  const file = request.file.trim();
  if (file.length === 0) throw invalidError("file path is required");
  const args = [
    "log",
    "--date=iso-strict",
    `--pretty=format:${COMMIT_FORMAT}`,
    "-n",
    String(Math.min(Math.max(request.limit, 1), 1000)),
  ];
  if (request.allRefs) args.push("--all");
  if (request.followRenames) args.push("--follow");
  args.push("--", file);
  return parseCommits(await checkedStdout(inputPath, args));
}

export async function lineHistory(
  inputPath: string,
  file: string,
  start: number,
  end: number,
  limit: number,
): Promise<CommitRecord[]> {
  const trimmedFile = file.trim();
  if (trimmedFile.length === 0 || start === 0 || end < start) {
    throw invalidError("valid file and 1-based line range are required");
  }
  const range = `${start},${end}:${trimmedFile}`;
  const args = [
    "log",
    "-L",
    range,
    "--date=iso-strict",
    `--format=${COMMIT_FORMAT}`,
    "--no-patch",
    "-n",
    String(Math.min(Math.max(limit, 1), 500)),
  ];
  return parseCommits(await checkedStdout(inputPath, args));
}

export async function blameFile(
  inputPath: string,
  file: string,
  revision: string | null,
  ignoreWhitespace: boolean,
  limit: number,
): Promise<BlameResult> {
  const trimmedFile = file.trim();
  if (trimmedFile.length === 0) throw invalidError("file path is required");
  const args = ["blame", "--line-porcelain"];
  if (ignoreWhitespace) args.push("-w");
  const trimmedRevision = revision?.trim();
  if (trimmedRevision) args.push(safeRevision(trimmedRevision));
  args.push("--", trimmedFile);
  const output = await checkedStdout(inputPath, args);

  const lines: BlameLine[] = [];
  const rawLines = output.split(/\r?\n/);
  let index = 0;
  while (index < rawLines.length) {
    const header = rawLines[index];
    index += 1;
    const head = header.split(/\s+/).filter((value) => value.length > 0);
    const commit = head[0];
    if (!commit || commit.length < 8) continue;
    const finalLine = Number.parseInt(head[2], 10) || lines.length + 1;
    let author = "";
    let authorEmail = "";
    let authoredAt = 0;
    let summary = "";
    let content = "";
    while (index < rawLines.length) {
      const next = rawLines[index];
      index += 1;
      if (next.startsWith("author ")) author = next.slice("author ".length);
      else if (next.startsWith("author-mail ")) {
        authorEmail = next.slice("author-mail ".length).replace(/^[<>]/, "").replace(/>$/, "");
      } else if (next.startsWith("author-time ")) authoredAt = Number.parseInt(next.slice("author-time ".length), 10) || 0;
      else if (next.startsWith("summary ")) summary = next.slice("summary ".length);
      else if (next.startsWith("\t")) {
        content = next.slice(1);
        break;
      }
    }
    lines.push({ lineNumber: finalLine, commit, author, authorEmail, authoredAt, summary, content });
    if (lines.length > limit) break;
  }
  const truncated = lines.length > limit;
  if (truncated) lines.length = limit;
  return { file: trimmedFile, lines, truncated };
}

interface ContributorAcc {
  name: string;
  email: string;
  commits: number;
  first: string;
  last: string;
}

export async function contributors(inputPath: string, maxCommits: number): Promise<ContributorRecord[]> {
  const clamped = Math.min(Math.max(maxCommits, 1), 100_000);
  const output = await checkedStdout(inputPath, [
    "log",
    "--all",
    `-n${clamped}`,
    "--date=iso-strict",
    "--format=%an%x1f%ae%x1f%aI%x1e",
  ]);
  const map = new Map<string, ContributorAcc>();
  for (const record of output.split("\u001e")) {
    const fields = record.trim().split("\u001f");
    if (fields.length !== 3) continue;
    const key = (fields[1].length > 0 ? fields[1] : fields[0]).toLowerCase();
    let entry = map.get(key);
    if (!entry) {
      entry = { name: fields[0], email: fields[1], commits: 0, first: "", last: "" };
      map.set(key, entry);
    }
    entry.name = fields[0];
    entry.email = fields[1];
    entry.commits += 1;
    const date = fields[2];
    if (entry.last.length === 0 || date > entry.last) entry.last = date;
    if (entry.first.length === 0 || date < entry.first) entry.first = date;
  }
  const records = [...map.values()].map((entry) => ({
    name: entry.name,
    email: entry.email,
    commits: entry.commits,
    firstCommit: entry.first,
    lastCommit: entry.last,
  }));
  records.sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
  return records;
}

function isConflictCode(code: string): boolean {
  return (
    code === "DD" ||
    code === "AU" ||
    code === "UD" ||
    code === "UA" ||
    code === "DU" ||
    code === "AA" ||
    code === "UU" ||
    code.includes("U")
  );
}

export async function worktreeSummaries(inputPath: string): Promise<WorktreeSummary[]> {
  const output = await checkedStdout(inputPath, ["worktree", "list", "--porcelain"]);
  const blocks = output.split(/\n\s*\n/).filter((block) => block.trim().length > 0);
  const parsed = blocks.map((block) => {
    let worktreePath = "";
    let head = "";
    let branch: string | null = null;
    let locked: string | null = null;
    let prunable: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(" ");
      const key = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1);
      if (key === "worktree") worktreePath = value;
      else if (key === "HEAD") head = value;
      else if (key === "branch") branch = value.replace(/^refs\/heads\//, "");
      else if (key === "detached") branch = null;
      else if (key === "locked") locked = value.length === 0 ? "Locked" : value;
      else if (key === "prunable") prunable = value.length === 0 ? "Prunable" : value;
    }
    return { worktreePath, head, branch, locked, prunable };
  });
  // Count dirty files per worktree concurrently — serial `git status` calls
  // make this O(worktrees * status-cost), which is ~10s on repos with many
  // worktrees.
  const statuses = await Promise.all(
    parsed.map((worktree) =>
      worktree.worktreePath
        ? checkedStdout(worktree.worktreePath, ["status", "--porcelain=v1"]).catch(() => "")
        : Promise.resolve(""),
    ),
  );
  return parsed
    .map((worktree, index) => {
      if (!worktree.worktreePath) return null;
      const entries = statuses[index].split(/\r?\n/).filter((entry) => entry.length > 0);
      const conflictCount = entries.filter((entry) => entry.length >= 2 && isConflictCode(entry.slice(0, 2))).length;
      return {
        path: worktree.worktreePath,
        head: worktree.head,
        branch: worktree.branch,
        isMain: index === 0,
        locked: worktree.locked,
        prunable: worktree.prunable,
        dirtyCount: entries.length,
        conflictCount,
      };
    })
    .filter((entry): entry is WorktreeSummary => entry !== null);
}

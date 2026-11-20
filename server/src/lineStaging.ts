// Line-level staging (Sublime Merge / lazygit / GitKraken style).
//
// The client shows a file's unstaged (index → worktree) or staged
// (HEAD → index) diff, parsed with `parseUnifiedHunks`, and selects lines by
// (hunk index, line index). We rebuild a patch that contains only the
// selected changes and hand it to `git apply --recount`:
//
//   stage    unstaged diff, forward onto the index        (--cached)
//   unstage  staged diff,   reverse onto the index        (--cached -R)
//   discard  unstaged diff, reverse onto the working tree (-R)
//
// Forward patches turn unselected "-" lines into context and drop unselected
// "+" lines; reverse patches do the opposite, so in both cases only the
// selected lines change.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError, invalidError } from "./lib/errors.ts";
import { checked, checkedStdout, repositoryRoot, runGit, type CommandResult } from "./lib/git.ts";
import { parseUnifiedHunks, type CommitDiffHunk } from "./insights.ts";

export type DiffSide = "unstaged" | "staged";
export type LineMode = "stage" | "unstage" | "discard";

export interface SideDiff {
  path: string;
  side: DiffSide;
  binary: boolean;
  untracked: boolean;
  additions: number;
  deletions: number;
  /** hunk headers joined — sent back to detect a diff that changed meanwhile */
  fingerprint: string;
  hunks: CommitDiffHunk[];
}

export interface LineSelection { hunk: number; lines: number[] }

function safeFile(value: string): string {
  const rel = value.replace(/\\/g, "/").trim();
  if (!rel || rel.startsWith("/") || rel.startsWith("-") || rel.includes("\0") || /(^|\/)\.\.(\/|$)/.test(rel)) throw invalidError("invalid file path");
  return rel;
}

async function isUntracked(root: string, rel: string): Promise<boolean> {
  const out = await runGit(root, ["ls-files", "--error-unmatch", "--", rel]);
  return out.code !== 0;
}

async function rawDiff(root: string, rel: string, side: DiffSide): Promise<string> {
  const args = side === "staged"
    ? ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3", "--", rel]
    : ["diff", "--no-ext-diff", "--no-color", "--unified=3", "--", rel];
  return checkedStdout(root, args);
}

function splitDiff(raw: string): { header: string[]; hunks: string[][] } {
  const lines = raw.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const header: string[] = [];
  const hunks: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("@@ ")) { hunks.push([line]); continue; }
    if (!hunks.length) header.push(line);
    else hunks[hunks.length - 1].push(line);
  }
  return { header, hunks };
}

const fingerprintOf = (hunks: string[][]) => hunks.map((hunk) => hunk[0]).join("\n");

export async function sideDiff(inputPath: string, file: string, side: DiffSide): Promise<SideDiff> {
  const root = await repositoryRoot(inputPath);
  const rel = safeFile(file);
  const untracked = side === "unstaged" && await isUntracked(root, rel);
  let raw: string;
  if (untracked) {
    // Untracked files have no index entry; show them as all-new lines.
    const out = await runGit(root, ["diff", "--no-index", "--no-color", "--unified=3", "--", "/dev/null", rel]);
    raw = out.stdout;
  } else {
    raw = await rawDiff(root, rel, side);
  }
  const binary = /^Binary files /m.test(raw);
  const { hunks } = splitDiff(raw);
  const parsed = binary ? [] : parseUnifiedHunks(raw);
  let additions = 0;
  let deletions = 0;
  for (const hunk of parsed) for (const line of hunk.lines) { if (line.kind === "add") additions += 1; else if (line.kind === "del") deletions += 1; }
  return { path: rel, side, binary, untracked, additions, deletions, fingerprint: fingerprintOf(hunks), hunks: parsed };
}

/** Build the patch text for the selected lines (exported for tests). */
export function buildLinePatch(raw: string, selection: LineSelection[], reverse: boolean): string | null {
  const { header, hunks } = splitDiff(raw);
  const chosen = new Map<number, Set<number>>();
  for (const item of selection) {
    if (!Number.isSafeInteger(item.hunk) || item.hunk < 0 || item.hunk >= hunks.length) throw invalidError("selected hunk is outside the current diff");
    const set = chosen.get(item.hunk) ?? new Set<number>();
    for (const index of item.lines) if (Number.isSafeInteger(index) && index >= 0) set.add(index);
    chosen.set(item.hunk, set);
  }
  const out: string[] = [...header];
  let changed = false;
  for (const [hunkIndex, selected] of [...chosen.entries()].sort((a, b) => a[0] - b[0])) {
    const [hunkHeader, ...body] = hunks[hunkIndex];
    const lines: string[] = [hunkHeader];
    let hunkChanges = 0;
    let lastKept = true;
    body.forEach((line, index) => {
      const mark = line[0];
      if (mark === "\\") { if (lastKept) lines.push(line); return; }
      if (mark === "+" || mark === "-") {
        if (selected.has(index)) { lines.push(line); hunkChanges += 1; lastKept = true; return; }
        const becomesContext = (mark === "-" && !reverse) || (mark === "+" && reverse);
        if (becomesContext) { lines.push(` ${line.slice(1)}`); lastKept = true; }
        else lastKept = false;
        return;
      }
      lines.push(line);
      lastKept = true;
    });
    if (hunkChanges) { out.push(...lines); changed = true; }
  }
  return changed ? `${out.join("\n")}\n` : null;
}

export async function applyLines(inputPath: string, file: string, mode: LineMode, selection: LineSelection[], fingerprint: string | null): Promise<CommandResult> {
  const root = await repositoryRoot(inputPath);
  const rel = safeFile(file);
  if (!selection.length) throw invalidError("select at least one changed line");
  const side: DiffSide = mode === "unstage" ? "staged" : "unstaged";
  if (side === "unstaged" && await isUntracked(root, rel)) {
    if (mode === "discard") throw invalidError("this file is untracked — delete it or discard the whole file instead");
    // Record the path with empty content so its lines can be staged piecemeal.
    await checked(root, ["add", "--intent-to-add", "--", rel]);
  }
  const raw = await rawDiff(root, rel, side);
  if (fingerprint !== null && fingerprintOf(splitDiff(raw).hunks) !== fingerprint) {
    throw new AppError("invalid", "the file changed since the diff was shown — refresh and select again");
  }
  const patch = buildLinePatch(raw, selection, mode !== "stage");
  if (!patch) throw invalidError("the selection contains no added or removed lines");
  const temp = path.join(os.tmpdir(), `chrono-lines-${process.pid}-${Date.now()}.patch`);
  await fs.writeFile(temp, patch, "utf8");
  try {
    const args = ["apply", "--recount", "--whitespace=nowarn"];
    if (mode !== "discard") args.push("--cached");
    if (mode !== "stage") args.push("-R");
    args.push("--", temp);
    return await checked(root, args);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

// Interactive rebase planner: prepare a plan, then start the rebase by
// injecting an exact todo list through GIT_SEQUENCE_EDITOR.
//
// Ported from `src-tauri/src/rebase_planner.rs` (desktop module).

import fs from "node:fs/promises";
import path from "node:path";
import { AppError, invalidError, unsupportedError } from "./lib/errors.ts";
import { checked, checkedStdout, runGit, type CommandResult } from "./lib/git.ts";
import { repositoryOperationState, type RepositoryOperationState } from "./operationState.ts";

export interface RebasePlanCommit {
  commit: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  additions: number;
  deletions: number;
  filesChanged: number;
}

export interface RebasePlan {
  target: string;
  targetCommit: string;
  base: string;
  head: string;
  commits: RebasePlanCommit[];
  warnings: string[];
  blockedReason: string | null;
  supportsUpdateRefs: boolean;
}

export interface RebasePlanItem {
  commit: string;
  subject: string;
  action: "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";
  newMessage?: string | null;
}

export interface RebaseStartRequest {
  target: string;
  base: string;
  items: RebasePlanItem[];
  updateRefs: boolean;
}

export interface RebaseStartResult {
  result: CommandResult;
  operation: RepositoryOperationState;
}

async function revParse(inputPath: string, revision: string): Promise<string> {
  const expression = `${revision}^{commit}`;
  return (await checkedStdout(inputPath, ["rev-parse", "--verify", expression])).trim();
}

async function repositoryClean(inputPath: string): Promise<boolean> {
  return (await checkedStdout(inputPath, ["status", "--porcelain=v1", "-z"])).length === 0;
}

async function supportsUpdateRefs(inputPath: string): Promise<boolean> {
  const result = await runGit(inputPath, ["version"]);
  if (result.code !== 0) return false;
  const raw = result.stdout.trim().split(/\s+/).pop() ?? "";
  const [major = "0", minor = "0"] = raw.split(".");
  const majorValue = Number.parseInt(major, 10) || 0;
  const minorValue = Number.parseInt(minor, 10) || 0;
  return majorValue > 2 || (majorValue === 2 && minorValue >= 38);
}

async function gitDir(inputPath: string): Promise<string> {
  return (await checkedStdout(inputPath, ["rev-parse", "--absolute-git-dir"])).trim();
}

async function parseNumstat(
  inputPath: string,
  commit: string,
): Promise<{ additions: number; deletions: number; files: number }> {
  const output = await checkedStdout(inputPath, ["show", "--numstat", "--format=", "--no-renames", commit]);
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!line.length) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [add, del] = parts;
    files += 1;
    if (add !== "-") additions += Number.parseInt(add, 10) || 0;
    if (del !== "-") deletions += Number.parseInt(del, 10) || 0;
  }
  return { additions, deletions, files };
}

async function commitRecord(inputPath: string, commit: string): Promise<RebasePlanCommit> {
  const line = (
    await checkedStdout(inputPath, [
      "show",
      "-s",
      "--date=iso-strict",
      "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s",
      commit,
    ])
  ).trim();
  const fields = line.split("\u001f");
  if (fields.length !== 5) {
    throw new AppError("command", `unable to parse commit metadata for ${commit}`);
  }
  const { additions, deletions, files } = await parseNumstat(inputPath, commit);
  return {
    commit: fields[0],
    authorName: fields[1],
    authorEmail: fields[2],
    authoredAt: fields[3],
    subject: fields[4],
    additions,
    deletions,
    filesChanged: files,
  };
}

export async function prepareRebasePlan(inputPath: string, target: string): Promise<RebasePlan> {
  if ((await repositoryOperationState(inputPath)).operation !== null) {
    throw invalidError("finish or abort the current Git operation before planning another rebase");
  }
  if (!(await repositoryClean(inputPath))) {
    throw invalidError("interactive rebase requires a clean working tree; commit or stash changes first");
  }

  const targetCommit = await revParse(inputPath, target);
  const head = await revParse(inputPath, "HEAD");
  const base = (await checkedStdout(inputPath, ["merge-base", targetCommit, head])).trim();
  if (!base) throw invalidError("the selected target and HEAD do not have a merge base");

  const range = `${base}..${head}`;
  const merges = await checkedStdout(inputPath, ["rev-list", "--merges", range]);
  const mergeCommits = merges.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const blockedReason = mergeCommits > 0
    ? `This branch contains ${mergeCommits} merge commit${mergeCommits === 1 ? "" : "s"}. The first planner slice intentionally refuses to flatten merge topology.`
    : null;

  const list = await checkedStdout(inputPath, ["rev-list", "--reverse", "--topo-order", "--no-merges", range]);
  const commits: RebasePlanCommit[] = [];
  for (const commit of list.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)) {
    commits.push(await commitRecord(inputPath, commit));
  }

  const warnings =
    targetCommit === base
      ? []
      : [
          "The selected target is not the current branch's merge base. Chrono will replay the branch commits from the common base onto the selected target.",
        ];

  return {
    target,
    targetCommit,
    base,
    head,
    commits,
    warnings,
    blockedReason,
    supportsUpdateRefs: await supportsUpdateRefs(inputPath),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sanitizeSubject(subject: string): string {
  return subject.replace(/[\r\n]/g, " ");
}

// Find branches (not checked out in any worktree) that point at commits in the
// rewrite set, so the todo can update them with `update-ref`.
async function updateRefsByCommit(
  inputPath: string,
  commits: Set<string>,
): Promise<Map<string, string[]>> {
  const worktrees = await checkedStdout(inputPath, ["worktree", "list", "--porcelain"]);
  const checkedOut = new Set<string>();
  for (const line of worktrees.split(/\r?\n/)) {
    if (line.startsWith("branch ")) checkedOut.add(line.slice("branch ".length).trim());
  }
  const refs = await checkedStdout(inputPath, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
    "refs/heads",
  ]);
  const byCommit = new Map<string, string[]>();
  for (const line of refs.split(/\r?\n/)) {
    if (!line.length) continue;
    const separator = line.indexOf("\0");
    if (separator < 0) continue;
    const reference = line.slice(0, separator);
    const commit = line.slice(separator + 1);
    if (checkedOut.has(reference) || !commits.has(commit)) continue;
    const existing = byCommit.get(commit) ?? [];
    existing.push(reference);
    byCommit.set(commit, existing);
  }
  for (const values of byCommit.values()) values.sort();
  return byCommit;
}

async function buildTodo(
  items: RebasePlanItem[],
  updateRefs: Map<string, string[]>,
): Promise<string> {
  let todo = "";
  let previousKept = false;
  for (const item of items) {
    const action = item.action;
    if (!["pick", "reword", "edit", "squash", "fixup", "drop"].includes(action)) {
      throw invalidError(`unknown rebase action: ${action}`);
    }
    if ((action === "squash" || action === "fixup") && !previousKept) {
      throw invalidError(`${action} cannot be the first surviving action in an interactive rebase`);
    }
    const subject = sanitizeSubject(item.subject);
    if (action === "reword") {
      const message = item.newMessage?.trim();
      if (!message) {
        throw invalidError(`reword for ${item.commit} requires a new commit message`);
      }
      todo += `pick ${item.commit} ${subject}\n`;
      todo += `exec git commit --amend -m ${shellQuote(message)}\n`;
      previousKept = true;
    } else if (action === "drop") {
      todo += `drop ${item.commit} ${subject}\n`;
    } else {
      todo += `${action} ${item.commit} ${subject}\n`;
      previousKept = true;
    }
    const references = updateRefs.get(item.commit);
    if (references) {
      for (const reference of references) todo += `update-ref ${reference}\n`;
    }
  }
  if (!previousKept) {
    throw invalidError(
      "the plan drops every commit; use reset/branch operations for that history rewrite instead",
    );
  }
  return todo;
}

// Windows git ships `sh` (git-bash); on Unix plain `sh` works. Both accept a
// quoted script path as the first argument.
function shellCommand(scriptPath: string): string {
  return process.platform === "win32" ? `sh.exe ${shellQuote(scriptPath)}` : `sh ${shellQuote(scriptPath)}`;
}

export async function startRebasePlan(
  inputPath: string,
  request: RebaseStartRequest,
): Promise<RebaseStartResult> {
  const current = await prepareRebasePlan(inputPath, request.target);
  if (current.blockedReason) throw invalidError(current.blockedReason);
  if (request.base !== current.base) {
    throw invalidError("the rebase base changed since the plan was loaded; refresh the plan before starting");
  }

  const expected = new Set(current.commits.map((item) => item.commit));
  const supplied = new Set(request.items.map((item) => item.commit));
  if (expected.size !== supplied.size || !request.items.every((item) => expected.has(item.commit))) {
    throw invalidError("the submitted rebase plan does not contain exactly the commits from the current plan");
  }

  const updateRefs = new Map<string, string[]>();
  if (request.updateRefs) {
    if (!current.supportsUpdateRefs) {
      throw unsupportedError("this Git version does not support rebase --update-refs");
    }
    const byCommit = await updateRefsByCommit(inputPath, expected);
    for (const [commit, refs] of byCommit) updateRefs.set(commit, refs);
  }

  const todo = await buildTodo(request.items, updateRefs);
  const directory = await gitDir(inputPath);
  const todoPath = path.join(directory, "chrono-rebase-todo");
  const editorPath = path.join(directory, "chrono-sequence-editor.sh");
  await fs.writeFile(todoPath, todo);
  await fs.writeFile(editorPath, '#!/bin/sh\ncat "$CHRONO_REBASE_TODO" > "$1"\n');
  if (process.platform !== "win32") {
    await fs.chmod(editorPath, 0o700);
  }

  const rebaseArgs = ["rebase", "--interactive"];
  if (request.updateRefs) rebaseArgs.push("--update-refs");
  rebaseArgs.push("--onto", current.targetCommit, current.base);

  const editor = process.platform === "win32" ? "cmd /c exit 0" : "true";
  const result = await runGit(inputPath, rebaseArgs, {
    GIT_SEQUENCE_EDITOR: shellCommand(editorPath),
    CHRONO_REBASE_TODO: todoPath,
    GIT_EDITOR: editor,
  });
  const commandResult: CommandResult = {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
  };
  const operation = await repositoryOperationState(inputPath);

  await fs.rm(todoPath, { force: true });
  await fs.rm(editorPath, { force: true });

  if (commandResult.exitCode !== 0 && operation.operation === null) {
    throw new AppError("command", `git rebase --interactive: ${commandResult.stderr.trim()}`);
  }

  return { result: commandResult, operation };
}

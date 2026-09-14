// Merge/rebase/cherry-pick/revert operation state detection and control.
//
// Ported from `src-tauri/src/operation_state.rs` (desktop module).

import fs from "node:fs/promises";
import path from "node:path";
import { invalidError } from "./lib/errors.ts";
import { checked, checkedStdout, runGit, type CommandResult } from "./lib/git.ts";

export interface RepositoryOperationState {
  operation: "merge" | "rebase" | "cherryPick" | "revert" | null;
  hasConflicts: boolean;
  conflictCount: number;
  canContinue: boolean;
  canSkip: boolean;
  canAbort: boolean;
  currentCommit: string | null;
  currentSubject: string | null;
  step: number | null;
  total: number | null;
  message: string;
}

export type OperationAction = "continue" | "skip" | "abort";

function editorCommand(): string {
  return process.platform === "win32" ? "cmd /c exit 0" : "true";
}

async function gitDir(inputPath: string): Promise<string> {
  return (await checkedStdout(inputPath, ["rev-parse", "--absolute-git-dir"])).trim();
}

async function readTrimmed(target: string): Promise<string | null> {
  try {
    const value = (await fs.readFile(target, "utf8")).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstLine(value: string | null): string | null {
  if (value === null) return null;
  const line = value.split(/\r?\n/).map((value) => value.trim()).find((value) => value.length > 0);
  return line ?? null;
}

async function refValue(inputPath: string, name: string): Promise<string | null> {
  const result = await runGit(inputPath, ["rev-parse", "--verify", name]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function subjectFor(inputPath: string, commit: string | null): Promise<string | null> {
  if (!commit) return null;
  const result = await runGit(inputPath, ["show", "-s", "--format=%s", commit]);
  if (result.code !== 0) return null;
  return firstLine(result.stdout);
}

async function conflictCount(inputPath: string): Promise<number> {
  const result = await checkedStdout(inputPath, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  return result.split("\0").filter((entry) => entry.length > 0).length;
}

export async function repositoryOperationState(inputPath: string): Promise<RepositoryOperationState> {
  const gitDirectory = await gitDir(inputPath);
  const rebaseMerge = path.join(gitDirectory, "rebase-merge");
  const rebaseApply = path.join(gitDirectory, "rebase-apply");

  let operation: RepositoryOperationState["operation"] = null;
  let currentCommit: string | null = null;
  let currentSubject: string | null = null;
  let step: number | null = null;
  let total: number | null = null;

  const isDir = async (target: string): Promise<boolean> => {
    try {
      return (await fs.stat(target)).isDirectory();
    } catch {
      return false;
    }
  };
  const isFile = async (target: string): Promise<boolean> => {
    try {
      return (await fs.stat(target)).isFile();
    } catch {
      return false;
    }
  };

  if ((await isDir(rebaseMerge)) || (await isDir(rebaseApply))) {
    const directory = (await isDir(rebaseMerge)) ? rebaseMerge : rebaseApply;
    currentCommit =
      (await refValue(inputPath, "REBASE_HEAD")) ??
      (await readTrimmed(path.join(directory, "stopped-sha"))) ??
      (await readTrimmed(path.join(directory, "original-commit")));
    currentSubject =
      (await subjectFor(inputPath, currentCommit)) ??
      firstLine(await readTrimmed(path.join(directory, "message")));
    if (await isDir(rebaseMerge)) {
      step = readNumber(await readTrimmed(path.join(directory, "msgnum")));
      total = readNumber(await readTrimmed(path.join(directory, "end")));
    } else {
      step = readNumber(await readTrimmed(path.join(directory, "next")));
      total = readNumber(await readTrimmed(path.join(directory, "last")));
    }
    operation = "rebase";
  } else if (await isFile(path.join(gitDirectory, "MERGE_HEAD"))) {
    currentCommit = firstLine(await readTrimmed(path.join(gitDirectory, "MERGE_HEAD")));
    currentSubject = await subjectFor(inputPath, currentCommit);
    operation = "merge";
  } else if (await isFile(path.join(gitDirectory, "CHERRY_PICK_HEAD"))) {
    currentCommit = firstLine(await readTrimmed(path.join(gitDirectory, "CHERRY_PICK_HEAD")));
    currentSubject = await subjectFor(inputPath, currentCommit);
    operation = "cherryPick";
  } else if (await isFile(path.join(gitDirectory, "REVERT_HEAD"))) {
    currentCommit = firstLine(await readTrimmed(path.join(gitDirectory, "REVERT_HEAD")));
    currentSubject = await subjectFor(inputPath, currentCommit);
    operation = "revert";
  }

  const conflicts = await conflictCount(inputPath);
  const active = operation !== null;
  const skippable = operation === "rebase" || operation === "cherryPick" || operation === "revert";

  let message: string;
  if (!active) {
    message = "No merge, rebase, cherry-pick or revert is in progress.";
  } else if (conflicts > 0) {
    message = `${conflicts} unresolved conflict${conflicts === 1 ? "" : "s"}. Resolve and stage the files before continuing.`;
  } else if (step !== null && total !== null) {
    message = `Step ${step} of ${total} is resolved and ready to continue.`;
  } else {
    message = "The operation is paused and ready to continue, skip where supported, or abort.";
  }

  return {
    operation,
    hasConflicts: conflicts > 0,
    conflictCount: conflicts,
    canContinue: active && conflicts === 0,
    canSkip: active && skippable,
    canAbort: active,
    currentCommit,
    currentSubject,
    step,
    total,
    message,
  };
}

export async function controlRepositoryOperation(
  inputPath: string,
  action: OperationAction,
): Promise<CommandResult> {
  const state = await repositoryOperationState(inputPath);
  const operation = state.operation;
  if (!operation) {
    throw invalidError("no merge, rebase, cherry-pick or revert is in progress");
  }
  if (action === "continue" && state.hasConflicts) {
    throw invalidError("resolve and stage all conflicts before continuing");
  }
  if (action === "skip" && !state.canSkip) {
    throw invalidError(`${operation} does not support skip in this workflow`);
  }
  if (action !== "continue" && action !== "skip" && action !== "abort") {
    throw invalidError(`unknown operation action: ${action}`);
  }

  const command =
    operation === "merge"
      ? "merge"
      : operation === "rebase"
        ? "rebase"
        : operation === "cherryPick"
          ? "cherry-pick"
          : "revert";
  const flag = action === "continue" ? "--continue" : action === "skip" ? "--skip" : "--abort";

  const editor = editorCommand();
  return checked(inputPath, [command, flag], {
    GIT_EDITOR: editor,
    GIT_SEQUENCE_EDITOR: editor,
  });
}

import type { FileChange, SubmoduleChange } from "./types";

// Staging state of changed files when some of them are submodules. Committing
// from a superproject also commits submodules with staged changes (server:
// nestedCommit.ts), so the views count those as staged too.

export const isStaged = (change: FileChange) => !change.conflicted && change.indexStatus !== " " && change.indexStatus !== "?" && change.indexStatus !== "";
export const isUnstaged = (change: FileChange) => change.conflicted || (change.worktreeStatus !== " " && change.worktreeStatus !== "") || change.indexStatus === "?";

// A submodule row is "staged" when anything inside it is staged (it will get
// its own commit, then this repository records the new commit id), and
// "unstaged" when anything inside it is not, or it moved without being staged.
export const stagedInside = (info: SubmoduleChange): boolean => info.changes.some((change) => isStaged(change) || (change.submodule ? stagedInside(change.submodule) : false));
export const unstagedInside = (info: SubmoduleChange): boolean => info.changes.some((change) => (change.submodule ? unstagedInside(change.submodule) || (change.submodule.newCommits && !isStaged(change)) : isUnstaged(change)));
export const rowStaged = (change: FileChange) => isStaged(change) || (change.submodule ? stagedInside(change.submodule) : false);
export const rowUnstaged = (change: FileChange) => (change.submodule
  ? change.conflicted || unstagedInside(change.submodule) || (change.submodule.newCommits && !isStaged(change)) || (!rowStaged(change) && isUnstaged(change))
  : isUnstaged(change));
/** Submodules (paths from this repository) that will get their own commit, deepest first. */
export function nestedCommitPlan(changes: FileChange[], prefix = ""): string[] {
  const plan: string[] = [];
  for (const change of changes) {
    if (!change.submodule) continue;
    const here = `${prefix}${change.path}`;
    plan.push(...nestedCommitPlan(change.submodule.changes, `${here}/`));
    if (stagedInside(change.submodule)) plan.push(here);
  }
  return plan;
}

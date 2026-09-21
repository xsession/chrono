import type { BranchRecord, CommitRecord } from "./types";

export function referenceKey(branch: BranchRecord): string {
  return `${branch.remote ? "remote" : "local"}:${branch.name}`;
}

export function reachableCommitIds(commits: CommitRecord[], target: string): Set<string> {
  const byId = new Map(commits.map((commit) => [commit.id, commit]));
  const reachable = new Set<string>();
  const pending = [target];
  while (pending.length) {
    const id = pending.pop();
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    for (const parent of byId.get(id)?.parents ?? []) pending.push(parent);
  }
  return reachable;
}

/** Commits reachable from every branch/ref that is not hidden. An empty
 * hidden list deliberately means all loaded commits. */
export function visibleRefCommitIds(commits: CommitRecord[], branches: BranchRecord[], hiddenRefs: string[]): Set<string> {
  if (hiddenRefs.length === 0) return new Set(commits.map((commit) => commit.id));
  const hidden = new Set(hiddenRefs);
  const visible = branches.filter((branch) => !hidden.has(referenceKey(branch)));
  const result = new Set<string>();
  for (const branch of visible) {
    for (const commit of reachableCommitIds(commits, branch.target)) result.add(commit);
  }
  return result;
}

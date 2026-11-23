// Commits that reach into submodules, at any depth.
//
// Committing a superproject while a submodule has changes normally records the
// submodule's old commit and leaves its edits behind ("modified content", the
// "-dirty" state). Chrono instead treats the submodule's staged changes as part
// of the commit: each submodule with staged changes gets its own normal commit,
// deepest first, and every parent then stages the submodule's new commit id
// before committing itself. Staging a submodule from its parent stages the
// changes inside it, so "Stage all & commit" works the same way.

import { existsSync } from "node:fs";
import path from "node:path";
import { invalidError } from "./lib/errors.ts";
import { hasHead, runGit } from "./lib/git.ts";

export interface NestedCommit {
  /** Submodule path relative to the repository the commit started in. */
  path: string;
  commit: string;
  /** Committed on a detached HEAD: no branch points at the new commit. */
  detached: boolean;
  /** Branch that was checked out first because it pointed at the old HEAD. */
  attachedTo: string | null;
}

export interface NestedCommitOptions {
  message: string;
  signoff?: boolean;
  noVerify?: boolean;
  /** Environment for every git commit (author/committer identity). */
  env?: Record<string, string>;
}

export class NestedCommitError extends Error {
  readonly repository: string;
  readonly output: string;
  readonly exitCode: number;
  readonly done: NestedCommit[];
  constructor(repository: string, output: string, exitCode: number, done: NestedCommit[]) {
    super(`commit in submodule ${repository} failed`);
    this.repository = repository;
    this.output = output;
    this.exitCode = exitCode;
    this.done = done;
  }
}

const MAX_DEPTH = 8;

/** Initialised submodules of `dir` (gitlinks with a checkout), relative paths. */
export async function submodulesOf(dir: string): Promise<string[]> {
  const listed = await runGit(dir, ["ls-files", "-s", "-z"]);
  if (listed.code !== 0) return [];
  const paths: string[] = [];
  for (const entry of listed.stdout.split("\0")) {
    if (!entry.startsWith("160000 ")) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const relative = entry.slice(tab + 1);
    if (existsSync(path.join(dir, relative, ".git"))) paths.push(relative);
  }
  return paths;
}

async function hasAnyChange(dir: string): Promise<boolean> {
  const status = await runGit(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  return status.code === 0 && status.stdout.length > 0;
}

async function hasStaged(dir: string): Promise<boolean> {
  // Exit code 1: the index differs from HEAD (or, before the first commit, from empty).
  return (await runGit(dir, ["diff", "--cached", "--quiet", "--ignore-submodules=none"])).code === 1;
}

/** Stage everything inside `dir`, nested submodules first. */
async function stageInside(dir: string, depth: number): Promise<void> {
  if (depth < MAX_DEPTH) {
    for (const sub of await submodulesOf(dir)) {
      const absolute = path.join(dir, sub);
      if (await hasAnyChange(absolute)) await stageInside(absolute, depth + 1);
    }
  }
  const added = await runGit(dir, ["add", "-A"]);
  if (added.code !== 0) throw invalidError(`could not stage changes in ${dir}: ${added.stderr.trim()}`);
}

/** Unstage everything inside `dir`, nested submodules too. */
async function unstageInside(dir: string, depth: number): Promise<void> {
  if (depth < MAX_DEPTH) {
    for (const sub of await submodulesOf(dir)) await unstageInside(path.join(dir, sub), depth + 1);
  }
  if (await hasHead(dir)) await runGit(dir, ["reset", "-q"]);
  else await runGit(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "."]);
}

/** `git add` that, for a submodule path, stages the changes inside it as well. */
export async function stagePathsNested(root: string, files: string[]): Promise<void> {
  if (!files.length) return;
  const subs = new Set(await submodulesOf(root));
  for (const file of files) {
    const clean = file.replace(/[\\/]+$/, "");
    if (subs.has(clean) && await hasAnyChange(path.join(root, clean))) await stageInside(path.join(root, clean), 1);
  }
  const added = await runGit(root, ["add", "--", ...files]);
  if (added.code !== 0) throw invalidError(added.stderr.trim() || "git add failed");
}

/** `git restore --staged` that, for a submodule path, also unstages inside it. */
export async function unstagePathsNested(root: string, files: string[]): Promise<void> {
  if (!files.length) return;
  const subs = new Set(await submodulesOf(root));
  for (const file of files) {
    const clean = file.replace(/[\\/]+$/, "");
    if (subs.has(clean)) await unstageInside(path.join(root, clean), 1);
  }
  const restored = (await hasHead(root))
    ? await runGit(root, ["restore", "--staged", "--", ...files])
    : await runGit(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...files]);
  if (restored.code !== 0) throw invalidError(restored.stderr.trim() || "git restore --staged failed");
}

/** Whether any submodule below `root` has staged changes waiting to be committed. */
export async function hasStagedSubmodules(root: string, depth = 0): Promise<boolean> {
  if (depth >= MAX_DEPTH) return false;
  for (const sub of await submodulesOf(root)) {
    const absolute = path.join(root, sub);
    if (await hasStaged(absolute) || await hasStagedSubmodules(absolute, depth + 1)) return true;
  }
  return false;
}

/** A detached submodule whose HEAD is the tip of exactly one local branch is
 *  put back on that branch first, so the new commit does not end up on no
 *  branch at all (submodule update leaves checkouts detached). */
async function attachIfPossible(dir: string): Promise<string | null> {
  const symbolic = await runGit(dir, ["symbolic-ref", "-q", "HEAD"]);
  if (symbolic.code === 0) return null; // already on a branch
  const tips = await runGit(dir, ["for-each-ref", "--points-at", "HEAD", "--format=%(refname:short)", "refs/heads"]);
  const branches = tips.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (branches.length !== 1) return null;
  const switched = await runGit(dir, ["switch", "-q", branches[0]]);
  return switched.code === 0 ? branches[0] : null;
}

/**
 * Commit every submodule below `root` that has staged changes, deepest first,
 * and stage each one's new commit id in its parent. The caller then commits
 * `root` itself. Throws NestedCommitError when a submodule commit fails (for
 * example a hook); commits made before the failure stay.
 */
export async function commitSubmodules(root: string, options: NestedCommitOptions): Promise<NestedCommit[]> {
  if (!options.message.trim()) throw invalidError("commit message is empty");
  const done: NestedCommit[] = [];
  const visit = async (dir: string, prefix: string, depth: number): Promise<boolean> => {
    if (depth < MAX_DEPTH) {
      for (const sub of await submodulesOf(dir)) {
        // A submodule that got a new commit is staged in its parent, which
        // then has a change to commit too.
        if (await visit(path.join(dir, sub), `${prefix}${sub}/`, depth + 1)) {
          const add = await runGit(dir, ["add", "--", sub]);
          if (add.code !== 0) throw new NestedCommitError(prefix.replace(/\/$/, "") || ".", add.stderr, add.code, done);
        }
      }
    }
    // The repository the commit started in is committed by the caller.
    if (depth === 0) return false;
    return (await hasStaged(dir)) ? commitHere(dir, prefix) : false;
  };
  const commitHere = async (dir: string, prefix: string): Promise<boolean> => {
    const attachedTo = await attachIfPossible(dir);
    const args = ["commit", "-m", options.message];
    if (options.signoff) args.push("--signoff");
    if (options.noVerify) args.push("--no-verify");
    const result = await runGit(dir, args, options.env ?? {});
    const where = prefix.replace(/\/$/, "");
    if (result.code !== 0) throw new NestedCommitError(where, [result.stdout, result.stderr].filter(Boolean).join("\n"), result.code, done);
    const sha = (await runGit(dir, ["rev-parse", "HEAD"])).stdout.trim();
    const detached = (await runGit(dir, ["symbolic-ref", "-q", "HEAD"])).code !== 0;
    done.push({ path: where, commit: sha, detached, attachedTo });
    return true;
  };
  await visit(root, "", 0);
  return done;
}

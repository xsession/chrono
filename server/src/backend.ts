// Core git repository operations.
//
// Ported from `src-tauri/src/backend/cli.rs`. Returns the same camelCase shapes
// the frontend `types.ts` already defines.

import path from "node:path";
import { invalidError } from "./lib/errors.ts";
import {
  checked,
  checkedStdout,
  COMMIT_FORMAT,
  parseCommits,
  repositoryRoot,
  runGit,
  type CommandResult,
  type CommitRecord,
} from "./lib/git.ts";

export interface RepositorySummary {
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
}

export interface FileChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  conflicted: boolean;
}

export interface BranchRecord {
  name: string;
  target: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
}

export interface CloneRequest {
  url: string;
  destination: string;
  username?: string | null;
  token?: string | null;
}

export interface AuthRequest {
  username?: string | null;
  token?: string | null;
}

export interface WorkflowRequest {
  operation: string;
  args: string[];
}

export async function repositorySummary(inputPath: string): Promise<RepositorySummary> {
  const root = await repositoryRoot(inputPath);
  const branchResult = await runGit(root, ["branch", "--show-current"]);
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
  const headResult = await runGit(root, ["rev-parse", "HEAD"]);
  const head = headResult.code === 0 ? headResult.stdout.trim() : null;

  let ahead = 0;
  let behind = 0;
  let dirty = false;
  const statusResult = await checkedStdout(root, ["status", "--porcelain=v2", "--branch"]);
  for (const line of statusResult.split(/\r?\n/)) {
    if (!line.length) continue;
    if (line.startsWith("# branch.ab ")) {
      for (const token of line.split(/\s+/).filter((value) => value.length > 0)) {
        if (token.startsWith("+")) ahead = Number.parseInt(token.slice(1), 10) || 0;
        else if (token.startsWith("-")) behind = Number.parseInt(token.slice(1), 10) || 0;
      }
    } else if (!line.startsWith("#")) {
      dirty = true;
    }
  }

  return {
    name: path.basename(root) || "repository",
    path: root,
    branch: branch.length > 0 ? branch : null,
    head,
    ahead,
    behind,
    dirty,
  };
}

export async function repositoryHistory(inputPath: string, limit: number): Promise<CommitRecord[]> {
  const clamped = String(Math.min(Math.max(limit, 1), 5000));
  const result = await checkedStdout(inputPath, [
    "log",
    "--date=iso-strict",
    `--pretty=format:${COMMIT_FORMAT}`,
    "-n",
    clamped,
  ]);
  return parseCommits(result);
}

export async function repositoryStatus(inputPath: string): Promise<FileChange[]> {
  const result = await checkedStdout(inputPath, ["status", "--porcelain=v1", "-z"]);
  const entries = result.split("\0").filter((entry) => entry.length > 0);
  const changes: FileChange[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const index = (entry[0] ?? " ").trim() || " ";
    const worktree = (entry[1] ?? " ").trim() || " ";
    const renamedOrCopied = index === "R" || index === "C" || worktree === "R" || worktree === "C";
    changes.push({
      path: entry.slice(3),
      indexStatus: index,
      worktreeStatus: worktree,
      conflicted:
        index === "U" ||
        worktree === "U" ||
        (index === "A" && worktree === "A") ||
        (index === "D" && worktree === "D"),
    });
    if (renamedOrCopied) i += 1; // skip the paired "original path" entry
  }
  return changes;
}

export async function repositoryBranches(inputPath: string): Promise<BranchRecord[]> {
  const result = await checkedStdout(inputPath, [
    "for-each-ref",
    "--format=%(refname:short)%1f%(objectname)%1f%(HEAD)%1f%(upstream:short)%1f%(refname)%1e",
    "refs/heads",
    "refs/remotes",
  ]);
  const branches: BranchRecord[] = [];
  for (const chunk of result.split("\u001e")) {
    const fields = chunk.trim().split("\u001f");
    if (fields.length !== 5) continue;
    branches.push({
      name: fields[0],
      target: fields[1],
      current: fields[2] === "*",
      remote: fields[4].startsWith("refs/remotes/"),
      upstream: fields[3].length > 0 ? fields[3] : null,
    });
  }
  return branches;
}

export async function stagePaths(inputPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await checked(inputPath, ["add", "--", ...files]);
}

export async function unstagePaths(inputPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await checked(inputPath, ["restore", "--staged", "--", ...files]);
}

export async function createCommit(inputPath: string, message: string): Promise<string> {
  if (message.trim().length === 0) throw invalidError("commit message is empty");
  await checked(inputPath, ["commit", "-m", message]);
  return (await checkedStdout(inputPath, ["rev-parse", "HEAD"])).trim();
}

export async function fetchRepository(inputPath: string, _auth?: AuthRequest): Promise<CommandResult> {
  return checked(inputPath, ["fetch", "--all", "--prune", "--tags"]);
}

export async function pullRepository(inputPath: string): Promise<CommandResult> {
  return checked(inputPath, ["pull", "--ff-only"]);
}

export async function pushRepository(inputPath: string, _auth?: AuthRequest): Promise<CommandResult> {
  return checked(inputPath, ["push"]);
}

export async function cloneRepository(request: CloneRequest): Promise<RepositorySummary> {
  if (!request.url.trim() || !request.destination.trim()) {
    throw invalidError("clone URL and destination are required");
  }
  const url = withAuth(request.url, request.username, request.token);
  await checked(null, ["clone", "--", url, request.destination]);
  return repositorySummary(request.destination);
}

function withAuth(url: string, username?: string | null, token?: string | null): string {
  if (!token) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      parsed.username = username && username.length > 0 ? username : "oauth2";
      parsed.password = token;
      return parsed.toString();
    }
  } catch {
    // not a URL we understand; leave as-is
  }
  return url;
}

export async function switchBranch(inputPath: string, branch: string): Promise<void> {
  await checked(inputPath, ["switch", branch]);
}

export async function createBranch(inputPath: string, branch: string): Promise<void> {
  await checked(inputPath, ["switch", "-c", branch]);
}

export async function runWorkflow(inputPath: string, request: WorkflowRequest): Promise<CommandResult> {
  return checked(inputPath, workflowArgs(request));
}

function requireArgs(request: WorkflowRequest, count: number): string[] {
  if (request.args.length < count) {
    throw invalidError(`${request.operation} requires at least ${count} arguments`);
  }
  return request.args.slice(0, count);
}

function workflowArgs(request: WorkflowRequest): string[] {
  switch (request.operation) {
    case "worktree_list":
      return ["worktree", "list", "--porcelain"];
    case "worktree_add": {
      const [location, commit] = requireArgs(request, 2);
      return ["worktree", "add", location, commit];
    }
    case "worktree_remove": {
      const [location] = requireArgs(request, 1);
      return ["worktree", "remove", location];
    }
    case "worktree_prune":
      return ["worktree", "prune", "--verbose"];
    case "sparse_set":
      return ["sparse-checkout", "set", "--cone", ...requireArgs(request, 1)];
    case "sparse_disable":
      return ["sparse-checkout", "disable"];
    case "submodule_update":
      return ["submodule", "update", "--init", "--recursive"];
    case "submodule_sync":
      return ["submodule", "sync", "--recursive"];
    case "stash_list":
      return ["stash", "list"];
    case "stash_push":
      return ["stash", "push", "-u", "-m", request.args[0] ?? "Chrono Next stash"];
    case "stash_pop":
      return ["stash", "pop"];
    case "bisect_start": {
      const [good, bad] = requireArgs(request, 2);
      return ["bisect", "start", good, bad];
    }
    case "bisect_good": {
      const [commit] = requireArgs(request, 1);
      return ["bisect", "good", commit];
    }
    case "bisect_bad": {
      const [commit] = requireArgs(request, 1);
      return ["bisect", "bad", commit];
    }
    case "bisect_reset":
      return ["bisect", "reset"];
    case "reflog":
      return ["reflog", "show", "--date=iso"];
    case "cherry_pick": {
      const [commit] = requireArgs(request, 1);
      return ["cherry-pick", commit];
    }
    case "revert": {
      const [commit] = requireArgs(request, 1);
      return ["revert", "--no-edit", commit];
    }
    case "lfs_locks":
      return ["lfs", "locks"];
    case "lfs_pull":
      return ["lfs", "pull"];
    case "lfs_prune":
      return ["lfs", "prune"];
    case "maintenance":
      return ["maintenance", "run"];
    case "fsck":
      return ["fsck", "--full", "--no-reflogs"];
    default:
      throw invalidError(`unknown workflow: ${request.operation}`);
  }
}

// Chrono Next TypeScript backend — HTTP API + static frontend.
//
// Replaces the Tauri/Rust backend: every former `#[tauri::command]` is now a
// `POST /api/<command>` route. In production the server also serves the built
// frontend from `dist/` (single origin, no CORS); in development Vite dev
// proxies `/api` to this server.

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError, statusCodeFor } from "./src/lib/errors.ts";
import * as backend from "./src/backend.ts";
import * as commitWriter from "./src/commitWriter.ts";
import * as conflictCenter from "./src/conflictCenter.ts";
import * as insights from "./src/insights.ts";
import { invokeServerSaga } from "./src/sagas.ts";
import { attachTerminalServer } from "./src/terminal.ts";
import { attachRpcServer } from "./src/rpc.ts";
import * as operationState from "./src/operationState.ts";
import * as rebasePlanner from "./src/rebasePlanner.ts";
import * as explorer from "./src/explorer.ts";
import * as gk from "./src/gkOps.ts";
import * as features from "./src/features.ts";
import * as ai from "./src/ai.ts";
import * as localLlm from "./src/localLlm.ts";
import * as forks from "./src/forks.ts";
import * as lineStaging from "./src/lineStaging.ts";
import * as submodules from "./src/submodules.ts";
import * as lfs from "./src/lfs.ts";
import * as ci from "./src/ci.ts";
import { landscapeScan } from "./src/landscape.ts";
import { landscapeRecent } from "./src/landscapeRecent.ts";
import { waitForChange } from "./src/repoWatch.ts";
import * as trust from "./src/trust.ts";
import * as folders from "./src/folders.ts";
import { currentRequestSignal, repositoryRoot, withAbortSignal, withDiffOptions, type DiffOptions } from "./src/lib/git.ts";
import { readStream, validStreamId } from "./src/lib/streams.ts";
import { rejectReason, type GuardOptions } from "./src/lib/requestGuard.ts";
import { listPullRequests } from "./src/provider.ts";
import * as hosting from "./src/hosting.ts";
import * as github from "./src/github.ts";
import * as repo from "./src/repo.ts";
import { loadWorkspaces, saveWorkspaces, type Workspace } from "./src/workspaces.ts";
import { recentGitCommands } from "./src/lib/gitLog.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const PORT = Number.parseInt(process.env.CHRONO_PORT ?? "1421", 10);
const HOST = process.env.CHRONO_HOST ?? "127.0.0.1";
const API_TOKEN = process.env.CHRONO_API_TOKEN ?? "";
const ALLOWED_ORIGIN = process.env.CHRONO_ALLOWED_ORIGIN ?? "";

function branchActionLabel(body: Record<string, unknown>): string {
  const branch = String(body.branch ?? "");
  const target = typeof body.target === "string" ? body.target : "";
  switch (body.action) {
    case "rename": return `Rename ${branch} to ${String(body.newName ?? "")}`;
    case "merge_into_current": return `Merge ${branch}`;
    case "rebase_current_onto": return `Rebase onto ${branch}`;
    case "fast_forward": return `Fast-forward ${branch}${target ? ` to ${target}` : ""}`;
    case "force_to_commit": return `Reset ${branch} to ${target.slice(0, 12)}`;
    case "checkout_and_merge": return `Merge ${branch} into ${target}`;
    case "pull_branch": return `Pull ${branch}`;
    default: return `${String(body.action ?? "").replace(/_/g, " ")} ${branch}`;
  }
}

async function resolveHost(body: Record<string, unknown>): Promise<features.RemoteHost> {
  const host = await features.remoteHost(bodyPath(body), optStr(body.remote) ?? "origin");
  if (!host) throw new AppError("invalid", "could not detect a GitHub, GitLab, Gitea or Bitbucket remote — check the remote URL");
  const apiBase = optStr(body.apiBase);
  if (apiBase) {
    if (!/^https?:\/\//i.test(apiBase)) throw new AppError("invalid", "API base must be an http(s) URL");
    host.apiBase = apiBase.replace(/\/+$/, "");
  }
  // A provider picked by hand (self-hosted servers on plain host names) wins
  // over detection; a Bitbucket Server picked this way still needs its API base.
  const provider = optStr(body.provider);
  if (provider && (features.HOSTING_PROVIDERS as readonly string[]).includes(provider) && provider !== host.provider) {
    host.provider = provider as features.HostingProvider;
    if (provider === "bitbucket-server") {
      if (!apiBase) throw new AppError("invalid", "set the API base for Bitbucket Server, e.g. https://bitbucket.example.com/rest/api/1.0");
      if (!host.owner.startsWith("~")) host.owner = host.owner.toUpperCase();
      const root = features.bitbucketServerRoot(host.apiBase);
      host.webBase = host.owner.startsWith("~") ? `${root}/users/${host.owner.slice(1)}/repos/${host.repository}` : `${root}/projects/${host.owner}/repos/${host.repository}`;
    }
  }
  return host;
}

/** A GitHub repository from a remote of the open repository, with its token. */
async function githubRepo(body: Record<string, unknown>): Promise<{ host: features.RemoteHost; token: string }> {
  const host = await resolveHost({ ...body, provider: optStr(body.provider) ?? undefined });
  if (host.provider !== "github") throw new AppError("invalid", `${host.host} is not a GitHub remote (set its provider in Settings → Hosting connections if it is GitHub Enterprise)`);
  return { host, token: await hosting.resolveToken(body.token, host.host) };
}

/** A GitHub server by API base (account, repositories, SSH keys). */
async function githubServer(body: Record<string, unknown>): Promise<{ apiBase: string; host: string; token: string }> {
  const apiBase = str(body.apiBase, "apiBase").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(apiBase)) throw new AppError("invalid", "API base must be an http(s) URL");
  const host = optStr(body.host) || new URL(apiBase).host.replace(/^api\./, "");
  return { apiBase, host, token: await hosting.resolveToken(body.token, host) };
}

const strList = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length < 120) : [];

// Viewer routes whose diffs honour the user's whitespace/algorithm options.
// Read-only routes: when the client drops the request (it switched to another
// repository tab), their git processes are killed. Routes that write never are,
// so a half-done operation is never left behind.
const READ_ROUTES = new Set([
  "repository_wait_change",
  "repository_summary", "repository_remotes", "repository_history", "repository_history_page", "history_query",
  "repository_status", "repository_branches", "repository_conflicts", "search_commits", "commit_details",
  "commit_file_diff", "list_tags", "reference_groups", "working_tree_diff", "unstaged_file_diff", "list_tree",
  "file_at_revision", "commit_activity", "diff_revisions", "history_change_stats", "compare_refs", "range_diff",
  "repository_health", "file_history", "line_history", "blame_file", "contributors", "worktree_summaries",
  "repository_operation_state", "undo_state", "last_commit_message", "commit_offset", "diff_commit_files",
  "submodule_tree", "ci_runs", "ci_latest", "ci_jobs", "ci_log", "ci_workflows", "lfs_status", "lfs_check", "lfs_locks", "repository_trust", "file_diff_side", "stash_files", "commit_signatures", "search_advanced",
  "fork_point", "predict_conflicts", "cleanup_candidates", "file_blob", "sparse_status", "notes_get",
  "explorer_list", "explorer_properties", "explorer_diff_files", "explorer_diff_previous",
  "landscape_recent", "fork_tree",
]);

const DIFF_VIEW_ROUTES = new Set(["working_tree_diff", "commit_file_diff", "diff_revisions", "explorer_diff_files", "explorer_diff_previous"]);

const guard: GuardOptions = { host: HOST, port: PORT, token: API_TOKEN, allowedOrigin: ALLOWED_ORIGIN };

function isLoopbackHost(): boolean {
  return HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

interface ParsedBody {
  path: string;
  [key: string]: unknown;
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 100 * 1024 * 1024) {
      throw new AppError("invalid", "request body is too large");
    }
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    throw new AppError("json", `invalid JSON body: ${(error as Error).message}`);
  }
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("invalid", `missing or invalid field: ${field}`);
  }
  return value;
}

/** `{ name, email }` for a one-off commit identity, or null. */
function commitIdentity(value: unknown): { name: string; email: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.email === "string" ? { name: record.name, email: record.email } : null;
}

function optStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError("invalid", `missing or invalid field: ${field}`);
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new AppError("invalid", `missing or invalid field: ${field}`);
  }
  return value;
}

function strArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AppError("invalid", `missing or invalid field: ${field}`);
  }
  return value as string[];
}

function numArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isSafeInteger(item))) {
    throw new AppError("invalid", `missing or invalid field: ${field}`);
  }
  return value as number[];
}

function bodyPath(body: Record<string, unknown>): string {
  return str(body.path, "path");
}

function repositoryRootOf(body: Record<string, unknown>): Promise<string> {
  return repositoryRoot(bodyPath(body));
}

// ---------------------------------------------------------------------------
// Command routes (1:1 with the former Tauri commands)
// ---------------------------------------------------------------------------

type Handler = (body: Record<string, unknown>) => Promise<unknown>;

const routes: Record<string, Handler> = {
  repository_summary: (body) => backend.repositorySummary(bodyPath(body)),
  repository_remotes: (body) => backend.repositoryRemotes(bodyPath(body)),
  repository_history: (body) =>
    backend.repositoryHistory(bodyPath(body), num(body.limit ?? 300, "limit")),
  repository_history_page: (body) =>
    backend.repositoryHistoryPage(bodyPath(body), num(body.limit ?? 300, "limit"), optStr(body.cursor)),
  history_query: (body) => {
    const mode = body.mode;
    if (mode !== "message" && mode !== "author" && mode !== "path") {
      throw new AppError("invalid", "filter mode must be message, author or path");
    }
    const limit = num(body.limit ?? 300, "limit");
    // SourceGit-style search modes: message = one --grep per word + --all-match,
    // author = --author, path = literal pathspec. All default to `--all` so the
    // whole repo (not just HEAD's branch) is searched.
    return insights.historyQuery(bodyPath(body), {
      query: str(body.query, "query"),
      mode,
      limit,
    });
  },
  repository_status: (body) => backend.repositoryStatus(bodyPath(body)),
  repository_branches: (body) => backend.repositoryBranches(bodyPath(body)),

  repository_conflicts: (body) => conflictCenter.repositoryConflicts(bodyPath(body)),
  conflict_detail: (body) =>
    conflictCenter.conflictDetail(bodyPath(body), str(body.file, "file")),
  resolve_conflict: (body) =>
    conflictCenter.resolveConflict(bodyPath(body), {
      file: str(body.file, "file"),
      strategy: str(body.strategy, "strategy") as conflictCenter.ConflictResolutionRequest["strategy"],
      content: optStr(body.content) ?? undefined,
    }),
  prepare_rebase_plan: (body) =>
    rebasePlanner.prepareRebasePlan(bodyPath(body), str(body.target, "target")),
  start_rebase_plan: (body) =>
    rebasePlanner.startRebasePlan(bodyPath(body), {
      target: str(body.target, "target"),
      base: str(body.base, "base"),
      updateRefs: bool(body.updateRefs, "updateRefs"),
      items: (Array.isArray(body.items) ? body.items : []).map((raw) => {
        const item = (raw ?? {}) as Record<string, unknown>;
        return {
          commit: str(item.commit, "items[].commit"),
          subject: str(item.subject, "items[].subject"),
          action: str(item.action, "items[].action") as rebasePlanner.RebasePlanItem["action"],
          newMessage: optStr(item.newMessage) ?? undefined,
        };
      }),
    }),

  search_commits: (body) =>
    insights.searchCommits(bodyPath(body), {
      query: str(body.query, "query"),
      limit: num(body.limit ?? 200, "limit"),
    }),
  commit_details: (body) => insights.commitDetails(bodyPath(body), str(body.commit, "commit")),
  commit_file_diff: (body) =>
    insights.commitFileDiff(bodyPath(body), str(body.commit, "commit"), str(body.file, "file")),
  history_change_stats: (body) =>
    insights.historyChangeStats(bodyPath(body), num(body.limit ?? 300, "limit")),
  compare_refs: (body) =>
    insights.compareRefs(
      bodyPath(body),
      str(body.left, "left"),
      str(body.right, "right"),
      num(body.limit ?? 100, "limit"),
    ),
  range_diff: (body) =>
    insights.rangeDiff(
      bodyPath(body),
      str(body.base, "base"),
      str(body.before, "before"),
      str(body.after, "after"),
    ),
  repository_health: (body) => insights.repositoryHealth(bodyPath(body), body.scanObjects === true),
  file_history: (body) =>
    insights.fileHistory(bodyPath(body), {
      file: str(body.file, "file"),
      followRenames: bool(body.followRenames, "followRenames"),
      allRefs: bool(body.allRefs, "allRefs"),
      limit: num(body.limit ?? 200, "limit"),
    }),
  line_history: (body) =>
    insights.lineHistory(
      bodyPath(body),
      str(body.file, "file"),
      num(body.start, "start"),
      num(body.end, "end"),
      num(body.limit ?? 100, "limit"),
    ),
  blame_file: (body) =>
    insights.blameFile(
      bodyPath(body),
      str(body.file, "file"),
      optStr(body.revision),
      bool(body.ignoreWhitespace ?? false, "ignoreWhitespace"),
      num(body.limit ?? 5000, "limit"),
    ),
  contributors: (body) =>
    insights.contributors(bodyPath(body), num(body.maxCommits ?? 20000, "maxCommits")),
  worktree_summaries: (body) => insights.worktreeSummaries(bodyPath(body)),

  // v6 git executor log (GitKraken RE §6): recent correlated git invocations.
  git_log: async (body) => recentGitCommands(num(body.limit ?? 200, "limit")),

  // Saga bridge (GitKraken RE §11.2): headless external-control surface.
  saga_invoke: async (body) => {
    const name = str(body.name, "name");
    const args = typeof body.args === "object" && body.args !== null ? (body.args as Record<string, unknown>) : {};
    return invokeServerSaga(name, args);
  },

  list_tags: (body) => repo.listTags(bodyPath(body)),
  create_tag: (body) =>
    repo.createTag(bodyPath(body), str(body.name, "name"), str(body.revision, "revision"), typeof body.message === "string" ? body.message : ""),
  delete_tag: (body) => repo.deleteTag(bodyPath(body), str(body.name, "name")),
  merge_branch: (body) =>
    gk.journaled(bodyPath(body), `Merge ${String(body.branch)}`, "keep", () => repo.mergeBranch(bodyPath(body), str(body.branch, "branch"), (body.strategy === "ff-only" ? "ff-only" : body.strategy === "squash" ? "squash" : "no-ff"))),
  working_tree_diff: (body) => repo.workingTreeDiff(bodyPath(body), str(body.file, "file")),
  unstaged_file_diff: (body) => repo.unstagedFileDiff(bodyPath(body), str(body.file, "file")),
  stage_hunks: (body) => repo.stageHunks(bodyPath(body), str(body.file, "file"), numArray(body.hunks, "hunks")),
  clean_untracked: (body) => repo.cleanUntracked(bodyPath(body), bool(body.dryRun ?? false, "dryRun")),
  list_tree: (body) =>
    repo.listTree(bodyPath(body), str(body.revision, "revision"), typeof body.dir === "string" ? body.dir : ""),
  file_at_revision: (body) =>
    repo.fileAtRevision(bodyPath(body), str(body.revision, "revision"), str(body.dir, "dir")),
  export_revision: (body) =>
    repo.exportRevision(bodyPath(body), str(body.revision, "revision"), str(body.destination, "destination")),
  create_patch: (body) =>
    repo.createPatch(bodyPath(body), str(body.from, "from"), typeof body.to === "string" ? body.to : ""),
  save_patch: (body) =>
    repo.savePatch(bodyPath(body), str(body.from, "from"), typeof body.to === "string" ? body.to : "", str(body.destination, "destination")),
  apply_patch: (body) =>
    repo.applyPatch(bodyPath(body), str(body.data, "data"), typeof body.dir === "string" ? body.dir : ""),
  commit_activity: (body) =>
    repo.commitActivity(bodyPath(body), num(body.days ?? 365, "days"), num(body.maxCommits ?? 200000, "maxCommits")),
  diff_revisions: (body) =>
    repo.diffRevisions(bodyPath(body), str(body.from, "from"), str(body.to, "to"), str(body.file, "file")),
  reference_groups: (body) => repo.listRefGroups(bodyPath(body)),

  repository_operation_state: (body) => operationState.repositoryOperationState(bodyPath(body)),
  control_repository_operation: (body) =>
    gk.journaled(bodyPath(body), `${String(body.action).replace(/^./, (c) => c.toUpperCase())} operation`, "keep", () =>
      operationState.controlRepositoryOperation(
        bodyPath(body),
        str(body.action, "action") as operationState.OperationAction,
      )),

  stage_paths: (body) => backend.stagePaths(bodyPath(body), strArray(body.files, "files")),
  unstage_paths: (body) => backend.unstagePaths(bodyPath(body), strArray(body.files, "files")),
  create_commit: (body) =>
    gk.journaled(bodyPath(body), body.amend === true ? "Amend commit" : "Commit", "soft", () =>
      body.amend === true || body.signoff === true || body.noVerify === true
        ? gk.commit(bodyPath(body), { message: typeof body.message === "string" ? body.message : "", amend: body.amend === true, signoff: body.signoff === true, noVerify: body.noVerify === true })
        : backend.createCommit(bodyPath(body), str(body.message, "message"))),
  draft_commit_message: (body) => {
    const mode = body.mode ?? "auto";
    if (mode !== "auto" && mode !== "rules" && mode !== "ollama") {
      throw new AppError("invalid", "draft mode must be auto, rules or ollama");
    }
    const style = body.style === "plain" ? "plain" : "conventional";
    return commitWriter.draftCommitMessage(bodyPath(body), mode, optStr(body.model), {
      style,
      issueReference: optStr(body.issueReference),
    });
  },
  fetch_repository: (body) =>
    backend.fetchRepository(bodyPath(body), {
      username: optStr(body.username),
      token: optStr(body.token),
    }),
  pull_repository: (body) => {
    const mode = typeof body.mode === "string" ? body.mode : "ff-only";
    if (mode !== "fetch" && mode !== "ff" && mode !== "ff-only" && mode !== "rebase") throw new AppError("invalid", "pull mode must be fetch, ff, ff-only or rebase");
    const recurse = body.recurseSubmodules === true;
    return gk.journaled(bodyPath(body), `Pull (${mode}${recurse ? ", with submodules" : ""})`, "keep", () => gk.pull(bodyPath(body), mode, validStreamId(body.streamId), recurse));
  },
  push_repository: (body) =>
    gk.push(bodyPath(body), { remote: optStr(body.remote), branch: optStr(body.branch), force: body.force === true, setUpstream: body.setUpstream === true, tags: body.tags === true, recurseSubmodules: body.recurseSubmodules === true, streamId: validStreamId(body.streamId) }),
  submodules_update_all: (body) =>
    gk.journaled(bodyPath(body), body.remote === true ? "Update submodules to remote tips" : "Initialize and update submodules", "keep", () => gk.updateSubmodules(bodyPath(body), { remote: body.remote === true, streamId: validStreamId(body.streamId) })),
  clone_repository: (body) =>
    backend.cloneRepository({
      url: str(body.url, "url"),
      destination: str(body.destination, "destination"),
      username: optStr(body.username),
      token: optStr(body.token),
      depth: typeof body.depth === "number" ? body.depth : null,
      filter: body.filter === "blob:none" || body.filter === "tree:0" ? body.filter : null,
      sparse: body.sparse === true,
      branch: optStr(body.branch),
      singleBranch: body.singleBranch === true,
      recurseSubmodules: body.recurseSubmodules !== false,
      lfs: body.lfs !== false,
    }),
  switch_branch: (body) => gk.journaled(bodyPath(body), `Checkout ${String(body.branch)}`, "keep", () => backend.switchBranch(bodyPath(body), str(body.branch, "branch"))),
  checkout_remote_branch: (body) => gk.journaled(bodyPath(body), `Checkout ${String(body.branch)}`, "keep", () => backend.checkoutRemoteBranch(bodyPath(body), str(body.branch, "branch"))),
  create_branch: (body) => gk.journaled(bodyPath(body), `Create branch ${String(body.branch)}`, "keep", () => backend.createBranch(bodyPath(body), str(body.branch, "branch"))),
  create_branch_at: (body) => gk.journaled(bodyPath(body), `Create branch ${String(body.branch)}`, "keep", () => backend.createBranchAt(bodyPath(body), str(body.branch, "branch"), str(body.revision, "revision"))),
  reset_to_commit: (body) => {
    const mode = body.mode;
    if (mode !== "soft" && mode !== "mixed" && mode !== "hard") throw new AppError("invalid", "reset mode must be soft, mixed or hard");
    return gk.journaled(bodyPath(body), `Reset ${mode} to ${String(body.revision).slice(0, 8)}`, "keep", () => backend.resetTo(bodyPath(body), str(body.revision, "revision"), mode));
  },
  delete_branch: (body) =>
    gk.journaled(bodyPath(body), `Delete branch ${String(body.branch)}`, "keep", () => repo.deleteBranch(bodyPath(body), str(body.branch, "branch"), body.force === true)),
  run_workflow: (body) => {
    const request = { operation: str(body.operation, "operation"), args: strArray(body.args ?? [], "args") };
    const journal = ["cherry_pick", "revert", "checkout_tag", "stash_pop", "continue", "abort", "skip"].includes(request.operation);
    return journal
      ? gk.journaled(bodyPath(body), request.operation.replace(/_/g, " "), "keep", () => backend.runWorkflow(bodyPath(body), request))
      : backend.runWorkflow(bodyPath(body), request);
  },


  // GitKraken parity: undo/redo journal, branch/tag/remote actions, WIP helpers.
  undo_state: (body) => gk.undoState(bodyPath(body)),
  undo_action: (body) => gk.undo(bodyPath(body)),
  redo_action: (body) => gk.redo(bodyPath(body)),
  last_commit_message: (body) => gk.lastCommitMessage(bodyPath(body)),
  discard_paths: (body) =>
    gk.discard(bodyPath(body), body.all === true ? null : strArray(body.files, "files")),
  branch_action: (body) =>
    gk.journaled(bodyPath(body), branchActionLabel(body), "keep", () =>
      gk.branchAction(bodyPath(body), {
        action: str(body.action, "action") as gk.BranchAction,
        branch: str(body.branch, "branch"),
        target: optStr(body.target),
        newName: optStr(body.newName),
        remote: optStr(body.remote),
      })),
  tag_action: (body) =>
    gk.tagAction(bodyPath(body), str(body.action, "action") as gk.TagAction, typeof body.name === "string" ? body.name : "", optStr(body.remote), { expect: typeof body.expect === "string" ? body.expect : null }),
  tag_remote_state: (body) => gk.tagRemoteState(bodyPath(body), str(body.name, "name"), optStr(body.remote)),
  remote_action: (body) =>
    gk.remoteAction(bodyPath(body), str(body.action, "action") as gk.RemoteAction, str(body.name, "name"), optStr(body.value)),
  commit_offset: (body) => gk.commitOffset(bodyPath(body), str(body.revision, "revision")),
  diff_commit_files: (body) => gk.diffCommitFiles(bodyPath(body), str(body.from, "from"), str(body.to, "to")),
  submodule_tree: (body) => submodules.submoduleTree(bodyPath(body)),
  lfs_status: (body) => lfs.lfsStatus(bodyPath(body)),
  lfs_check: (body) => lfs.lfsCheck(bodyPath(body)),
  lfs_auto: (body) => lfs.lfsAuto(bodyPath(body), { pull: body.pull !== false }),
  lfs_locks: (body) => lfs.lfsLocks(bodyPath(body)),
  lfs_action: (body) => {
    const action = str(body.action, "action");
    const files = Array.isArray(body.files) ? strArray(body.files, "files") : undefined;
    const pattern = typeof body.pattern === "string" ? body.pattern : "";
    const streamId = validStreamId(body.streamId);
    const request: lfs.LfsAction | null =
      action === "install" ? { action } :
      action === "track" ? { action, pattern, lockable: body.lockable === true } :
      action === "untrack" ? { action, pattern } :
      action === "convert" ? { action, files: files ?? [] } :
      action === "fetch" || action === "push" ? { action, all: body.all === true } :
      action === "pull" ? { action, files } :
      action === "prune" ? { action } :
      action === "lock" ? { action, files: files ?? [] } :
      action === "unlock" ? { action, files, id: optStr(body.id) ?? undefined, force: body.force === true } :
      null;
    if (!request) throw new AppError("invalid", `unknown LFS action ${action}`);
    const write = action !== "fetch" && action !== "push" && action !== "lock" && action !== "unlock";
    return write ? gk.journaled(bodyPath(body), `LFS ${action}`, "keep", () => lfs.lfsAction(bodyPath(body), request, streamId)) : lfs.lfsAction(bodyPath(body), request, streamId);
  },
  submodule_action: (body) => {
    const action = str(body.action, "action");
    if (!["init", "update", "update_remote", "sync", "fetch", "deinit"].includes(action)) throw new AppError("invalid", `unknown submodule action ${action}`);
    return submodules.submoduleAction(bodyPath(body), action as submodules.SubmoduleAction, typeof body.target === "string" ? body.target : "");
  },
  submodule_bulk: (body) => submodules.submoduleBulk(bodyPath(body), str(body.action, "action") as submodules.SubmoduleBulkAction, strArray(body.targets, "targets")),
  submodule_foreach: (body) => submodules.submoduleForeach(bodyPath(body), str(body.command, "command"), strArray(body.targets, "targets")),
  submodule_manifest: (body) => submodules.submoduleManifest(bodyPath(body)),
  // Codebase landscape map: one record per source file (imports, symbols, size).
  landscape_scan: (body) => landscapeScan(bodyPath(body), body.force === true),
  // Heatmap overlay: last commit, commit count and uncommitted edits per file.
  landscape_recent: (body) => landscapeRecent(bodyPath(body), typeof body.days === "number" ? body.days : 90),
  // Long-poll: resolves when the repository changes after version `since`.
  repository_wait_change: (body) => waitForChange(bodyPath(body), typeof body.since === "number" ? body.since : -1, currentRequestSignal(), typeof body.timeoutMs === "number" ? body.timeoutMs : undefined),
  superproject_chain: (body) => submodules.superprojectChain(bodyPath(body)),
  repository_trust: (body) => trust.checkTrust(bodyPath(body)),
  trust_repository: (body) => trust.trustRepository(bodyPath(body)),
  list_folders: (body) => folders.listFolders(typeof body.path === "string" ? body.path : null, body.showHidden === true),
  file_diff_side: (body) => lineStaging.sideDiff(bodyPath(body), str(body.file, "file"), body.side === "staged" ? "staged" : "unstaged"),
  apply_lines: (body) => {
    const mode = body.mode === "unstage" || body.mode === "discard" ? body.mode : "stage";
    const selection = (Array.isArray(body.selection) ? body.selection : []).map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      return { hunk: num(item.hunk, "selection[].hunk"), lines: numArray(item.lines ?? [], "selection[].lines") };
    });
    return lineStaging.applyLines(bodyPath(body), str(body.file, "file"), mode, selection, optStr(body.fingerprint));
  },
  stash_files: (body) => gk.stashFiles(bodyPath(body), str(body.ref, "ref")),

  // TortoiseGit explorer: overlays, context-menu actions, properties, diffs.
  explorer_list: (body) => explorer.listDirectory(bodyPath(body), typeof body.dir === "string" ? body.dir : ""),
  explorer_action: (body) => {
    const action = str(body.action, "action") as explorer.ExplorerAction;
    const request: explorer.ExplorerActionRequest = {
      action,
      files: strArray(body.files ?? [], "files"),
      message: typeof body.message === "string" ? body.message : undefined,
      newName: optStr(body.newName) ?? undefined,
      revision: optStr(body.revision) ?? undefined,
      scope: body.scope === "root" ? "root" : "local",
      cleanMode: body.cleanMode === "ignored" || body.cleanMode === "all" ? body.cleanMode : "untracked",
      dryRun: body.dryRun === true,
      amend: body.amend === true,
      destination: optStr(body.destination) ?? undefined,
    };
    const journal = action === "commit" || action === "checkout_revision";
    return journal
      ? gk.journaled(bodyPath(body), action === "commit" ? (request.amend ? "Amend commit" : "Commit") : "Revert to revision", action === "commit" ? "soft" : "keep", () => explorer.runAction(bodyPath(body), request))
      : explorer.runAction(bodyPath(body), request);
  },
  resolve_shell_paths: (body) => explorer.resolveShellPaths(strArray(body.paths, "paths")),
  explorer_properties: (body) => explorer.properties(bodyPath(body), typeof body.file === "string" ? body.file : ""),
  explorer_diff_files: (body) => explorer.diffTwoFiles(bodyPath(body), str(body.left, "left"), str(body.right, "right")),
  explorer_diff_previous: (body) => explorer.diffWithPrevious(bodyPath(body), str(body.file, "file")),
  explorer_patch: (body) => explorer.workingPatch(bodyPath(body), strArray(body.files, "files")),
  explorer_open: (body) => {
    if (!isLoopbackHost()) throw new AppError("unsupported", "opening files on the server host is only allowed when Chrono listens on localhost");
    const mode = body.mode === "reveal" ? "reveal" : body.mode === "terminal" ? "terminal" : "open";
    return explorer.openOnHost(bodyPath(body), typeof body.file === "string" ? body.file : "", mode);
  },


  // ---- Roadmap Tier 1 -------------------------------------------------------
  commit_signatures: (body) => features.signatures(bodyPath(body), strArray(body.commits, "commits")),
  signing_config: (body) => features.signingConfig(bodyPath(body)),
  set_signing_config: (body) => features.setSigningConfig(bodyPath(body), body.scope === "global" ? "global" : "local", {
    format: typeof body.format === "string" ? body.format : undefined,
    signingKey: typeof body.signingKey === "string" ? body.signingKey : undefined,
    commitSign: typeof body.commitSign === "boolean" ? body.commitSign : undefined,
    tagSign: typeof body.tagSign === "boolean" ? body.tagSign : undefined,
    allowedSignersFile: typeof body.allowedSignersFile === "string" ? body.allowedSignersFile : undefined,
  }),
  perf_status: (body) => features.perfStatus(bodyPath(body)),
  perf_apply: (body) => features.perfApply(bodyPath(body), str(body.action, "action") as features.PerfAction),
  search_advanced: (body) => features.advancedSearch(bodyPath(body), str(body.query, "query"), num(body.limit ?? 500, "limit")),
  hooks_list: (body) => features.listHooks(bodyPath(body)),
  hook_set_enabled: (body) => features.setHookEnabled(bodyPath(body), str(body.name, "name"), bool(body.enabled, "enabled")),
  commit_with_hooks: (body) =>
    gk.journaled(bodyPath(body), body.amend === true ? "Amend commit" : "Commit", "soft", () =>
      features.commitWithHooks(bodyPath(body), { message: typeof body.message === "string" ? body.message : "", amend: body.amend === true, signoff: body.signoff === true, noVerify: body.noVerify === true, streamId: validStreamId(body.streamId), identity: commitIdentity(body.identity) })),
  stream_read: async (body) => {
    const id = validStreamId(body.id);
    if (!id) throw new AppError("invalid", "invalid stream id");
    return readStream(id, typeof body.offset === "number" ? body.offset : 0);
  },
  autolinks_get: (body) => features.getAutolinks(bodyPath(body)),
  autolinks_set: (body) => features.setAutolinks(bodyPath(body), (Array.isArray(body.rules) ? body.rules : []).map((rule) => ({ pattern: String((rule as Record<string, unknown>).pattern ?? ""), url: String((rule as Record<string, unknown>).url ?? "") }))),
  commit_templates: (body) => features.commitTemplates(bodyPath(body)),
  commit_templates_save: (body) => features.saveCommitTemplates(Array.isArray(body.templates) ? body.templates as features.CommitTemplate[] : []),
  fork_point: (body) => features.forkPoint(bodyPath(body), optStr(body.branch), optStr(body.base)),

  // ---- Roadmap Tier 2 -------------------------------------------------------
  predict_conflicts: (body) => {
    const mode = body.mode === "cherry-pick" || body.mode === "revert" || body.mode === "rebase" ? body.mode : "merge";
    return features.predictConflicts(bodyPath(body), mode, str(body.source, "source"), optStr(body.target));
  },
  cleanup_candidates: (body) => features.cleanupCandidates(bodyPath(body), optStr(body.target), typeof body.staleDays === "number" ? body.staleDays : 90),
  cleanup_branches: (body) =>
    gk.journaled(bodyPath(body), `${body.mode === "delete" ? "Delete" : "Archive"} ${strArray(body.branches, "branches").length} branch(es)`, "keep", () =>
      features.archiveBranches(bodyPath(body), strArray(body.branches, "branches"), body.mode === "delete" ? "delete" : "archive")),
  archived_branches: (body) => features.archivedBranches(bodyPath(body)),
  restore_archived: (body) => gk.journaled(bodyPath(body), `Restore ${String(body.branch)}`, "keep", () => features.restoreArchived(bodyPath(body), str(body.branch, "branch"))),
  stack_parents: (body) => features.stackParents(bodyPath(body)),
  stack_set_parent: (body) => features.setStackParent(bodyPath(body), str(body.branch, "branch"), optStr(body.parent)),
  stack_create: (body) => gk.journaled(bodyPath(body), `Create stacked branch ${String(body.name)}`, "keep", () => features.createStackedBranch(bodyPath(body), str(body.parent, "parent"), str(body.name, "name"))),
  stack_restack: (body) => gk.journaled(bodyPath(body), `Restack ${String(body.branch)}`, "keep", () => features.restack(bodyPath(body), str(body.branch, "branch"))),
  // AI assistant: provider (Ollama / Claude / off), models, Claude API key (write-only).
  ai_settings: () => ai.getAiSettings(),
  ai_settings_save: async (body) => {
    const saved = await ai.saveAiSettings({
    provider: optStr(body.provider) ?? undefined,
    ollamaUrl: optStr(body.ollamaUrl) ?? undefined,
    ollamaModel: optStr(body.ollamaModel) ?? undefined,
    claudeModel: optStr(body.claudeModel) ?? undefined,
    claudeKey: body.claudeKey === null ? null : optStr(body.claudeKey) ?? undefined,
    netUrl: typeof body.netUrl === "string" ? body.netUrl : undefined,
    netModel: typeof body.netModel === "string" ? body.netModel : undefined,
    netKey: body.netKey === null ? null : optStr(body.netKey) ?? undefined,
    llamaBinary: typeof body.llamaBinary === "string" ? body.llamaBinary : undefined,
    modelsDir: optStr(body.modelsDir) ?? undefined,
    activeModel: typeof body.activeModel === "string" ? body.activeModel : undefined,
    port: typeof body.port === "number" ? body.port : undefined,
    contextSize: typeof body.contextSize === "number" ? body.contextSize : undefined,
    gpuLayers: body.gpuLayers === null ? null : typeof body.gpuLayers === "number" ? body.gpuLayers : undefined,
    lan: typeof body.lan === "boolean" ? body.lan : undefined,
    lanKey: body.lanKey === null ? null : optStr(body.lanKey) ?? undefined,
    autoStart: typeof body.autoStart === "boolean" ? body.autoStart : undefined,
    lockInRam: typeof body.lockInRam === "boolean" ? body.lockInRam : undefined,
    });
    // Load the newly chosen model ahead of the first question (and unload the old one).
    void ai.warmUpAi();
    return saved;
  },
  ai_test: () => ai.testAi(),
  // Forks and upstreams, for the repository and every submodule (path: "" or a submodule path).
  fork_tree: (body) => forks.forkTree(bodyPath(body)),
  fork_detect_parent: (body) => forks.detectParent(bodyPath(body), typeof body.sub === "string" ? body.sub : ""),
  fork_add_upstream: (body) => forks.addUpstream(bodyPath(body), typeof body.sub === "string" ? body.sub : "", str(body.url, "url"), optStr(body.name) ?? "upstream"),
  fork_sync: async (body) => {
    const sub = typeof body.sub === "string" ? body.sub : "";
    return gk.journaled(sub ? path.join(bodyPath(body), sub) : bodyPath(body), "Sync fork with upstream", "keep", () => forks.syncFork(bodyPath(body), sub, { push: body.push === true }));
  },
  fork_sync_all: (body) => forks.syncAllForks(bodyPath(body), { push: body.push === true }),
  fork_merge_upstream: async (body) => {
    const sub = typeof body.sub === "string" ? body.sub : "";
    return gk.journaled(sub ? path.join(bodyPath(body), sub) : bodyPath(body), "Merge upstream", "keep", () => forks.mergeUpstream(bodyPath(body), sub));
  },
  ai_network_models: (body) => ai.networkModels(str(body.url, "url"), optStr(body.key)),
  // Self-hosted llama.cpp: builds, models, downloads and the llama-server process.
  llm_status: async () => {
    const settings = await ai.readStored();
    return {
      paths: localLlm.llamaPaths(),
      platform: `${process.platform}-${process.arch}`,
      engines: await localLlm.listEngines(),
      binary: await localLlm.resolveBinary(settings),
      models: await localLlm.listModels(settings.modelsDir),
      modelsDir: settings.modelsDir,
      presets: localLlm.MODEL_PRESETS,
      jobs: localLlm.listJobs(),
      server: localLlm.serverState(),
    };
  },
  llm_engine_assets: () => localLlm.listEngineAssets(),
  llm_engine_install: (body) => localLlm.installEngine(str(body.asset, "asset")),
  llm_engine_remove: (body) => localLlm.removeEngine(str(body.id, "id")),
  llm_model_download: async (body) => localLlm.downloadModel((await ai.readStored()).modelsDir, str(body.url, "url"), optStr(body.name)),
  llm_model_delete: async (body) => localLlm.deleteModel((await ai.readStored()).modelsDir, str(body.name, "name")),
  llm_job_cancel: async (body) => localLlm.cancelJob(str(body.id, "id")),
  llm_server_start: async () => {
    try { await localLlm.startLlamaServer(await ai.readStored()); } catch (error) {
      if (error instanceof localLlm.AiUnavailableError) throw new AppError("invalid", error.message);
      throw error;
    }
    return localLlm.serverState();
  },
  llm_server_stop: async () => { await localLlm.stopLlamaServer(); return localLlm.serverState(); },
  llm_server_log: async () => localLlm.serverLog(),
  profiles_list: (body) => features.listProfiles(optStr(body.path)),
  profile_save: (body) => features.saveProfile({ name: str(body.name, "name"), userName: str(body.userName, "userName"), userEmail: str(body.userEmail, "userEmail"), signingKey: optStr(body.signingKey) ?? undefined, gpgFormat: optStr(body.gpgFormat) ?? undefined }),
  profile_delete: (body) => features.deleteProfile(str(body.name, "name")),
  profile_apply: (body) => features.applyProfile(optStr(body.path), str(body.name, "name"), body.scope === "folder" ? "folder" : "repo", optStr(body.folder)),
  profile_detach: (body) => features.detachProfile(bodyPath(body), str(body.name, "name")),
  custom_commands: async () => features.listCustomCommands(),
  custom_commands_save: (body) => features.saveCustomCommands(Array.isArray(body.commands) ? body.commands as features.CustomCommand[] : []),
  custom_command_run: (body) =>
    gk.journaled(bodyPath(body), `Run ${String(body.id)}`, "keep", () =>
      features.runCustomCommand(bodyPath(body), str(body.id, "id"), {
        sha: optStr(body.sha) ?? undefined,
        branch: optStr(body.branch) ?? undefined,
        files: Array.isArray(body.files) ? strArray(body.files, "files") : [],
        params: typeof body.params === "object" && body.params ? body.params as Record<string, string> : {},
      }, isLoopbackHost())),
  file_blob: (body) => features.fileBlob(bodyPath(body), str(body.revision, "revision"), str(body.file, "file")),
  remote_host: (body) => features.remoteHost(bodyPath(body), optStr(body.remote) ?? "origin"),
  pr_template: (body) => features.pullRequestTemplate(bodyPath(body)),
  pr_create: async (body) => {
    const host = await resolveHost(body);
    return features.createPullRequest(host, await hosting.resolveToken(body.token, host.host), {
      head: str(body.head, "head"), base: str(body.base, "base"), title: str(body.title, "title"),
      body: typeof body.description === "string" ? body.description : "", draft: body.draft === true,
    });
  },
  ci_checks: async (body) => { const host = await resolveHost(body); return features.ciChecks(host, await hosting.resolveToken(body.token, host.host), str(body.sha, "sha")); },
  // CI monitoring for every provider (server/src/ci.ts).
  ci_runs: async (body) => {
    const host = await resolveHost(body);
    return ci.ciRuns(await repositoryRootOf(body), host, await hosting.resolveToken(body.token, host.host), { branch: optStr(body.branch), workflowId: optStr(body.workflowId), page: typeof body.page === "number" ? body.page : 1, limit: typeof body.limit === "number" ? body.limit : 30 });
  },
  ci_latest: async (body) => { const host = await resolveHost(body); return ci.ciLatest(await repositoryRootOf(body), host, await hosting.resolveToken(body.token, host.host), str(body.branch, "branch")); },
  ci_jobs: async (body) => { const host = await resolveHost(body); return ci.ciRunJobs(await repositoryRootOf(body), host, await hosting.resolveToken(body.token, host.host), str(body.runId, "runId")); },
  ci_log: async (body) => { const host = await resolveHost(body); return ci.ciJobLog(host, await hosting.resolveToken(body.token, host.host), str(body.runId, "runId"), str(body.jobId, "jobId")); },
  ci_run_action: async (body) => {
    const host = await resolveHost(body);
    const action = str(body.action, "action");
    if (!["rerun", "rerun_failed", "cancel", "rerun_job", "play_job"].includes(action)) throw new AppError("invalid", `unknown CI action ${action}`);
    return ci.ciRunAction(host, await hosting.resolveToken(body.token, host.host), action as ci.CiRunAction, str(body.runId, "runId"), optStr(body.jobId));
  },
  ci_workflows: async (body) => { const host = await resolveHost(body); return ci.ciWorkflows(await repositoryRootOf(body), host, await hosting.resolveToken(body.token, host.host)); },
  ci_dispatch: async (body) => {
    const host = await resolveHost(body);
    const inputs = body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs) ? Object.fromEntries(Object.entries(body.inputs as Record<string, unknown>).map(([key, value]) => [key, String(value)])) : {};
    return ci.ciDispatch(host, await hosting.resolveToken(body.token, host.host), { workflowId: str(body.workflowId, "workflowId"), ref: str(body.ref, "ref"), inputs });
  },
  ci_rerun: async (body) => { const host = await resolveHost(body); return features.rerunCheck(host, await hosting.resolveToken(body.token, host.host), body.check as features.CheckRun); },
  hosting_connections: async () => hosting.listConnections(),
  gh_account: async (body) => { const server = await githubServer(body); return github.account(server.apiBase, server.token); },
  gh_token_page: async (body) => github.tokenPageUrl(str(body.apiBase, "apiBase")),
  gh_repos: async (body) => { const server = await githubServer(body); return github.myRepositories(server.apiBase, server.token); },
  gh_ssh_keys: async (body) => { const server = await githubServer(body); return github.sshKeys(server.apiBase, server.token); },
  gh_ssh_upload: async (body) => { if (!isLoopbackHost()) throw new AppError("invalid", "SSH keys can only be managed from the computer running Chrono"); const server = await githubServer(body); await github.uploadSshKey(server.apiBase, server.token, str(body.keyPath, "keyPath"), optStr(body.title) ?? ""); return null; },
  gh_ssh_generate: async (body) => { if (!isLoopbackHost()) throw new AppError("invalid", "SSH keys can only be managed from the computer running Chrono"); const server = await githubServer(body); return github.generateSshKey(server.apiBase, server.token, str(body.gitHost, "gitHost"), body.writeConfig === true); },
  gh_forks: async (body) => { const { host, token } = await githubRepo(body); return github.forks(host, token); },
  gh_fork_create: async (body) => { const { host, token } = await githubRepo(body); return github.createFork(host, token, optStr(body.organization) ?? undefined); },
  gh_pulls: async (body) => { const { host, token } = await githubRepo(body); return github.openPulls(host, token); },
  gh_pull: async (body) => { const { host, token } = await githubRepo(body); return github.pullDetail(host, token, body.number); },
  gh_pull_update: async (body) => {
    const { host, token } = await githubRepo(body);
    const patch = (typeof body.patch === "object" && body.patch ? body.patch : {}) as Record<string, unknown>;
    const pullPatch: { title?: string; body?: string; state?: "open" | "closed" } = {};
    if (typeof patch.title === "string") pullPatch.title = patch.title;
    if (typeof patch.body === "string") pullPatch.body = patch.body;
    if (patch.state === "open" || patch.state === "closed") pullPatch.state = patch.state;
    if (Object.keys(pullPatch).length) await github.updatePull(host, token, body.number, pullPatch);
    const fields: { labels?: string[]; assignees?: string[]; milestone?: number | null } = {};
    if (Array.isArray(patch.labels)) fields.labels = strList(patch.labels);
    if (Array.isArray(patch.assignees)) fields.assignees = strList(patch.assignees);
    if (patch.milestone === null || typeof patch.milestone === "number") fields.milestone = patch.milestone as number | null;
    if (Object.keys(fields).length) await github.updateIssueFields(host, token, body.number, fields);
    if (Array.isArray(patch.addReviewers) || Array.isArray(patch.removeReviewers)) await github.setReviewers(host, token, body.number, strList(patch.addReviewers), strList(patch.removeReviewers));
    return null;
  },
  gh_comment: async (body) => { const { host, token } = await githubRepo(body); await github.comment(host, token, body.number, typeof body.body === "string" ? body.body : ""); return null; },
  gh_review: async (body) => { const { host, token } = await githubRepo(body); await github.review(host, token, body.number, str(body.event, "event"), typeof body.body === "string" ? body.body : ""); return null; },
  gh_merge: async (body) => { const { host, token } = await githubRepo(body); return github.merge(host, token, body.number, str(body.method, "method"), optStr(body.title) ?? undefined, optStr(body.message) ?? undefined); },
  gh_pull_checkout: (body) => gk.journaled(bodyPath(body), `Check out pull request #${String(body.number)}`, "keep", () => github.checkoutPull(bodyPath(body), optStr(body.remote) ?? "origin", { number: Number(body.number), headRef: str(body.headRef, "headRef"), sameRepo: body.sameRepo === true })),
  gh_issues: async (body) => { const { host, token } = await githubRepo(body); return github.searchIssues(host, token, typeof body.query === "string" ? body.query : ""); },
  gh_issue: async (body) => { const { host, token } = await githubRepo(body); return github.issueDetail(host, token, body.number); },
  gh_issue_update: async (body) => {
    const { host, token } = await githubRepo(body);
    const patch = (typeof body.patch === "object" && body.patch ? body.patch : {}) as Record<string, unknown>;
    const fields: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[]; assignees?: string[]; milestone?: number | null } = {};
    if (typeof patch.title === "string") fields.title = patch.title;
    if (typeof patch.body === "string") fields.body = patch.body;
    if (patch.state === "open" || patch.state === "closed") fields.state = patch.state;
    if (Array.isArray(patch.labels)) fields.labels = strList(patch.labels);
    if (Array.isArray(patch.assignees)) fields.assignees = strList(patch.assignees);
    if (patch.milestone === null || typeof patch.milestone === "number") fields.milestone = patch.milestone as number | null;
    await github.updateIssueFields(host, token, body.number, fields);
    return null;
  },
  gh_issue_create: async (body) => { const { host, token } = await githubRepo(body); return github.createIssue(host, token, { title: str(body.title, "title"), body: typeof body.body === "string" ? body.body : "", labels: strList(body.labels), assignees: strList(body.assignees) }); },
  gh_repo_options: async (body) => { const { host, token } = await githubRepo(body); return github.repoOptions(host, token); },
  gh_issue_branch: (body) => gk.journaled(bodyPath(body), `Create branch ${String(body.name)}`, "keep", () => github.branchForIssue(bodyPath(body), str(body.name, "name"), optStr(body.base) ?? "HEAD", str(body.issueUrl, "issueUrl"))),
  gh_issue_branches: (body) => github.issueBranches(bodyPath(body)),
  hosting_connection_save: (body) => hosting.saveConnection(str(body.host, "host"), {
    insecureTls: typeof body.insecureTls === "boolean" ? body.insecureTls : undefined,
    caFile: typeof body.caFile === "string" ? body.caFile : undefined,
    timeoutSeconds: typeof body.timeoutSeconds === "number" ? body.timeoutSeconds : undefined,
    gitUsername: typeof body.gitUsername === "string" ? body.gitUsername : undefined,
    token: body.token === null ? null : typeof body.token === "string" ? body.token : undefined,
  }),
  hosting_connection_remove: async (body) => { await hosting.removeConnection(str(body.host, "host")); return null; },
  hosting_connection_test: async (body) => hosting.testConnection(str(body.provider, "provider"), str(body.apiBase, "apiBase"), await hosting.resolveToken(body.token, str(body.host, "host"))),

  // ---- Roadmap Tier 3 -------------------------------------------------------
  agent_worktree_create: (body) => features.createAgentWorktree(bodyPath(body), str(body.name, "name"), optStr(body.base) ?? "HEAD", optStr(body.location)),
  agent_worktree_remove: (body) => features.removeAgentWorktree(bodyPath(body), str(body.worktree, "worktree"), body.deleteBranch === true, body.force === true),
  gitflow_config: (body) => features.gitflowConfig(bodyPath(body)),
  gitflow_init: (body) => features.gitflowInit(bodyPath(body), (typeof body.config === "object" && body.config ? body.config : {}) as Partial<features.GitflowConfig>),
  gitflow_start: (body) => gk.journaled(bodyPath(body), `Start ${String(body.type)} ${String(body.name)}`, "keep", () => features.gitflowStart(bodyPath(body), str(body.type, "type") as features.FlowType, str(body.name, "name"), optStr(body.base))),
  gitflow_finish: (body) => gk.journaled(bodyPath(body), `Finish ${String(body.type)} ${String(body.name)}`, "keep", () => features.gitflowFinish(bodyPath(body), str(body.type, "type") as features.FlowType, str(body.name, "name"), { tagMessage: optStr(body.tagMessage) ?? undefined, keepBranch: body.keepBranch === true })),
  ai_explain: (body) => {
    const kind = body.kind === "branch" || body.kind === "working" || body.kind === "pr" ? body.kind : "commit";
    return features.explain(bodyPath(body), kind, optStr(body.ref), optStr(body.base));
  },
  repo_treemap: (body) => features.repoTreemap(bodyPath(body), optStr(body.revision) ?? "HEAD", typeof body.days === "number" ? body.days : 90),
  sparse_status: (body) => features.sparseStatus(bodyPath(body)),
  sparse_action: (body) => {
    const action = body.action === "add" || body.action === "reapply" || body.action === "disable" ? body.action : "set";
    return features.sparseAction(bodyPath(body), action, strArray(body.patterns ?? [], "patterns"));
  },
  notes_get: (body) => features.notesGet(bodyPath(body), str(body.commit, "commit"), optStr(body.ref) ?? "commits"),
  notes_set: (body) => features.notesSet(bodyPath(body), str(body.commit, "commit"), typeof body.text === "string" ? body.text : "", optStr(body.ref) ?? "commits"),

  load_workspaces: async () => loadWorkspaces(),
  save_workspaces: async (body) => {
    if (!Array.isArray(body.workspaces)) {
      throw new AppError("invalid", "missing or invalid field: workspaces");
    }
    await saveWorkspaces(body.workspaces as Workspace[]);
    return null;
  },

  list_pull_requests: async (body) =>
    listPullRequests(
      str(body.provider, "provider"),
      str(body.baseUrl, "baseUrl"),
      str(body.owner, "owner"),
      str(body.repository, "repository"),
      // No token typed: use the one remembered for this server, if any.
      await hosting.resolveToken(body.token, optStr(body.host) || str(body.baseUrl, "baseUrl")),
    ),
};

// ---------------------------------------------------------------------------
// Static frontend serving (production: dist/, plus public/ assets)
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

async function serveStatic(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) return false;
  const requested = decodeURIComponent(url.pathname);

  const candidates: string[] = [];
  const dist = path.join(projectRoot, "dist");
  const publicDir = path.join(projectRoot, "public");
  candidates.push(path.normalize(path.join(dist, requested)));
  candidates.push(path.normalize(path.join(publicDir, requested)));

  for (const candidate of candidates) {
    const root = candidate.startsWith(dist) ? dist : publicDir;
    if (!candidate.startsWith(root + path.sep) && candidate !== root) continue;
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) continue;
      const bytes = await readFile(candidate);
      const type = MIME_TYPES[path.extname(candidate).toLowerCase()] ?? "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Length": bytes.length,
        "Cache-Control": "no-cache",
      });
      response.end(bytes);
      return true;
    } catch {
      // fall through to next candidate
    }
  }

  // SPA fallback: index.html for extension-less navigation paths.
  if (!path.extname(requested)) {
    try {
      const index = await readFile(path.join(dist, "index.html"));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": index.length });
      response.end(index);
      return true;
    } catch {
      // no dist yet — dev mode; let it fall through to the 404.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.length,
  });
  response.end(bytes);
}

// Run one API command. `signal` is the client's "no longer needed" signal; it
// only reaches git for read routes (see READ_ROUTES).
async function dispatchCommand(command: string, body: Record<string, unknown>, signal: AbortSignal | null): Promise<unknown> {
  const handler = routes[command];
  if (!handler) throw new AppError("invalid", `unknown API command: ${command}`);
  const run = () => DIFF_VIEW_ROUTES.has(command) && body.diffOptions && typeof body.diffOptions === "object"
    ? withDiffOptions(body.diffOptions as DiffOptions, () => handler(body))
    : handler(body);
  return signal && READ_ROUTES.has(command) ? withAbortSignal(signal, run) : run();
}

async function handleApi(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  command: string,
): Promise<void> {
  if (!routes[command] || request.method !== "POST") {
    sendJson(response, 404, { error: `unknown API command: ${command}` });
    return;
  }
  const abandoned = new AbortController();
  const onClose = () => { if (!response.writableFinished) abandoned.abort(); };
  response.once("close", onClose);
  try {
    const body = await readJsonBody(request);
    const result = await dispatchCommand(command, body, abandoned.signal);
    if (abandoned.signal.aborted) return;
    sendJson(response, 200, { ok: true, result });
  } catch (error) {
    if (response.destroyed) return; // the client is gone (abandoned read)
    sendJson(response, statusCodeFor(error), { ok: false, error: (error as Error).message });
  } finally {
    response.off("close", onClose);
  }
}

const server = http.createServer((request, response) => {
  const origin = request.headers.origin;
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (request.method === "OPTIONS") { response.writeHead(ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN ? 204 : 403); response.end(); return; }
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, result: { name: "chrono-next-server", uptime: process.uptime() } });
    return;
  }
  const match = url.pathname.match(/^\/api\/([a-z0-9_]+)\/?$/);
  if (match) {
    const reason = rejectReason(request, guard, "api");
    if (reason) { sendJson(response, reason.includes("token") ? 401 : 403, { ok: false, error: reason }); return; }
    void handleApi(request, response, match[1]);
    return;
  }
  void serveStatic(request, response).then((served) => {
    if (!served) sendJson(response, 404, { error: `not found: ${url.pathname}` });
  });
});

// v6 integrated terminal (GitKraken RE §TerminalPanel): PTY sessions over WebSocket.
attachTerminalServer(server, (request) => rejectReason(request, guard, "websocket"));
// All API calls over one multiplexed socket (no per-host connection limit).
attachRpcServer(server, (request) => rejectReason(request, guard, "websocket"), dispatchCommand);

// Binding to a network interface without a token would hand git, custom
// commands and a shell to anyone who can reach the port.
if (!isLoopbackHost() && !API_TOKEN && process.env.CHRONO_ALLOW_INSECURE_REMOTE !== "1") {
  console.error(`Refusing to listen on ${HOST} without CHRONO_API_TOKEN. Set a token (or CHRONO_ALLOW_INSECURE_REMOTE=1 on a trusted, isolated network).`);
  process.exit(2);
}

server.listen(PORT, HOST, () => {
  console.log(`Chrono Next API listening on http://${HOST}:${PORT}`);
  // Load the local AI model now, so the first question does not wait for it.
  if (process.env.CHRONO_NO_AI_PRELOAD !== "1") void ai.warmUpAi();
});

// Orderly shutdown: unload the local AI model (stop llama-server, tell Ollama
// to drop it), then exit. Crashes are covered by localLlm.ts's watchdog and
// Ollama's keep-alive lease.
let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${reason})`);
  setTimeout(() => process.exit(0), 5000).unref(); // never hang on the way out
  server.close();
  await ai.shutdownAi().catch(() => undefined);
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void shutdown(signal));
// The desktop app keeps a pipe on our stdin and closes it to ask us to stop.
// It also closes when the app itself crashes, so that unloads the model too.
if (process.env.CHRONO_PARENT_PIPE === "1") {
  process.stdin.on("end", () => void shutdown("desktop app closed"));
  process.stdin.on("error", () => void shutdown("desktop app gone"));
  process.stdin.resume();
}

export default server;

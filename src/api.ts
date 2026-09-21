import type {
  AuthRequest,
  BranchRecord,
  CloneRequest,
  CommandResult,
  ConflictFileDetail,
  ConflictFileSummary,
  ConflictResolutionRequest,
  ConflictResolutionResult,
  CommitRecord,
  HistoryPage,
  FileChange,
  CommitFileDiff,
  TagRecord,
  WorkingTreeDiff,
  RevisionDiff,
  TreeEntry,
  FileAtRevision,
  PatchExport,
  ActivityDay,
  PullRequestRecord,
  BlameResult,
  CommitDetails,
  CommitDraft,
  CommitDraftMode,
  CommitDraftOptions,
  CommitSearchResult,
  ContributorRecord,
  FileHistoryRequest,
  HistoryChangeStat,
  RebasePlan,
  RebaseStartRequest,
  RebaseStartResult,
  RefComparison,
  RangeDiffResult,
  RefGroups,
  RepositoryHealth,
  WorktreeSummary,
  RepositoryOperationAction,
  RepositoryOperationState,
  RepositorySummary,
  RemoteRecord,
  ResetMode,
  WorkflowRequest,
  Workspace,
} from "./types";

const API_URL_KEY = "chrono.apiUrl";
const API_TOKEN_KEY = "chrono.apiToken";
export const getApiConnection = () => ({ url: localStorage.getItem(API_URL_KEY) ?? "", token: localStorage.getItem(API_TOKEN_KEY) ?? "" });
export function saveApiConnection(connection: { url: string; token: string }): void {
  const url = connection.url.trim().replace(/\/$/, "");
  if (url && !/^https?:\/\//i.test(url)) throw new Error("Backend URL must start with https:// or http://");
  localStorage.setItem(API_URL_KEY, url); localStorage.setItem(API_TOKEN_KEY, connection.token.trim());
}

// HTTP transport for the TypeScript backend.
//
// Each former Tauri `invoke("<command>", { ... })` call now POSTs to
// `/api/<command>` with the same field names (Tauri uses camelCase for nested
// objects and snake_case for top-level command arguments; the server accepts
// both where the shapes differ). The `{ ok, result | error }` envelope is
// unwrapped here so call sites look identical to the old `invoke` calls.

async function invoke<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const connection = getApiConnection();
  const response = await fetch(`${connection.url}/api/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}) },
    body: JSON.stringify(payload),
  });
  let body: { ok: boolean; result?: T; error?: string } | null = null;
  try {
    body = (await response.json()) as { ok: boolean; result?: T; error?: string };
  } catch {
    // non-JSON body (e.g. a 404 from a misrouted request)
  }
  if (!response.ok || !body || body.ok === false) {
    const message = body?.error ?? `request failed (${response.status})`;
    throw new Error(message);
  }
  return body.result as T;
}

export const api = {
  summary: (path: string) => invoke<RepositorySummary>("repository_summary", { path }),
  remotes: (path: string) => invoke<RemoteRecord[]>("repository_remotes", { path }),
  history: (path: string, limit = 300) => invoke<CommitRecord[]>("repository_history", { path, limit }),
  historyPage: (path: string, cursor: string | null = null, limit = 300) =>
    invoke<HistoryPage>("repository_history_page", { path, cursor, limit }),
  historyQuery: (path: string, request: { query: string; mode: "message" | "author" | "path"; limit?: number }) =>
    invoke<CommitRecord[]>("history_query", { path, ...request }),
  status: (path: string) => invoke<FileChange[]>("repository_status", { path }),
  branches: (path: string) => invoke<BranchRecord[]>("repository_branches", { path }),
  conflicts: (path: string) => invoke<ConflictFileSummary[]>("repository_conflicts", { path }),
  conflictDetail: (path: string, file: string) => invoke<ConflictFileDetail>("conflict_detail", { path, file }),
  resolveConflict: (path: string, request: ConflictResolutionRequest) =>
    invoke<ConflictResolutionResult>("resolve_conflict", { path, ...request }),
  prepareRebase: (path: string, target: string) => invoke<RebasePlan>("prepare_rebase_plan", { path, target }),
  startRebase: (path: string, request: RebaseStartRequest) => invoke<RebaseStartResult>("start_rebase_plan", { path, ...request }),
  searchCommits: (path: string, query: string, limit = 200) =>
    invoke<CommitSearchResult>("search_commits", { path, query, limit }),
  commitDetails: (path: string, commit: string) => invoke<CommitDetails>("commit_details", { path, commit }),
  commitFileDiff: (path: string, commit: string, file: string) =>
    invoke<CommitFileDiff>("commit_file_diff", { path, commit, file }),
  listTags: (path: string) => invoke<TagRecord[]>("list_tags", { path }),
  refGroups: (path: string) => invoke<RefGroups>("reference_groups", { path }),
  createTag: (path: string, name: string, revision: string, message: string) =>
    invoke<CommandResult>("create_tag", { path, name, revision, message }),
  deleteTag: (path: string, name: string) => invoke<CommandResult>("delete_tag", { path, name }),
  mergeBranch: (path: string, branch: string, strategy: "no-ff" | "squash" | "ff-only") =>
    invoke<CommandResult>("merge_branch", { path, branch, strategy }),
  workingTreeDiff: (path: string, file: string) => invoke<WorkingTreeDiff>("working_tree_diff", { path, file }),
  unstagedFileDiff: (path: string, file: string) => invoke<WorkingTreeDiff>("unstaged_file_diff", { path, file }),
  stageHunks: (path: string, file: string, hunks: number[]) => invoke<CommandResult>("stage_hunks", { path, file, hunks }),
  cleanUntracked: (path: string, dryRun: boolean) => invoke<CommandResult>("clean_untracked", { path, dryRun }),
  listTree: (path: string, revision: string, dirPath: string) =>
    invoke<TreeEntry[]>("list_tree", { path, revision, dir: dirPath }),
  fileAtRevision: (path: string, revision: string, filePath: string) =>
    invoke<FileAtRevision>("file_at_revision", { path, revision, dir: filePath }),
  exportRevision: (path: string, revision: string, destination: string) =>
    invoke<CommandResult>("export_revision", { path, revision, destination }),
  createPatch: (path: string, from: string, to: string) => invoke<PatchExport>("create_patch", { path, from, to }),
  savePatch: (path: string, from: string, to: string, destination: string) =>
    invoke<string>("save_patch", { path, from, to, destination }),
  applyPatch: (path: string, data: string, dir: string) => invoke<CommandResult>("apply_patch", { path, data, dir }),
  commitActivity: (path: string, days: number) => invoke<ActivityDay[]>("commit_activity", { path, days }),
  diffRevisions: (path: string, from: string, to: string, file: string) =>
    invoke<RevisionDiff>("diff_revisions", { path, from, to, file }),
  historyStats: (path: string, limit = 300) => invoke<HistoryChangeStat[]>("history_change_stats", { path, limit }),
  compareRefs: (path: string, left: string, right: string, limit = 100) =>
    invoke<RefComparison>("compare_refs", { path, left, right, limit }),
  rangeDiff: (path: string, base: string, before: string, after: string) =>
    invoke<RangeDiffResult>("range_diff", { path, base, before, after }),
  repositoryHealth: (path: string, scanObjects = false) =>
    invoke<RepositoryHealth>("repository_health", { path, scanObjects }),
  fileHistory: (path: string, request: FileHistoryRequest) =>
    invoke<CommitRecord[]>("file_history", { path, ...request }),
  lineHistory: (path: string, file: string, start: number, end: number, limit = 100) =>
    invoke<CommitRecord[]>("line_history", { path, file, start, end, limit }),
  blameFile: (path: string, file: string, revision: string | null = null, ignoreWhitespace = false, limit = 5000) =>
    invoke<BlameResult>("blame_file", { path, file, revision, ignoreWhitespace, limit }),
  contributors: (path: string, maxCommits = 20000) => invoke<ContributorRecord[]>("contributors", { path, maxCommits }),
  worktreeSummaries: (path: string) => invoke<WorktreeSummary[]>("worktree_summaries", { path }),
  operationState: (path: string) => invoke<RepositoryOperationState>("repository_operation_state", { path }),
  controlOperation: (path: string, action: RepositoryOperationAction) =>
    invoke<CommandResult>("control_repository_operation", { path, action }),
  stage: (path: string, files: string[]) => invoke<void>("stage_paths", { path, files }),
  unstage: (path: string, files: string[]) => invoke<void>("unstage_paths", { path, files }),
  commit: (path: string, message: string) => invoke<string>("create_commit", { path, message }),
  draftCommit: (path: string, mode: CommitDraftMode = "auto", model?: string, options: CommitDraftOptions = {}) =>
    invoke<CommitDraft>("draft_commit_message", { path, mode, ...(model ? { model } : {}), ...options }),
  fetch: (path: string, auth: AuthRequest = {}) => invoke<CommandResult>("fetch_repository", { path, ...auth }),
  pull: (path: string) => invoke<CommandResult>("pull_repository", { path }),
  push: (path: string, auth: AuthRequest = {}) => invoke<CommandResult>("push_repository", { path, ...auth }),
  clone: (request: CloneRequest) => invoke<RepositorySummary>("clone_repository", request),
  switchBranch: (path: string, branch: string) => invoke<void>("switch_branch", { path, branch }),
  checkoutRemoteBranch: (path: string, branch: string) => invoke<void>("checkout_remote_branch", { path, branch }),
  createBranch: (path: string, branch: string) => invoke<void>("create_branch", { path, branch }),
  createBranchAt: (path: string, branch: string, revision: string) => invoke<void>("create_branch_at", { path, branch, revision }),
  resetTo: (path: string, revision: string, mode: ResetMode) => invoke<CommandResult>("reset_to_commit", { path, revision, mode }),
  deleteBranch: (path: string, branch: string, force: boolean) =>
    invoke<string>("delete_branch", { path, branch, force }),
  workflow: (path: string, request: WorkflowRequest) => invoke<CommandResult>("run_workflow", { path, ...request }),
  loadWorkspaces: () => invoke<Workspace[]>("load_workspaces", {}),
  saveWorkspaces: (workspaces: Workspace[]) => invoke<void>("save_workspaces", { workspaces }),
  pullRequests: (
    provider: string,
    baseUrl: string,
    owner: string,
    repository: string,
    token: string,
  ) => invoke<PullRequestRecord[]>("list_pull_requests", { provider, baseUrl, owner, repository, token }),
};

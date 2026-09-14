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
  FileChange,
  PullRequestRecord,
  BlameResult,
  CommitDetails,
  CommitSearchResult,
  ContributorRecord,
  FileHistoryRequest,
  HistoryChangeStat,
  RebasePlan,
  RebaseStartRequest,
  RebaseStartResult,
  RefComparison,
  WorktreeSummary,
  RepositoryOperationAction,
  RepositoryOperationState,
  RepositorySummary,
  WorkflowRequest,
  Workspace,
} from "./types";

// HTTP transport for the TypeScript backend.
//
// Each former Tauri `invoke("<command>", { ... })` call now POSTs to
// `/api/<command>` with the same field names (Tauri uses camelCase for nested
// objects and snake_case for top-level command arguments; the server accepts
// both where the shapes differ). The `{ ok, result | error }` envelope is
// unwrapped here so call sites look identical to the old `invoke` calls.

async function invoke<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/api/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  history: (path: string, limit = 300) => invoke<CommitRecord[]>("repository_history", { path, limit }),
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
  historyStats: (path: string, limit = 300) => invoke<HistoryChangeStat[]>("history_change_stats", { path, limit }),
  compareRefs: (path: string, left: string, right: string, limit = 100) =>
    invoke<RefComparison>("compare_refs", { path, left, right, limit }),
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
  fetch: (path: string, auth: AuthRequest = {}) => invoke<CommandResult>("fetch_repository", { path, ...auth }),
  pull: (path: string) => invoke<CommandResult>("pull_repository", { path }),
  push: (path: string, auth: AuthRequest = {}) => invoke<CommandResult>("push_repository", { path, ...auth }),
  clone: (request: CloneRequest) => invoke<RepositorySummary>("clone_repository", request),
  switchBranch: (path: string, branch: string) => invoke<void>("switch_branch", { path, branch }),
  createBranch: (path: string, branch: string) => invoke<void>("create_branch", { path, branch }),
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

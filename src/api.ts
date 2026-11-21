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
  GitLogEntry,
  CommitFileChange,
  PullMode,
  PushOptions,
  CommitOptions,
  UndoState,
  BranchActionRequest,
  TagAction,
  RemoteAction,
  StashFile,
  ExplorerListing,
  ExplorerActionRequest,
  ExplorerActionResult,
  ExplorerProperties,
  FilePairDiff,
  PreviousVersionDiff,
  SignatureInfo,
  SigningConfig,
  PerfStatus,
  PerfAction,
  HookInfo,
  HookCommitResult,
  AutolinkRule,
  CommitTemplate,
  ForkPointInfo,
  ConflictPrediction,
  CleanupCandidate,
  IdentityProfile,
  CustomCommand,
  FileBlob,
  RemoteHost,
  CheckRun,
  GitflowConfig,
  FlowType,
  ExplainKind,
  DiffOptions,
  CloneOptions,
  DiffSide,
  LineMode,
  SideDiff,
  SubmoduleAction,
  SubmoduleTree,
} from "./types";

// Diff display options (Settings → Display) are attached to diff viewer calls.
const DIFF_OPTIONS_KEY = "chrono.diffOptions";
export function getDiffOptions(): DiffOptions {
  try { return JSON.parse(localStorage.getItem(DIFF_OPTIONS_KEY) ?? "{}") as DiffOptions; } catch { return {}; }
}
export function setDiffOptions(options: DiffOptions): void {
  localStorage.setItem(DIFF_OPTIONS_KEY, JSON.stringify(options));
  window.dispatchEvent(new CustomEvent("chrono:diff-options"));
}
const DIFF_ROUTES = new Set(["working_tree_diff", "commit_file_diff", "diff_revisions", "explorer_diff_files", "explorer_diff_previous"]);

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
    body: JSON.stringify(DIFF_ROUTES.has(command) ? { ...payload, diffOptions: getDiffOptions() } : payload),
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
  commit: (path: string, message: string, options: CommitOptions = {}) => invoke<string>("create_commit", { path, message, ...options }),
  draftCommit: (path: string, mode: CommitDraftMode = "auto", model?: string, options: CommitDraftOptions = {}) =>
    invoke<CommitDraft>("draft_commit_message", { path, mode, ...(model ? { model } : {}), ...options }),
  fetch: (path: string, auth: AuthRequest = {}) => invoke<CommandResult>("fetch_repository", { path, ...auth }),
  pull: (path: string, mode: PullMode = "ff-only", streamId?: string) => invoke<CommandResult>("pull_repository", { path, mode, streamId }),
  streamRead: (id: string, offset: number) => invoke<{ text: string; offset: number; done: boolean; exitCode: number | null }>("stream_read", { id, offset }),
  push: (path: string, options: PushOptions & AuthRequest = {}) => invoke<CommandResult>("push_repository", { path, ...options }),
  clone: (request: CloneRequest & CloneOptions) => invoke<RepositorySummary>("clone_repository", request),
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
  // v6 saga bridge (GitKraken RE §11.2): external-control surface for deep links / CLI / Electron IPC.
  invokeSaga: (name: string, args: Record<string, unknown> = {}) =>
    invoke<{ ok: boolean; result?: unknown; error?: string }>("saga_invoke", { name, args }),
  // v6 git executor log (GitKraken RE §6: GIT_EXECUTOR_COMMAND_ID correlation).
  gitLog: (limit = 200) => invoke<GitLogEntry[]>("git_log", { limit }),

  // GitKraken parity
  undoState: (path: string) => invoke<UndoState>("undo_state", { path }),
  undo: (path: string) => invoke<string>("undo_action", { path }),
  redo: (path: string) => invoke<string>("redo_action", { path }),
  lastCommitMessage: (path: string) => invoke<string>("last_commit_message", { path }),
  discard: (path: string, files: string[] | "all") =>
    invoke<CommandResult>("discard_paths", files === "all" ? { path, all: true } : { path, files }),
  branchAction: (path: string, request: BranchActionRequest) => invoke<CommandResult>("branch_action", { path, ...request }),
  tagAction: (path: string, action: TagAction, name: string, remote: string | null = null) =>
    invoke<CommandResult>("tag_action", { path, action, name, remote }),
  remoteAction: (path: string, action: RemoteAction, name: string, value: string | null = null) =>
    invoke<CommandResult>("remote_action", { path, action, name, value }),
  commitOffset: (path: string, revision: string) => invoke<number | null>("commit_offset", { path, revision }),
  diffCommitFiles: (path: string, from: string, to: string) =>
    invoke<CommitFileChange[]>("diff_commit_files", { path, from, to }),
  submoduleTree: (path: string) => invoke<SubmoduleTree>("submodule_tree", { path }),
  submoduleAction: (path: string, action: SubmoduleAction, target = "") => invoke<string>("submodule_action", { path, action, target }),
  superprojectChain: (path: string) => invoke<Array<{ path: string; name: string }>>("superproject_chain", { path }),
  repositoryTrust: (path: string) => invoke<{ trusted: boolean; directory: string | null }>("repository_trust", { path }),
  trustRepository: (path: string) => invoke<{ trusted: boolean; directory: string | null }>("trust_repository", { path }),
  fileDiffSide: (path: string, file: string, side: DiffSide) => invoke<SideDiff>("file_diff_side", { path, file, side }),
  applyLines: (path: string, file: string, mode: LineMode, selection: Array<{ hunk: number; lines: number[] }>, fingerprint: string | null) =>
    invoke<CommandResult>("apply_lines", { path, file, mode, selection, fingerprint }),
  stashFiles: (path: string, ref: string) => invoke<StashFile[]>("stash_files", { path, ref }),

  // Roadmap Tier 1
  signatures: (path: string, commits: string[]) => invoke<SignatureInfo[]>("commit_signatures", { path, commits }),
  signingConfig: (path: string) => invoke<SigningConfig>("signing_config", { path }),
  setSigningConfig: (path: string, scope: "local" | "global", values: Partial<Pick<SigningConfig, "format" | "signingKey" | "commitSign" | "tagSign" | "allowedSignersFile">>) =>
    invoke<void>("set_signing_config", { path, scope, ...values }),
  perfStatus: (path: string) => invoke<PerfStatus>("perf_status", { path }),
  perfApply: (path: string, action: PerfAction) => invoke<string>("perf_apply", { path, action }),
  searchAdvanced: (path: string, query: string, limit = 500) => invoke<{ commits: CommitRecord[]; description: string }>("search_advanced", { path, query, limit }),
  hooks: (path: string) => invoke<{ dir: string; hooksPath: string; hooks: HookInfo[] }>("hooks_list", { path }),
  setHookEnabled: (path: string, name: string, enabled: boolean) => invoke<void>("hook_set_enabled", { path, name, enabled }),
  commitWithHooks: (path: string, message: string, options: CommitOptions & { streamId?: string } = {}) => invoke<HookCommitResult>("commit_with_hooks", { path, message, ...options }),
  autolinks: (path: string) => invoke<{ rules: AutolinkRule[]; suggested: AutolinkRule[] }>("autolinks_get", { path }),
  setAutolinks: (path: string, rules: AutolinkRule[]) => invoke<void>("autolinks_set", { path, rules }),
  commitTemplates: (path: string) => invoke<CommitTemplate[]>("commit_templates", { path }),
  saveCommitTemplates: (templates: CommitTemplate[]) => invoke<void>("commit_templates_save", { templates }),
  forkPoint: (path: string, branch: string | null = null, base: string | null = null) => invoke<ForkPointInfo>("fork_point", { path, branch, base }),

  // Roadmap Tier 2
  predictConflicts: (path: string, mode: "merge" | "cherry-pick" | "revert" | "rebase", source: string, target: string | null = null) =>
    invoke<ConflictPrediction>("predict_conflicts", { path, mode, source, target }),
  cleanupCandidates: (path: string, target: string | null = null, staleDays = 90) => invoke<{ target: string; candidates: CleanupCandidate[] }>("cleanup_candidates", { path, target, staleDays }),
  cleanupBranches: (path: string, branches: string[], mode: "archive" | "delete") => invoke<string>("cleanup_branches", { path, branches, mode }),
  archivedBranches: (path: string) => invoke<Array<{ branch: string; sha: string; date: string }>>("archived_branches", { path }),
  restoreArchived: (path: string, branch: string) => invoke<void>("restore_archived", { path, branch }),
  stackParents: (path: string) => invoke<Record<string, string>>("stack_parents", { path }),
  setStackParent: (path: string, branch: string, parent: string | null) => invoke<void>("stack_set_parent", { path, branch, parent }),
  createStackedBranch: (path: string, parent: string, name: string) => invoke<void>("stack_create", { path, parent, name }),
  restack: (path: string, branch: string) => invoke<CommandResult>("stack_restack", { path, branch }),
  profiles: (path: string | null) => invoke<{ profiles: IdentityProfile[]; effective: { name: string; email: string; origin: string } | null }>("profiles_list", { path }),
  saveProfile: (profile: { name: string; userName: string; userEmail: string; signingKey?: string; gpgFormat?: string }) => invoke<void>("profile_save", profile),
  deleteProfile: (name: string) => invoke<void>("profile_delete", { name }),
  applyProfile: (path: string | null, name: string, scope: "repo" | "folder", folder: string | null = null) => invoke<string>("profile_apply", { path, name, scope, folder }),
  detachProfile: (path: string, name: string) => invoke<void>("profile_detach", { path, name }),
  customCommands: () => invoke<CustomCommand[]>("custom_commands", {}),
  saveCustomCommands: (commands: CustomCommand[]) => invoke<void>("custom_commands_save", { commands }),
  runCustomCommand: (path: string, id: string, context: { sha?: string; branch?: string; files?: string[]; params?: Record<string, string> } = {}) =>
    invoke<CommandResult & { argv: string[] }>("custom_command_run", { path, id, ...context }),
  fileBlob: (path: string, revision: string, file: string) => invoke<FileBlob>("file_blob", { path, revision, file }),
  remoteHost: (path: string, remote = "origin") => invoke<RemoteHost | null>("remote_host", { path, remote }),
  prTemplate: (path: string) => invoke<string>("pr_template", { path }),
  createPullRequest: (path: string, request: { remote: string; token: string; head: string; base: string; title: string; description: string; draft: boolean; apiBase?: string }) =>
    invoke<{ number: number; url: string }>("pr_create", { path, ...request }),
  ciChecks: (path: string, sha: string, token: string, remote = "origin", apiBase?: string) =>
    invoke<{ state: string; checks: CheckRun[] }>("ci_checks", { path, sha, token, remote, apiBase }),
  rerunCheck: (path: string, check: CheckRun, token: string, remote = "origin", apiBase?: string) => invoke<string>("ci_rerun", { path, check, token, remote, apiBase }),

  // Roadmap Tier 3
  createAgentWorktree: (path: string, name: string, base: string, location: string | null = null) => invoke<{ path: string; branch: string }>("agent_worktree_create", { path, name, base, location }),
  removeAgentWorktree: (path: string, worktree: string, deleteBranch: boolean, force = false) => invoke<string>("agent_worktree_remove", { path, worktree, deleteBranch, force }),
  gitflowConfig: (path: string) => invoke<GitflowConfig>("gitflow_config", { path }),
  gitflowInit: (path: string, config: Partial<GitflowConfig>) => invoke<string>("gitflow_init", { path, config }),
  gitflowStart: (path: string, type: FlowType, name: string, base: string | null = null) => invoke<string>("gitflow_start", { path, type, name, base }),
  gitflowFinish: (path: string, type: FlowType, name: string, tagMessage: string | null = null, keepBranch = false) => invoke<string>("gitflow_finish", { path, type, name, tagMessage, keepBranch }),
  explain: (path: string, kind: ExplainKind, ref: string | null = null, base: string | null = null) => invoke<{ text: string; source: "ollama" | "local-rules"; title?: string }>("ai_explain", { path, kind, ref, base }),
  treemap: (path: string, revision = "HEAD", days = 90) => invoke<{ revision: string; files: Array<{ path: string; size: number; churn: number; commits: number }>; truncated: boolean; days: number }>("repo_treemap", { path, revision, days }),
  sparseStatus: (path: string) => invoke<{ enabled: boolean; cone: boolean; patterns: string[] }>("sparse_status", { path }),
  sparseAction: (path: string, action: "set" | "add" | "reapply" | "disable", patterns: string[] = []) => invoke<CommandResult>("sparse_action", { path, action, patterns }),
  notes: (path: string, commit: string) => invoke<string>("notes_get", { path, commit }),
  setNotes: (path: string, commit: string, text: string) => invoke<void>("notes_set", { path, commit, text }),

  // TortoiseGit explorer
  explorerList: (path: string, dir: string) => invoke<ExplorerListing>("explorer_list", { path, dir }),
  explorerAction: (path: string, request: ExplorerActionRequest) => invoke<ExplorerActionResult>("explorer_action", { path, ...request }),
  resolveShellPaths: (paths: string[]) => invoke<{ root: string; paths: string[]; isDir: boolean[]; directory: string }>("resolve_shell_paths", { paths }),
  explorerProperties: (path: string, file: string) => invoke<ExplorerProperties>("explorer_properties", { path, file }),
  explorerDiffFiles: (path: string, left: string, right: string) => invoke<FilePairDiff>("explorer_diff_files", { path, left, right }),
  explorerDiffPrevious: (path: string, file: string) => invoke<PreviousVersionDiff>("explorer_diff_previous", { path, file }),
  explorerPatch: (path: string, files: string[]) => invoke<{ name: string; text: string }>("explorer_patch", { path, files }),
  explorerOpen: (path: string, file: string, mode: "open" | "reveal" | "terminal") => invoke<string>("explorer_open", { path, file, mode }),
};

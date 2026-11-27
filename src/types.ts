export type RepositorySummary = {
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
};

export type CommitRecord = {
  id: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
};

export type HistoryPage = {
  commits: CommitRecord[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type FileChange = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  conflicted: boolean;
  /** Set when `path` is a submodule: what changed inside it. */
  submodule?: SubmoduleChange;
};

/** What changed inside a submodule (server/src/backend.ts). */
export type SubmoduleChange = {
  /** Absolute path of the submodule checkout. */
  root: string;
  recorded: string | null;
  head: string | null;
  newCommits: boolean;
  commits: Array<{ sha: string; subject: string }>;
  moreCommits: boolean;
  movedBack: boolean;
  /** Changed files inside the submodule, relative to it. */
  changes: FileChange[];
};

export type BranchRecord = {
  name: string;
  target: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
};

export type RemoteRecord = {
  name: string;
  fetchUrl: string;
  pushUrl: string;
};

export type WorkspaceRepository = {
  path: string;
  alias?: string;
};

export type Workspace = {
  id: string;
  name: string;
  repositories: WorkspaceRepository[];
};

export type CloneRequest = {
  url: string;
  destination: string;
  username?: string;
  token?: string;
};

export type AuthRequest = {
  username?: string;
  token?: string;
};

export type CommitDraftMode = "auto" | "rules" | "ollama";

export type CommitDraftStyle = "plain" | "conventional";

export type CommitDraftOptions = {
  style?: CommitDraftStyle;
  issueReference?: string;
};

export type CommitDraftFile = {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type CommitDraft = {
  subject: string;
  body: string;
  message: string;
  style: CommitDraftStyle;
  issueReference: string | null;
  source: "ollama" | "network" | "llamacpp" | "claude" | "local-rules";
  /** Why the AI provider could not be used (missing SDK or credentials). */
  notice?: string;
  model: string | null;
  files: CommitDraftFile[];
  truncatedDiff: boolean;
};

export type WorkflowRequest = {
  operation: string;
  args: string[];
};

export type ResetMode = "soft" | "mixed" | "hard";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RepositoryOperationKind = "merge" | "rebase" | "cherryPick" | "revert";
export type RepositoryOperationAction = "continue" | "skip" | "abort";

export type RepositoryOperationState = {
  operation: RepositoryOperationKind | null;
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
};

export type ConflictStageKind = "blob" | "symlink" | "gitlink";

export type ConflictStage = {
  oid: string;
  mode: string;
  kind: ConflictStageKind;
  text: string | null;
  binary: boolean;
  truncated: boolean;
  size: number;
};

export type ConflictLabels = {
  base: string;
  current: string;
  incoming: string;
};

export type ConflictKind = "content" | "addAdd" | "currentDeleted" | "incomingDeleted" | "bothDeleted" | "complex";

export type ConflictFileSummary = {
  path: string;
  kind: ConflictKind;
  hasBase: boolean;
  hasCurrent: boolean;
  hasIncoming: boolean;
  binary: boolean;
  special: boolean;
  tooLarge: boolean;
};

export type ConflictFileDetail = {
  path: string;
  kind: ConflictKind;
  labels: ConflictLabels;
  base: ConflictStage | null;
  current: ConflictStage | null;
  incoming: ConflictStage | null;
  workingText: string | null;
  workingBinary: boolean;
  workingTruncated: boolean;
  workingSize: number;
};

export type ConflictResolutionStrategy = "current" | "incoming" | "merged" | "working" | "delete";

export type ConflictResolutionRequest = {
  file: string;
  strategy: ConflictResolutionStrategy;
  content?: string;
};

export type ConflictResolutionResult = {
  remaining: number;
  nextPath: string | null;
};

export type PullRequestRecord = {
  id: string;
  number: number;
  title: string;
  author: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  updatedAt: string | null;
};

export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export type RebasePlanCommit = {
  commit: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  additions: number;
  deletions: number;
  filesChanged: number;
};

export type RebasePlan = {
  target: string;
  targetCommit: string;
  base: string;
  head: string;
  commits: RebasePlanCommit[];
  warnings: string[];
  blockedReason: string | null;
  supportsUpdateRefs: boolean;
};

export type RebasePlanItem = {
  commit: string;
  subject: string;
  action: RebaseAction;
  newMessage?: string;
};

export type RebaseStartRequest = {
  target: string;
  base: string;
  items: RebasePlanItem[];
  updateRefs: boolean;
};

export type RebaseStartResult = {
  result: CommandResult;
  operation: RepositoryOperationState;
};

export type CommitFileChange = {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type CommitDiffLine = {
  kind: "add" | "del" | "ctx";
  number: number | null;
  text: string;
};

export type CommitDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: CommitDiffLine[];
};

export type CommitFileDiff = {
  path: string;
  status: string;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: CommitDiffHunk[];
};

export type CommitDetails = {
  id: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  body: string;
  additions: number;
  deletions: number;
  files: CommitFileChange[];
};

export type TagRecord = {
  name: string;
  target: string;
  annotated: boolean;
  tagger: string;
  date: string;
  message: string;
};

export type WorkingTreeDiff = {
  path: string;
  binary: boolean;
  additions: number;
  deletions: number;
  status: string;
  hunks: CommitDiffHunk[];
};

export type RevisionDiff = {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: CommitDiffHunk[];
};

export type TreeEntry = {
  name: string;
  path: string;
  type: "tree" | "blob";
  mode: string;
  size: number | null;
};

export type FileAtRevision = {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  binary: boolean;
};

export type PatchExport = {
  name: string;
  size: number;
  base64: string;
};

export type ActivityDay = {
  date: string;
  count: number;
};

export type BranchRef = {
  name: string;
  remote: string | null;
  target: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
};

export type StashRef = {
  ref: string;
  message: string;
  target: string;
};

export type SubmoduleRef = {
  path: string;
  commit: string;
  summary: string;
  status: string;
};

export type WorktreeRef = {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  locked: boolean;
  dirtyCount: number;
  conflictCount: number;
};

export type RefGroups = {
  branches: BranchRef[];
  stashes: StashRef[];
  submodules: SubmoduleRef[];
  worktrees: WorktreeRef[];
  tags: TagRecord[];
};

export type HistoryChangeStat = {
  commit: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  binaryFiles: number;
};

export type CommitSearchResult = {
  query: string;
  commits: CommitRecord[];
};

export type RefComparison = {
  left: string;
  right: string;
  leftId: string;
  rightId: string;
  mergeBase: string;
  leftOnlyCount: number;
  rightOnlyCount: number;
  leftOnly: CommitRecord[];
  rightOnly: CommitRecord[];
  filesFromBaseToLeft: CommitFileChange[];
  filesFromBaseToRight: CommitFileChange[];
};

export type RangeDiffEntry = {
  status: "added" | "deleted" | "changed" | "same";
  oldPosition: number | null;
  oldCommit: string | null;
  newPosition: number | null;
  newCommit: string | null;
  subject: string;
  details: string[];
};

export type RangeDiffResult = {
  base: string;
  before: string;
  after: string;
  entries: RangeDiffEntry[];
  raw: string;
  truncated: boolean;
};

export type RepositoryHealth = {
  branch: string | null;
  head: string | null;
  dirtyFiles: number;
  conflictFiles: number;
  worktreeCount: number;
  dirtyWorktreeCount: number;
  submoduleCount: number;
  changedSubmoduleCount: number;
  lfsAvailable: boolean;
  lfsTrackedFiles: number;
  objectCount: number;
  packedObjectCount: number;
  packCount: number;
  packSizeKb: number;
  reflogEntries: number;
  maintenanceConfigured: boolean;
  fsck: {
    scanned: boolean;
    unreachableObjects: number;
    danglingCommits: number;
    warnings: string[];
  };
};

export type FileHistoryRequest = {
  file: string;
  followRenames: boolean;
  allRefs: boolean;
  limit: number;
};

export type BlameLine = {
  lineNumber: number;
  commit: string;
  author: string;
  authorEmail: string;
  authoredAt: number;
  summary: string;
  content: string;
};

export type BlameResult = {
  file: string;
  lines: BlameLine[];
  truncated: boolean;
};

export type ContributorRecord = {
  name: string;
  email: string;
  commits: number;
  firstCommit: string;
  lastCommit: string;
};

export type WorktreeSummary = {
  path: string;
  head: string;
  branch: string | null;
  isMain: boolean;
  locked: string | null;
  prunable: string | null;
  dirtyCount: number;
  conflictCount: number;
};

export type GitLogEntry = {
  id: string;
  commandId: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  startedAt: string;
  stdoutTail: string;
  stderrTail: string;
};

// ---------------------------------------------------------------------------
// GitKraken parity (undo/redo, pull/push modes, branch actions) and the
// TortoiseGit explorer (overlay status + context-menu actions).
// ---------------------------------------------------------------------------

export type PullMode = "fetch" | "ff" | "ff-only" | "rebase";

export type PushOptions = {
  remote?: string | null;
  branch?: string | null;
  force?: boolean;
  setUpstream?: boolean;
  tags?: boolean;
  streamId?: string;
};

export type CommitOptions = {
  amend?: boolean;
  signoff?: boolean;
  noVerify?: boolean;
  /** Author and committer for this commit only (multi-user profiles). */
  identity?: { name: string; email: string } | null;
};

export type UndoState = {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  history: Array<{ id: number; label: string; at: string }>;
};

export type BranchAction =
  | "rename"
  | "set_upstream"
  | "unset_upstream"
  | "push"
  | "delete_remote"
  | "merge_into_current"
  | "rebase_current_onto"
  | "fast_forward"
  | "force_to_commit"
  | "checkout_and_merge"
  | "pull_branch";

export type BranchActionRequest = {
  action: BranchAction;
  branch: string;
  target?: string | null;
  newName?: string | null;
  remote?: string | null;
};

export type TagAction = "push" | "delete_remote" | "push_all";
export type RemoteAction = "add" | "remove" | "rename" | "set_url" | "prune" | "fetch";

export type StashFile = { path: string; additions: number | null; deletions: number | null; untracked: boolean };

export type OverlayStatus =
  | "normal"
  | "modified"
  | "staged"
  | "added"
  | "deleted"
  | "renamed"
  | "conflicted"
  | "untracked"
  | "ignored"
  | "unversioned-dir";

export type ExplorerEntry = {
  name: string;
  path: string;
  type: "dir" | "file" | "submodule" | "symlink";
  size: number | null;
  modifiedAt: string | null;
  status: OverlayStatus;
  indexStatus: string;
  worktreeStatus: string;
  tracked: boolean;
  assumeUnchanged: boolean;
  skipWorktree: boolean;
  missing: boolean;
  changedCount: number;
};

export type ExplorerListing = {
  root: string;
  dir: string;
  branch: string | null;
  entries: ExplorerEntry[];
};

export type ExplorerAction =
  | "add"
  | "unstage"
  | "revert"
  | "delete"
  | "remove_keep_local"
  | "rename"
  | "ignore_name"
  | "ignore_ext"
  | "ignore_and_remove"
  | "resolve"
  | "resolve_ours"
  | "resolve_theirs"
  | "assume_unchanged"
  | "no_assume_unchanged"
  | "skip_worktree"
  | "no_skip_worktree"
  | "clean"
  | "stash_save"
  | "checkout_revision"
  | "lfs_lock"
  | "lfs_unlock"
  | "lfs_track"
  | "submodule_update"
  | "commit"
  | "export"
  | "new_folder"
  | "new_file";

export type ExplorerActionRequest = {
  action: ExplorerAction;
  files: string[];
  message?: string;
  newName?: string;
  revision?: string;
  scope?: "local" | "root";
  cleanMode?: "untracked" | "ignored" | "all";
  dryRun?: boolean;
  amend?: boolean;
  destination?: string;
};

export type ExplorerActionResult = CommandResult & { action: ExplorerAction; summary: string };

export type ExplorerProperties = {
  path: string;
  absolutePath: string;
  exists: boolean;
  type: "dir" | "file" | "symlink" | "missing";
  size: number | null;
  modifiedAt: string | null;
  mode: string | null;
  blob: string | null;
  tracked: boolean;
  status: OverlayStatus;
  lastCommit: CommitRecord | null;
  firstCommit: CommitRecord | null;
  commitCount: number;
  attributes: Array<{ name: string; value: string }>;
  ignoredBy: string | null;
  lfs: boolean;
  assumeUnchanged: boolean;
  skipWorktree: boolean;
};

export type FilePairDiff = {
  left: string;
  right: string;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: CommitDiffHunk[];
};

export type PreviousVersionDiff = RevisionDiff & { from: string; to: string; subject: string };

// ---------------------------------------------------------------------------
// Roadmap features (Tier 1-3)
// ---------------------------------------------------------------------------

export type SignatureInfo = { commit: string; status: string; signer: string; key: string };
export type SigningConfig = {
  format: string; signingKey: string; commitSign: boolean; tagSign: boolean; allowedSignersFile: string; scopeOfKey: string;
  sshKeys: string[]; gpgKeys: Array<{ id: string; uid: string }>; userName: string; userEmail: string; identityOrigin: string;
};
export type PerfStatus = {
  commitGraph: boolean; changedPaths: boolean; maintenanceRegistered: boolean; fsmonitorConfigured: string;
  fsmonitorDaemon: "running" | "stopped" | "unsupported"; untrackedCache: string; indexVersion: string; looseObjects: number;
  packs: number; sizePackKb: number; commitCount: number; inotifyWatches: number | null; gitVersion: string; presetApplied: string[];
};
export type PerfAction = "commit_graph" | "maintenance_register" | "maintenance_unregister" | "maintenance_run" | "fsmonitor_on" | "fsmonitor_off" | "untracked_cache" | "preset" | "gc";
export type HookInfo = { name: string; path: string; exists: boolean; executable: boolean; size: number; preview: string };
/** Forks and upstreams (server/src/forks.ts). */
export type ForkRemote = { name: string; url: string; web: string | null; owner: string | null; repository: string | null };
export type ForkStatus = {
  path: string; absolute: string; name: string; kind: "fork" | "plain" | "local";
  origin: ForkRemote | null; upstream: ForkRemote | null; defaultBranch: string | null; currentBranch: string | null;
  behind: number | null; ahead: number | null; originBehind: number | null; branchBehind: number | null;
  fetchedAt: string | null; compareUrl: string | null; depth: number;
};
export type ForkSyncResult = { path: string; ok: boolean; message: string; from: string | null; to: string | null; pushed: boolean };
export type AiSettings = {
  provider: "ollama" | "network" | "llamacpp" | "claude" | "off";
  ollamaUrl: string;
  ollamaModel: string;
  claudeModel: string;
  claudeModels: Array<{ id: string; label: string }>;
  claudeKeySaved: boolean;
  claudeEnvCredentials: boolean;
  netUrl: string;
  netModel: string;
  netKeySaved: boolean;
  llamaBinary: string;
  modelsDir: string;
  activeModel: string;
  port: number;
  contextSize: number;
  gpuLayers: number | null;
  lan: boolean;
  lanKeySaved: boolean;
  autoStart: boolean;
  lockInRam: boolean;
};
export type AiSettingsUpdate = Partial<Omit<AiSettings, "claudeModels" | "claudeKeySaved" | "claudeEnvCredentials" | "netKeySaved" | "lanKeySaved">> & { claudeKey?: string | null; netKey?: string | null; lanKey?: string | null };
export type LlmDownloadJob = { id: string; kind: "engine" | "model"; label: string; received: number; total: number | null; speed: number | null; status: "running" | "unpacking" | "done" | "error" | "cancelled"; error?: string; startedAt: string };
export type LlmEngineAsset = { name: string; variant: string; size: number; url: string; recommended: boolean; note: string };
export type LlmServerState = { status: "stopped" | "starting" | "ready"; pid: number | null; port: number | null; model: string | null; binary: string | null; startedAt: string | null; lanUrl: string | null; lastExit: { at: string; code: number | null; message: string } | null };
export type LlmStatus = {
  paths: { root: string; engines: string; downloads: string; models: string };
  platform: string;
  engines: Array<{ id: string; build: string; variant: string; server: string }>;
  binary: string | null;
  models: Array<{ name: string; size: number }>;
  modelsDir: string;
  presets: Array<{ id: string; label: string; note: string; url: string; size: number }>;
  jobs: LlmDownloadJob[];
  server: LlmServerState;
};
export type NestedCommit = { path: string; commit: string; detached: boolean; attachedTo: string | null };
export type HookCommitResult = { ok: boolean; commit: string | null; nested?: NestedCommit[]; output: string; exitCode: number; hookFailed: string | null; activeHooks: string[] };
export type AutolinkRule = { pattern: string; url: string };
export type CommitTemplate = { id: string; name: string; text: string; source: "git" | "chrono" };
export type ForkPointInfo = { branch: string; base: string | null; forkPoint: string | null; ahead: number; behind: number };
export type ConflictPrediction = { supported: boolean; clean: boolean; files: string[]; approximate: boolean; message: string };
export type CleanupCandidate = { branch: string; target: string; reasons: Array<"merged" | "squash-merged" | "upstream-gone" | "stale">; lastCommit: string; daysOld: number };
export type IdentityProfile = { name: string; userName: string; userEmail: string; signingKey: string; gpgFormat: string; file: string; folders: string[]; repos: string[] };
export type CustomCommandParam = { name: string; label: string; type: "text" | "branch" | "checkbox"; default?: string };
export type CustomCommand = { id: string; name: string; argv: string[]; scope: "repository" | "commit" | "branch" | "files"; confirm: boolean; refresh: boolean; params: CustomCommandParam[] };
export type FileBlob = { exists: boolean; mime: string; size: number; base64: string; lfs: boolean };
export type HostingProvider = "github" | "gitlab" | "gitea" | "bitbucket-server" | "bitbucket-cloud";
/** For "bitbucket-server", owner is the project key (~user for personal repositories). */
export type RemoteHost = { provider: HostingProvider; host: string; owner: string; repository: string; apiBase: string; webBase: string };
export const HOSTING_PROVIDER_LABELS: Record<HostingProvider, string> = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea / Forgejo", "bitbucket-server": "Bitbucket Server", "bitbucket-cloud": "Bitbucket Cloud" };
/** Default API base per provider ("" where it depends on the server). */
export const HOSTING_DEFAULT_API: Record<HostingProvider, string> = { github: "https://api.github.com", gitlab: "", gitea: "", "bitbucket-server": "", "bitbucket-cloud": "https://api.bitbucket.org/2.0" };
/** Per-host options the server applies to provider requests (server/src/hosting.ts). */
export type HostingConnection = { host: string; insecureTls: boolean; caFile: string; timeoutSeconds: number; hasToken: boolean };
export type CheckRun = { id: string; name: string; status: string; conclusion: string; url: string; rerunnable: boolean };
export type GitflowConfig = { initialized: boolean; master: string; develop: string; feature: string; release: string; hotfix: string; support: string; versionTag: string };
export type FlowType = "feature" | "release" | "hotfix" | "support";
export type ExplainKind = "commit" | "branch" | "working" | "pr";
export type DiffOptions = { whitespace?: "all" | "change" | "eol" | "none"; algorithm?: "myers" | "minimal" | "patience" | "histogram" };
export type CloneOptions = { depth?: number | null; filter?: "blob:none" | "tree:0" | null; sparse?: boolean; branch?: string | null; singleBranch?: boolean };

// Line-level staging
export type DiffSide = "unstaged" | "staged";
export type LineMode = "stage" | "unstage" | "discard";
export type SideDiff = { path: string; side: DiffSide; binary: boolean; untracked: boolean; additions: number; deletions: number; fingerprint: string; hunks: CommitDiffHunk[] };

export type SubmoduleState = "ok" | "drift" | "uninitialized" | "conflict";
export type SubmoduleNode = {
  path: string;
  name: string;
  parent: string | null;
  depth: number;
  state: SubmoduleState;
  commit: string;
  recorded: string | null;
  drift: { ahead: number; behind: number } | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: number;
  untracked: number;
  conflicts: number;
  url: string | null;
  children: number;
  attentionBelow: number;
  tracking: { branch: string; behind: number } | null;
};
export type SubmoduleTree = {
  root: string;
  nodes: SubmoduleNode[];
  maxDepth: number;
  totals: { all: number; dirty: number; drift: number; uninitialized: number; conflict: number; detached: number; outdated: number };
  superprojects: Array<{ path: string; name: string }>;
};
export type SubmoduleAction = "init" | "update" | "update_remote" | "sync" | "fetch" | "deinit";

export type FolderEntry = { name: string; path: string; repo: boolean; hidden: boolean };
export type FolderListing = {
  path: string;
  parent: string | null;
  repo: boolean;
  entries: FolderEntry[];
  truncated: boolean;
  places: Array<{ name: string; path: string }>;
};

export type SubmoduleBulkAction = "fetch" | "update" | "update_remote" | "pull" | "attach" | "record";
export type SubmoduleBulkResult = { path: string; status: "ok" | "skipped" | "failed"; message: string };
export type SubmoduleForeachResult = { path: string; code: number | null; stdout: string; stderr: string; ms: number };
export type SubmoduleManifest = {
  root: string;
  head: string | null;
  generatedAt: string;
  submodules: Array<{ path: string; url: string | null; recorded: string; checkedOut: string | null; branch: string | null; state: SubmoduleNode["state"] }>;
};

// Codebase landscape map (server/src/landscape.ts).
export type LandscapeRecord = {
  path: string;
  lang: string;
  loc: number;
  specs: string[];
  cs: { ns: string[]; uses: string[]; decl: string[]; toks: string[] } | null;
  syms: string[];
};
export type LandscapeScan = {
  name: string;
  root: string;
  head: string;
  files: LandscapeRecord[];
  repos: Array<{ title: string; path: string; url: string; sha: string }>;
  cut: number;
  scannedAt: string;
  durationMs: number;
};

/** Recent changes per file, for the landscape heatmap (server/src/landscapeRecent.ts). */
export type LandscapeRecent = {
  root: string;
  now: number;
  days: number;
  files: Record<string, { t: number; n: number; w?: 1 }>;
  commits: number;
  capped: boolean;
};

/** Live change notification (server/src/repoWatch.ts). */
export type RepositoryChange = {
  /** Bumped for every change in the working tree or the git directory. */
  version: number;
  /** Bumped when HEAD, refs or the operation state changed. */
  gitVersion: number;
  mode: "events" | "poll" | "starting";
};

// GitHub integration (server/src/github.ts).
export type GithubLabel = { name: string; color: string };
export type GithubAccount = { login: string; name: string | null; avatarUrl: string; htmlUrl: string; scopes: string[] };
export type GithubRepo = { fullName: string; owner: string; name: string; description: string; private: boolean; fork: boolean; cloneUrl: string; sshUrl: string; htmlUrl: string; defaultBranch: string; updatedAt: string | null };
export type GithubForks = { me: string; parent: GithubRepo; mine: GithubRepo | null; others: GithubRepo[] };
export type GithubPullSummary = { number: number; title: string; author: string; avatarUrl: string; draft: boolean; head: string; base: string; updatedAt: string; htmlUrl: string; labels: GithubLabel[] };
export type GithubTimelineItem = { kind: "comment" | "review"; author: string; avatarUrl: string; body: string; state?: string; createdAt: string; htmlUrl: string };
export type GithubPullDetail = {
  number: number; title: string; body: string; state: "open" | "closed" | "merged"; draft: boolean; htmlUrl: string;
  author: { login: string; avatarUrl: string } | null; createdAt: string; updatedAt: string;
  head: { ref: string; sha: string; repo: string | null; cloneUrl: string | null; sameRepo: boolean }; base: { ref: string };
  mergeable: boolean | null; mergeableState: string; commits: number; additions: number; deletions: number; changedFiles: number;
  reviewers: Array<{ login: string; avatarUrl: string; state: string }>; assignees: string[]; labels: GithubLabel[];
  milestone: { number: number; title: string } | null; timeline: GithubTimelineItem[]; checks: { state: string; checks: CheckRun[] }; viewer: string; canMerge: boolean;
};
export type GithubIssueSummary = { number: number; title: string; state: string; author: string; avatarUrl: string; labels: GithubLabel[]; assignees: string[]; comments: number; updatedAt: string; htmlUrl: string };
export type GithubIssueDetail = GithubIssueSummary & { body: string; createdAt: string; milestone: { number: number; title: string } | null; timeline: GithubTimelineItem[]; viewer: string };
export type GithubRepoOptions = { assignees: string[]; labels: GithubLabel[]; milestones: Array<{ number: number; title: string }> };
export type SshKeyInfo = { path: string; type: string; comment: string; fingerprint: string; onGithub: boolean | null };
/** Which remote a GitHub call is about, with the overrides from Settings → Hosting connections. */
export type GithubRemoteRef = { remote: string; apiBase?: string; provider?: string; token: string };
/** A GitHub server (account-level calls). */
export type GithubServerRef = { apiBase: string; host: string; token: string };

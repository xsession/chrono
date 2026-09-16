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

export type FileChange = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  conflicted: boolean;
};

export type BranchRecord = {
  name: string;
  target: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
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

export type WorkflowRequest = {
  operation: string;
  args: string[];
};

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

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySummary {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRecord {
    pub id: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRecord {
    pub name: String,
    pub target: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequest {
    pub username: Option<String>,
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRequest {
    pub url: String,
    pub destination: String,
    pub username: Option<String>,
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRequest {
    pub operation: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOperationState {
    pub operation: Option<String>,
    pub has_conflicts: bool,
    pub conflict_count: usize,
    pub can_continue: bool,
    pub can_skip: bool,
    pub can_abort: bool,
    pub current_commit: Option<String>,
    pub current_subject: Option<String>,
    pub step: Option<usize>,
    pub total: Option<usize>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictStage {
    pub oid: String,
    pub mode: String,
    pub kind: String,
    pub text: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictLabels {
    pub base: String,
    pub current: String,
    pub incoming: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFileSummary {
    pub path: String,
    pub kind: String,
    pub has_base: bool,
    pub has_current: bool,
    pub has_incoming: bool,
    pub binary: bool,
    pub special: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFileDetail {
    pub path: String,
    pub kind: String,
    pub labels: ConflictLabels,
    pub base: Option<ConflictStage>,
    pub current: Option<ConflictStage>,
    pub incoming: Option<ConflictStage>,
    pub working_text: Option<String>,
    pub working_binary: bool,
    pub working_truncated: bool,
    pub working_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolutionRequest {
    pub file: String,
    pub strategy: String,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolutionResult {
    pub remaining: usize,
    pub next_path: Option<String>,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlanCommit {
    pub commit: String,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: String,
    pub subject: String,
    pub additions: usize,
    pub deletions: usize,
    pub files_changed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlan {
    pub target: String,
    pub target_commit: String,
    pub base: String,
    pub head: String,
    pub commits: Vec<RebasePlanCommit>,
    pub warnings: Vec<String>,
    pub blocked_reason: Option<String>,
    pub supports_update_refs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlanItem {
    pub commit: String,
    pub subject: String,
    pub action: String,
    pub new_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStartRequest {
    pub target: String,
    pub base: String,
    pub items: Vec<RebasePlanItem>,
    pub update_refs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStartResult {
    pub result: CommandResult,
    pub operation: RepositoryOperationState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSearchResult {
    pub query: String,
    pub commits: Vec<CommitRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileChange {
    pub path: String,
    pub additions: Option<usize>,
    pub deletions: Option<usize>,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub id: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: String,
    pub subject: String,
    pub body: String,
    pub additions: usize,
    pub deletions: usize,
    pub files: Vec<CommitFileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryChangeStat {
    pub commit: String,
    pub additions: usize,
    pub deletions: usize,
    pub files_changed: usize,
    pub binary_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefComparison {
    pub left: String,
    pub right: String,
    pub left_id: String,
    pub right_id: String,
    pub merge_base: String,
    pub left_only_count: usize,
    pub right_only_count: usize,
    pub left_only: Vec<CommitRecord>,
    pub right_only: Vec<CommitRecord>,
    pub files_from_base_to_left: Vec<CommitFileChange>,
    pub files_from_base_to_right: Vec<CommitFileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryRequest {
    pub file: String,
    pub follow_renames: bool,
    pub all_refs: bool,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line_number: usize,
    pub commit: String,
    pub author: String,
    pub author_email: String,
    pub authored_at: i64,
    pub summary: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameResult {
    pub file: String,
    pub lines: Vec<BlameLine>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributorRecord {
    pub name: String,
    pub email: String,
    pub commits: usize,
    pub first_commit: String,
    pub last_commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSummary {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub is_main: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
    pub dirty_count: usize,
    pub conflict_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepository {
    pub path: String,
    pub alias: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub repositories: Vec<WorkspaceRepository>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestRecord {
    pub id: String,
    pub number: u64,
    pub title: String,
    pub author: String,
    pub state: String,
    pub source_branch: String,
    pub target_branch: String,
    pub web_url: String,
    pub updated_at: Option<String>,
}

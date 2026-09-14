mod backend;
mod conflict_center;
mod error;
mod models;
mod operation_state;
mod rebase_planner;
mod insights;
mod provider;
mod workspace;

use error::AppResult;
use models::*;
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

#[tauri::command]
fn repository_summary(path: String) -> AppResult<RepositorySummary> { backend::repository_summary(&path) }
#[tauri::command]
fn repository_history(path: String, limit: usize) -> AppResult<Vec<CommitRecord>> { backend::repository_history(&path, limit) }
#[tauri::command]
fn repository_status(path: String) -> AppResult<Vec<FileChange>> { backend::repository_status(&path) }
#[tauri::command]
fn repository_branches(path: String) -> AppResult<Vec<BranchRecord>> { backend::repository_branches(&path) }
#[tauri::command]
fn repository_conflicts(path: String) -> AppResult<Vec<ConflictFileSummary>> { conflict_center::repository_conflicts(&path) }
#[tauri::command]
fn conflict_detail(path: String, file: String) -> AppResult<ConflictFileDetail> { conflict_center::conflict_detail(&path, &file) }
#[tauri::command]
fn resolve_conflict(path: String, request: ConflictResolutionRequest) -> AppResult<ConflictResolutionResult> { conflict_center::resolve_conflict(&path, &request) }
#[tauri::command]
fn prepare_rebase_plan(path: String, target: String) -> AppResult<RebasePlan> { rebase_planner::prepare_rebase_plan(&path, &target) }
#[tauri::command]
fn start_rebase_plan(path: String, request: RebaseStartRequest) -> AppResult<RebaseStartResult> { rebase_planner::start_rebase_plan(&path, &request) }
#[tauri::command]
fn search_commits(path: String, request: SearchRequest) -> AppResult<CommitSearchResult> { insights::search_commits(&path, &request) }
#[tauri::command]
fn commit_details(path: String, commit: String) -> AppResult<CommitDetails> { insights::commit_details(&path, &commit) }
#[tauri::command]
fn history_change_stats(path: String, limit: usize) -> AppResult<Vec<HistoryChangeStat>> { insights::history_change_stats(&path, limit) }
#[tauri::command]
fn compare_refs(path: String, left: String, right: String, limit: usize) -> AppResult<RefComparison> { insights::compare_refs(&path, &left, &right, limit) }
#[tauri::command]
fn file_history(path: String, request: FileHistoryRequest) -> AppResult<Vec<CommitRecord>> { insights::file_history(&path, &request) }
#[tauri::command]
fn line_history(path: String, file: String, start: usize, end: usize, limit: usize) -> AppResult<Vec<CommitRecord>> { insights::line_history(&path, &file, start, end, limit) }
#[tauri::command]
fn blame_file(path: String, file: String, revision: Option<String>, ignore_whitespace: bool, limit: usize) -> AppResult<BlameResult> { insights::blame_file(&path, &file, revision.as_deref(), ignore_whitespace, limit) }
#[tauri::command]
fn contributors(path: String, max_commits: usize) -> AppResult<Vec<ContributorRecord>> { insights::contributors(&path, max_commits) }
#[tauri::command]
fn worktree_summaries(path: String) -> AppResult<Vec<WorktreeSummary>> { insights::worktree_summaries(&path) }
#[tauri::command]
fn repository_operation_state(path: String) -> AppResult<RepositoryOperationState> { operation_state::repository_operation_state(&path) }
#[tauri::command]
fn control_repository_operation(path: String, action: String) -> AppResult<CommandResult> { operation_state::control_repository_operation(&path, &action) }
#[tauri::command]
fn stage_paths(path: String, files: Vec<String>) -> AppResult<()> { backend::stage_paths(&path, &files) }
#[tauri::command]
fn unstage_paths(path: String, files: Vec<String>) -> AppResult<()> { backend::unstage_paths(&path, &files) }
#[tauri::command]
fn create_commit(path: String, message: String) -> AppResult<String> { backend::create_commit(&path, &message) }
#[tauri::command]
fn fetch_repository(path: String, auth: AuthRequest) -> AppResult<CommandResult> { backend::fetch_repository(&path, &auth) }
#[tauri::command]
fn pull_repository(path: String) -> AppResult<CommandResult> { backend::pull_repository(&path) }
#[tauri::command]
fn push_repository(path: String, auth: AuthRequest) -> AppResult<CommandResult> { backend::push_repository(&path, &auth) }
#[tauri::command]
fn clone_repository(app: AppHandle, request: CloneRequest) -> AppResult<RepositorySummary> {
    #[cfg(target_os = "android")]
    let request = {
        let mut request = request;
        let supplied = std::path::Path::new(&request.destination);
        if !supplied.is_absolute() {
            let safe_name: String = request.destination.chars()
                .map(|character| if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') { character } else { '_' })
                .collect();
            if safe_name.is_empty() {
                return Err(error::AppError::Invalid("repository name is empty".into()));
            }
            let root = app.path().app_data_dir()
                .map_err(|error| error::AppError::Invalid(error.to_string()))?
                .join("repositories");
            std::fs::create_dir_all(&root)?;
            request.destination = root.join(safe_name).to_string_lossy().into_owned();
        }
        request
    };
    #[cfg(not(target_os = "android"))]
    let _ = app;
    backend::clone_repository(&request)
}
#[tauri::command]
fn switch_branch(path: String, branch: String) -> AppResult<()> { backend::switch_branch(&path, &branch) }
#[tauri::command]
fn create_branch(path: String, branch: String) -> AppResult<()> { backend::create_branch(&path, &branch) }
#[tauri::command]
fn run_workflow(path: String, request: WorkflowRequest) -> AppResult<CommandResult> { backend::run_workflow(&path, &request) }
#[tauri::command]
fn load_workspaces(app: AppHandle) -> AppResult<Vec<Workspace>> { workspace::load(&app) }
#[tauri::command]
fn save_workspaces(app: AppHandle, workspaces: Vec<Workspace>) -> AppResult<()> { workspace::save(&app, &workspaces) }
#[tauri::command]
async fn list_pull_requests(provider: String, base_url: String, owner: String, repository: String, token: String) -> AppResult<Vec<PullRequestRecord>> {
    provider::list_pull_requests(&provider, &base_url, &owner, &repository, &token).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            repository_summary, repository_history, repository_status, repository_branches,
            repository_conflicts, conflict_detail, resolve_conflict,
            prepare_rebase_plan, start_rebase_plan,
            search_commits, commit_details, history_change_stats, compare_refs, file_history, line_history, blame_file, contributors, worktree_summaries,
            repository_operation_state, control_repository_operation,
            stage_paths, unstage_paths, create_commit, fetch_repository, pull_repository,
            push_repository, clone_repository, switch_branch, create_branch, run_workflow,
            load_workspaces, save_workspaces, list_pull_requests
        ])
        .run(tauri::generate_context!())
        .expect("failed to run GitAhead Next");
}

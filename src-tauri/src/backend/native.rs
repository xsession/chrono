use std::path::Path;
use git2::{BranchType, Cred, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks, Repository, Sort, Status, StatusOptions};
use crate::error::{AppError, AppResult};
use crate::models::*;

fn open(path: &str) -> AppResult<Repository> { Ok(Repository::discover(path)?) }
fn callbacks(auth: &AuthRequest) -> RemoteCallbacks<'static> {
    let username = auth.username.clone();
    let token = auth.token.clone();
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, username_from_url, allowed| {
        if let Some(token) = token.as_deref() {
            return Cred::userpass_plaintext(username.as_deref().or(username_from_url).unwrap_or("oauth2"), token);
        }
        if allowed.is_default() { Cred::default() } else { Err(git2::Error::from_str("credentials required")) }
    });
    callbacks
}

pub fn repository_summary(path: &str) -> AppResult<RepositorySummary> {
    let repo = open(path)?;
    let root = repo.workdir().unwrap_or_else(|| Path::new(path));
    let head = repo.head().ok();
    let branch = head.as_ref().and_then(|h| h.shorthand()).map(str::to_string);
    let target = head.and_then(|h| h.target()).map(|id| id.to_string());
    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);
    let dirty = !repo.statuses(Some(&mut options))?.is_empty();
    Ok(RepositorySummary { path: root.to_string_lossy().into_owned(), name: root.file_name().and_then(|v| v.to_str()).unwrap_or("repository").to_string(), branch, head: target, ahead: 0, behind: 0, dirty })
}

pub fn repository_history(path: &str, limit: usize) -> AppResult<Vec<CommitRecord>> {
    let repo = open(path)?;
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    walk.push_head()?;
    let mut output = Vec::new();
    for oid in walk.take(limit.clamp(1, 5000)) {
        let commit = repo.find_commit(oid?)?;
        let author = commit.author();
        output.push(CommitRecord { id: commit.id().to_string(), parents: commit.parent_ids().map(|id| id.to_string()).collect(), author_name: author.name().unwrap_or("Unknown").to_string(), author_email: author.email().unwrap_or("").to_string(), authored_at: commit.time().seconds().to_string(), subject: commit.summary().unwrap_or("(no subject)").to_string() });
    }
    Ok(output)
}

pub fn repository_status(path: &str) -> AppResult<Vec<FileChange>> {
    let repo = open(path)?;
    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true).renames_head_to_index(true).renames_index_to_workdir(true);
    let statuses = repo.statuses(Some(&mut options))?;
    Ok(statuses.iter().map(|entry| {
        let status = entry.status();
        FileChange { path: entry.path().unwrap_or("").to_string(), index_status: index_code(status).to_string(), worktree_status: worktree_code(status).to_string(), conflicted: status.contains(Status::CONFLICTED) }
    }).collect())
}
fn index_code(status: Status) -> char { if status.contains(Status::INDEX_NEW) {'A'} else if status.contains(Status::INDEX_MODIFIED) {'M'} else if status.contains(Status::INDEX_DELETED) {'D'} else if status.contains(Status::INDEX_RENAMED) {'R'} else {' '} }
fn worktree_code(status: Status) -> char { if status.contains(Status::WT_NEW) {'?'} else if status.contains(Status::WT_MODIFIED) {'M'} else if status.contains(Status::WT_DELETED) {'D'} else if status.contains(Status::WT_RENAMED) {'R'} else {' '} }

pub fn repository_branches(path: &str) -> AppResult<Vec<BranchRecord>> {
    let repo = open(path)?;
    let current = repo.head().ok().and_then(|h| h.shorthand().map(str::to_string));
    let mut records = Vec::new();
    for branch in repo.branches(None)? {
        let (branch, kind) = branch?;
        let name = branch.name()?.unwrap_or("").to_string();
        let target = branch.get().target().map(|id| id.to_string()).unwrap_or_default();
        let upstream = branch.upstream().ok().and_then(|b| b.name().ok().flatten().map(str::to_string));
        records.push(BranchRecord { current: current.as_deref() == Some(&name), remote: kind == BranchType::Remote, name, target, upstream });
    }
    Ok(records)
}

pub fn stage_paths(path: &str, files: &[String]) -> AppResult<()> { let repo = open(path)?; let mut index = repo.index()?; index.add_all(files.iter().map(String::as_str), IndexAddOption::DEFAULT, None)?; index.write()?; Ok(()) }
pub fn unstage_paths(path: &str, files: &[String]) -> AppResult<()> { let repo = open(path)?; let head = repo.head()?.peel_to_commit()?.as_object().clone(); repo.reset_default(Some(&head), files.iter().map(String::as_str))?; Ok(()) }
pub fn create_commit(path: &str, message: &str) -> AppResult<String> {
    if message.trim().is_empty() { return Err(AppError::Invalid("commit message is empty".into())); }
    let repo = open(path)?; let signature = repo.signature()?; let mut index = repo.index()?; let tree_id = index.write_tree()?; let tree = repo.find_tree(tree_id)?; let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let id = if let Some(parent) = parent.as_ref() { repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &[parent])? } else { repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &[])? };
    Ok(id.to_string())
}
pub fn fetch_repository(path: &str, auth: &AuthRequest) -> AppResult<CommandResult> { let repo = open(path)?; let mut remote = repo.find_remote("origin")?; let mut options = FetchOptions::new(); options.remote_callbacks(callbacks(auth)); remote.fetch(&[] as &[&str], Some(&mut options), None)?; Ok(CommandResult { stdout: "Fetched origin".into(), stderr: String::new(), exit_code: 0 }) }
pub fn pull_repository(_path: &str) -> AppResult<CommandResult> { Err(AppError::Unsupported("Android pull is fetch-first until the conflict workflow is implemented".into())) }
pub fn push_repository(path: &str, auth: &AuthRequest) -> AppResult<CommandResult> { let repo = open(path)?; let head = repo.head()?; let branch = head.shorthand().ok_or_else(|| AppError::Invalid("detached HEAD cannot be pushed by this workflow".into()))?; let refspec = format!("refs/heads/{0}:refs/heads/{0}", branch); let mut remote = repo.find_remote("origin")?; let mut options = PushOptions::new(); options.remote_callbacks(callbacks(auth)); remote.push(&[&refspec], Some(&mut options))?; Ok(CommandResult { stdout: format!("Pushed {branch}"), stderr: String::new(), exit_code: 0 }) }
pub fn clone_repository(request: &CloneRequest) -> AppResult<RepositorySummary> { let auth = AuthRequest { username: request.username.clone(), token: request.token.clone() }; let mut fetch = FetchOptions::new(); fetch.remote_callbacks(callbacks(&auth)); let mut builder = git2::build::RepoBuilder::new(); builder.fetch_options(fetch); builder.clone(&request.url, Path::new(&request.destination))?; repository_summary(&request.destination) }
pub fn switch_branch(path: &str, branch: &str) -> AppResult<()> { let repo = open(path)?; let reference = format!("refs/heads/{branch}"); repo.set_head(&reference)?; repo.checkout_head(Some(git2::build::CheckoutBuilder::new().safe()))?; Ok(()) }
pub fn create_branch(path: &str, branch: &str) -> AppResult<()> { let repo = open(path)?; let head = repo.head()?.peel_to_commit()?; repo.branch(branch, &head, false)?; switch_branch(path, branch) }
pub fn run_workflow(_path: &str, request: &WorkflowRequest) -> AppResult<CommandResult> { Err(AppError::Unsupported(format!("{} is a desktop workflow", request.operation))) }

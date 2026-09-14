use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::error::{AppError, AppResult};
use crate::models::*;

fn run(path: Option<&Path>, args: &[&str]) -> AppResult<Output> {
    let mut command = Command::new("git");
    command.env("GIT_TERMINAL_PROMPT", "0");
    if let Some(path) = path { command.arg("-C").arg(path); }
    command.args(args);
    Ok(command.output()?)
}

fn checked(path: Option<&Path>, args: &[&str]) -> AppResult<CommandResult> {
    let output = run(path, args)?;
    let result = CommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    };
    if output.status.success() { Ok(result) }
    else { Err(AppError::Command(format!("git {}: {}", args.join(" "), result.stderr.trim()))) }
}

fn root(path: &Path) -> AppResult<PathBuf> {
    let result = checked(Some(path), &["rev-parse", "--show-toplevel"])?;
    Ok(PathBuf::from(result.stdout.trim()))
}

pub fn repository_summary(path: &str) -> AppResult<RepositorySummary> {
    let root = root(Path::new(path))?;
    let branch = checked(Some(&root), &["branch", "--show-current"])?.stdout.trim().to_string();
    let head = checked(Some(&root), &["rev-parse", "HEAD"]).ok().map(|v| v.stdout.trim().to_string());
    let status = checked(Some(&root), &["status", "--porcelain=v2", "--branch"])?.stdout;
    let mut ahead = 0usize;
    let mut behind = 0usize;
    let mut dirty = false;
    for line in status.lines() {
        if line.starts_with("# branch.ab ") {
            for token in line.split_whitespace() {
                if let Some(value) = token.strip_prefix('+') { ahead = value.parse().unwrap_or(0); }
                if let Some(value) = token.strip_prefix('-') { behind = value.parse().unwrap_or(0); }
            }
        } else if !line.starts_with('#') { dirty = true; }
    }
    Ok(RepositorySummary {
        name: root.file_name().and_then(|v| v.to_str()).unwrap_or("repository").to_string(),
        path: root.to_string_lossy().into_owned(),
        branch: (!branch.is_empty()).then_some(branch),
        head,
        ahead,
        behind,
        dirty,
    })
}

pub fn repository_history(path: &str, limit: usize) -> AppResult<Vec<CommitRecord>> {
    let limit = limit.clamp(1, 5000).to_string();
    let result = checked(Some(Path::new(path)), &[
        "log", "--date=iso-strict", "--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e", "-n", &limit,
    ])?;
    Ok(result.stdout.split('\u{1e}').filter_map(|record| {
        let fields: Vec<&str> = record.trim().split('\u{1f}').collect();
        (fields.len() == 6).then(|| CommitRecord {
            id: fields[0].to_string(),
            parents: fields[1].split_whitespace().map(str::to_string).collect(),
            author_name: fields[2].to_string(),
            author_email: fields[3].to_string(),
            authored_at: fields[4].to_string(),
            subject: fields[5].to_string(),
        })
    }).collect())
}

pub fn repository_status(path: &str) -> AppResult<Vec<FileChange>> {
    let result = checked(Some(Path::new(path)), &["status", "--porcelain=v1", "-z"])?;
    let mut entries = result.stdout.split('\0').filter(|entry| !entry.is_empty());
    let mut changes = Vec::new();
    while let Some(entry) = entries.next() {
        let bytes = entry.as_bytes();
        let index = bytes.first().copied().unwrap_or(b' ') as char;
        let worktree = bytes.get(1).copied().unwrap_or(b' ') as char;
        let renamed_or_copied = matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C');
        changes.push(FileChange {
            path: entry.get(3..).unwrap_or("").to_string(),
            index_status: index.to_string(),
            worktree_status: worktree.to_string(),
            conflicted: matches!((index, worktree), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D')),
        });
        if renamed_or_copied { let _ = entries.next(); }
    }
    Ok(changes)
}

pub fn repository_branches(path: &str) -> AppResult<Vec<BranchRecord>> {
    let result = checked(Some(Path::new(path)), &[
        "for-each-ref", "--format=%(refname:short)%1f%(objectname)%1f%(HEAD)%1f%(upstream:short)%1f%(refname)%1e", "refs/heads", "refs/remotes",
    ])?;
    Ok(result.stdout.split('\u{1e}').filter_map(|record| {
        let fields: Vec<&str> = record.trim().split('\u{1f}').collect();
        (fields.len() == 5).then(|| BranchRecord {
            name: fields[0].to_string(),
            target: fields[1].to_string(),
            current: fields[2] == "*",
            remote: fields[4].starts_with("refs/remotes/"),
            upstream: (!fields[3].is_empty()).then(|| fields[3].to_string()),
        })
    }).collect())
}

pub fn stage_paths(path: &str, files: &[String]) -> AppResult<()> {
    if files.is_empty() { return Ok(()); }
    let mut owned = vec!["add".to_string(), "--".to_string()];
    owned.extend(files.iter().cloned());
    let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
    checked(Some(Path::new(path)), &refs)?;
    Ok(())
}

pub fn unstage_paths(path: &str, files: &[String]) -> AppResult<()> {
    if files.is_empty() { return Ok(()); }
    let mut owned = vec!["restore".to_string(), "--staged".to_string(), "--".to_string()];
    owned.extend(files.iter().cloned());
    let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
    checked(Some(Path::new(path)), &refs)?;
    Ok(())
}

pub fn create_commit(path: &str, message: &str) -> AppResult<String> {
    if message.trim().is_empty() { return Err(AppError::Invalid("commit message is empty".into())); }
    checked(Some(Path::new(path)), &["commit", "-m", message])?;
    Ok(checked(Some(Path::new(path)), &["rev-parse", "HEAD"])?.stdout.trim().to_string())
}

pub fn fetch_repository(path: &str, _auth: &AuthRequest) -> AppResult<CommandResult> {
    checked(Some(Path::new(path)), &["fetch", "--all", "--prune", "--tags"])
}
pub fn pull_repository(path: &str) -> AppResult<CommandResult> { checked(Some(Path::new(path)), &["pull", "--ff-only"]) }
pub fn push_repository(path: &str, _auth: &AuthRequest) -> AppResult<CommandResult> { checked(Some(Path::new(path)), &["push"]) }

pub fn clone_repository(request: &CloneRequest) -> AppResult<RepositorySummary> {
    if request.url.trim().is_empty() || request.destination.trim().is_empty() {
        return Err(AppError::Invalid("clone URL and destination are required".into()));
    }
    checked(None, &["clone", "--", &request.url, &request.destination])?;
    repository_summary(&request.destination)
}

pub fn switch_branch(path: &str, branch: &str) -> AppResult<()> {
    checked(Some(Path::new(path)), &["switch", branch])?;
    Ok(())
}
pub fn create_branch(path: &str, branch: &str) -> AppResult<()> {
    checked(Some(Path::new(path)), &["switch", "-c", branch])?;
    Ok(())
}

fn require_args<'a>(request: &'a WorkflowRequest, count: usize) -> AppResult<&'a [String]> {
    if request.args.len() < count { Err(AppError::Invalid(format!("{} requires at least {} arguments", request.operation, count))) }
    else { Ok(&request.args) }
}

pub fn run_workflow(path: &str, request: &WorkflowRequest) -> AppResult<CommandResult> {
    fn values(items: &[&str]) -> Vec<String> { items.iter().map(|item| (*item).to_string()).collect() }
    let args: Vec<String> = match request.operation.as_str() {
        "worktree_list" => values(&["worktree", "list", "--porcelain"]),
        "worktree_add" => { let a = require_args(request, 2)?; vec!["worktree".into(), "add".into(), a[0].clone(), a[1].clone()] },
        "worktree_remove" => { let a = require_args(request, 1)?; vec!["worktree".into(), "remove".into(), a[0].clone()] },
        "worktree_prune" => values(&["worktree", "prune", "--verbose"]),
        "sparse_set" => { let a = require_args(request, 1)?; let mut result = values(&["sparse-checkout", "set", "--cone"]); result.extend(a.iter().cloned()); result },
        "sparse_disable" => values(&["sparse-checkout", "disable"]),
        "submodule_update" => values(&["submodule", "update", "--init", "--recursive"]),
        "submodule_sync" => values(&["submodule", "sync", "--recursive"]),
        "stash_list" => values(&["stash", "list"]),
        "stash_push" => { let message = request.args.first().cloned().unwrap_or_else(|| "GitAhead Next stash".into()); vec!["stash".into(), "push".into(), "-u".into(), "-m".into(), message] },
        "stash_pop" => values(&["stash", "pop"]),
        "bisect_start" => { let a = require_args(request, 2)?; vec!["bisect".into(), "start".into(), a[0].clone(), a[1].clone()] },
        "bisect_good" => { let a = require_args(request, 1)?; vec!["bisect".into(), "good".into(), a[0].clone()] },
        "bisect_bad" => { let a = require_args(request, 1)?; vec!["bisect".into(), "bad".into(), a[0].clone()] },
        "bisect_reset" => values(&["bisect", "reset"]),
        "reflog" => values(&["reflog", "show", "--date=iso"]),
        "cherry_pick" => { let a = require_args(request, 1)?; vec!["cherry-pick".into(), a[0].clone()] },
        "revert" => { let a = require_args(request, 1)?; vec!["revert".into(), "--no-edit".into(), a[0].clone()] },
        "lfs_locks" => values(&["lfs", "locks"]),
        "lfs_pull" => values(&["lfs", "pull"]),
        "lfs_prune" => values(&["lfs", "prune"]),
        "maintenance" => values(&["maintenance", "run"]),
        "fsck" => values(&["fsck", "--full", "--no-reflogs"]),
        _ => return Err(AppError::Invalid(format!("unknown workflow: {}", request.operation))),
    };
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    checked(Some(Path::new(path)), &refs)
}

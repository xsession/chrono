use crate::error::{AppError, AppResult};
use crate::models::{CommandResult, RepositoryOperationState};

#[cfg(not(target_os = "android"))]
mod desktop {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output};

    use super::*;

    fn editor_command() -> &'static str {
        #[cfg(target_os = "windows")]
        { "cmd /c exit 0" }
        #[cfg(not(target_os = "windows"))]
        { "true" }
    }

    fn run_git(path: &str, args: &[&str]) -> AppResult<Output> {
        let mut command = Command::new("git");
        command.arg("-C").arg(path).args(args);
        command.env("GIT_TERMINAL_PROMPT", "0");
        command.env("GIT_EDITOR", editor_command());
        command.env("GIT_SEQUENCE_EDITOR", editor_command());
        Ok(command.output()?)
    }

    fn checked_git(path: &str, args: &[&str]) -> AppResult<CommandResult> {
        let output = run_git(path, args)?;
        let result = CommandResult {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.status.code().unwrap_or(-1),
        };
        if output.status.success() {
            Ok(result)
        } else {
            Err(AppError::Command(format!("git {}: {}", args.join(" "), result.stderr.trim())))
        }
    }

    fn git_dir(path: &str) -> AppResult<PathBuf> {
        let result = checked_git(path, &["rev-parse", "--absolute-git-dir"])?;
        Ok(PathBuf::from(result.stdout.trim()))
    }

    fn read_trimmed(path: impl AsRef<Path>) -> Option<String> {
        fs::read_to_string(path).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
    }

    fn read_number(path: impl AsRef<Path>) -> Option<usize> {
        read_trimmed(path)?.parse().ok()
    }

    fn first_line(value: Option<String>) -> Option<String> {
        value.and_then(|value| value.lines().next().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string))
    }

    fn ref_value(path: &str, name: &str) -> Option<String> {
        checked_git(path, &["rev-parse", "--verify", name]).ok().map(|result| result.stdout.trim().to_string()).filter(|value| !value.is_empty())
    }

    fn subject_for(path: &str, commit: Option<&str>) -> Option<String> {
        let commit = commit?;
        checked_git(path, &["show", "-s", "--format=%s", commit]).ok().and_then(|result| first_line(Some(result.stdout)))
    }

    fn conflict_count(path: &str) -> AppResult<usize> {
        let result = checked_git(path, &["diff", "--name-only", "--diff-filter=U", "-z"])?;
        Ok(result.stdout.split('\0').filter(|entry| !entry.is_empty()).count())
    }

    pub fn repository_operation_state(path: &str) -> AppResult<RepositoryOperationState> {
        let git_dir = git_dir(path)?;
        let rebase_merge = git_dir.join("rebase-merge");
        let rebase_apply = git_dir.join("rebase-apply");

        let (operation, current_commit, current_subject, step, total) = if rebase_merge.is_dir() || rebase_apply.is_dir() {
            let dir = if rebase_merge.is_dir() { &rebase_merge } else { &rebase_apply };
            let current = ref_value(path, "REBASE_HEAD")
                .or_else(|| read_trimmed(dir.join("stopped-sha")))
                .or_else(|| read_trimmed(dir.join("original-commit")));
            let subject = subject_for(path, current.as_deref())
                .or_else(|| first_line(read_trimmed(dir.join("message"))));
            let (step, total) = if rebase_merge.is_dir() {
                (read_number(dir.join("msgnum")), read_number(dir.join("end")))
            } else {
                (read_number(dir.join("next")), read_number(dir.join("last")))
            };
            (Some("rebase".to_string()), current, subject, step, total)
        } else if git_dir.join("MERGE_HEAD").is_file() {
            let current = first_line(read_trimmed(git_dir.join("MERGE_HEAD")));
            let subject = subject_for(path, current.as_deref());
            (Some("merge".to_string()), current, subject, None, None)
        } else if git_dir.join("CHERRY_PICK_HEAD").is_file() {
            let current = first_line(read_trimmed(git_dir.join("CHERRY_PICK_HEAD")));
            let subject = subject_for(path, current.as_deref());
            (Some("cherryPick".to_string()), current, subject, None, None)
        } else if git_dir.join("REVERT_HEAD").is_file() {
            let current = first_line(read_trimmed(git_dir.join("REVERT_HEAD")));
            let subject = subject_for(path, current.as_deref());
            (Some("revert".to_string()), current, subject, None, None)
        } else {
            (None, None, None, None, None)
        };

        let conflicts = conflict_count(path)?;
        let active = operation.is_some();
        let skippable = matches!(operation.as_deref(), Some("rebase") | Some("cherryPick") | Some("revert"));
        let message = if !active {
            "No merge, rebase, cherry-pick or revert is in progress.".to_string()
        } else if conflicts > 0 {
            format!("{conflicts} unresolved conflict{}. Resolve and stage the files before continuing.", if conflicts == 1 { "" } else { "s" })
        } else if let (Some(step), Some(total)) = (step, total) {
            format!("Step {step} of {total} is resolved and ready to continue.")
        } else {
            "The operation is paused and ready to continue, skip where supported, or abort.".to_string()
        };

        Ok(RepositoryOperationState {
            operation,
            has_conflicts: conflicts > 0,
            conflict_count: conflicts,
            can_continue: active && conflicts == 0,
            can_skip: active && skippable,
            can_abort: active,
            current_commit,
            current_subject,
            step,
            total,
            message,
        })
    }

    pub fn control_repository_operation(path: &str, action: &str) -> AppResult<CommandResult> {
        let state = repository_operation_state(path)?;
        let operation = state.operation.as_deref().ok_or_else(|| AppError::Invalid("no merge, rebase, cherry-pick or revert is in progress".into()))?;

        if action == "continue" && state.has_conflicts {
            return Err(AppError::Invalid("resolve and stage all conflicts before continuing".into()));
        }
        if action == "skip" && !state.can_skip {
            return Err(AppError::Invalid(format!("{operation} does not support skip in this workflow")));
        }
        if !matches!(action, "continue" | "skip" | "abort") {
            return Err(AppError::Invalid(format!("unknown operation action: {action}")));
        }

        let command = match operation {
            "merge" => "merge",
            "rebase" => "rebase",
            "cherryPick" => "cherry-pick",
            "revert" => "revert",
            _ => return Err(AppError::Invalid(format!("unsupported repository operation: {operation}"))),
        };
        let flag = match action {
            "continue" => "--continue",
            "skip" => "--skip",
            "abort" => "--abort",
            _ => unreachable!(),
        };
        checked_git(path, &[command, flag])
    }
}

#[cfg(target_os = "android")]
mod android {
    use git2::{Repository, RepositoryState, Status, StatusOptions};
    use super::*;

    pub fn repository_operation_state(path: &str) -> AppResult<RepositoryOperationState> {
        let repo = Repository::discover(path)?;
        let operation = match repo.state() {
            RepositoryState::Merge => Some("merge"),
            RepositoryState::Revert | RepositoryState::RevertSequence => Some("revert"),
            RepositoryState::CherryPick | RepositoryState::CherryPickSequence => Some("cherryPick"),
            RepositoryState::Rebase | RepositoryState::RebaseInteractive | RepositoryState::RebaseMerge => Some("rebase"),
            _ => None,
        }.map(str::to_string);

        let mut options = StatusOptions::new();
        options.include_untracked(true).recurse_untracked_dirs(true);
        let conflicts = repo.statuses(Some(&mut options))?.iter().filter(|entry| entry.status().contains(Status::CONFLICTED)).count();
        let active = operation.is_some();

        Ok(RepositoryOperationState {
            operation,
            has_conflicts: conflicts > 0,
            conflict_count: conflicts,
            can_continue: false,
            can_skip: false,
            can_abort: false,
            current_commit: None,
            current_subject: None,
            step: None,
            total: None,
            message: if active {
                "An operation is in progress. Continue/skip/abort controls are currently desktop-only; use the Changes view to inspect conflicts.".into()
            } else {
                "No merge, rebase, cherry-pick or revert is in progress.".into()
            },
        })
    }

    pub fn control_repository_operation(_path: &str, _action: &str) -> AppResult<CommandResult> {
        Err(AppError::Unsupported("merge/rebase/cherry-pick/revert controls are not implemented on Android yet".into()))
    }
}

#[cfg(not(target_os = "android"))]
pub use desktop::{control_repository_operation, repository_operation_state};
#[cfg(target_os = "android")]
pub use android::{control_repository_operation, repository_operation_state};

use crate::error::{AppError, AppResult};
use crate::models::{CommandResult, RebasePlan, RebasePlanCommit, RebasePlanItem, RebaseStartRequest, RebaseStartResult};
use crate::operation_state;

#[cfg(not(target_os = "android"))]
mod desktop {
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output};

    use super::*;

    fn run_git(path: &str, args: &[&str]) -> AppResult<Output> {
        let mut command = Command::new("git");
        command.arg("-C").arg(path).args(args);
        command.env("GIT_TERMINAL_PROMPT", "0");
        Ok(command.output()?)
    }

    fn command_result(output: Output) -> CommandResult {
        CommandResult {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.status.code().unwrap_or(-1),
        }
    }

    fn checked(path: &str, args: &[&str]) -> AppResult<CommandResult> {
        let result = command_result(run_git(path, args)?);
        if result.exit_code == 0 {
            Ok(result)
        } else {
            Err(AppError::Command(format!("git {}: {}", args.join(" "), result.stderr.trim())))
        }
    }

    fn rev_parse(path: &str, revision: &str) -> AppResult<String> {
        let expression = format!("{revision}^{{commit}}");
        Ok(checked(path, &["rev-parse", "--verify", &expression])?.stdout.trim().to_string())
    }

    fn repository_clean(path: &str) -> AppResult<bool> {
        Ok(checked(path, &["status", "--porcelain=v1", "-z"])?.stdout.is_empty())
    }

    fn supports_update_refs(path: &str) -> bool {
        let Ok(version) = checked(path, &["version"]) else { return false };
        let raw = version.stdout.split_whitespace().last().unwrap_or("");
        let mut parts = raw.split('.');
        let major = parts.next().and_then(|value| value.parse::<u32>().ok()).unwrap_or(0);
        let minor = parts.next().and_then(|value| value.parse::<u32>().ok()).unwrap_or(0);
        major > 2 || (major == 2 && minor >= 38)
    }

    fn git_dir(path: &str) -> AppResult<PathBuf> {
        Ok(PathBuf::from(checked(path, &["rev-parse", "--absolute-git-dir"])?.stdout.trim()))
    }

    fn parse_numstat(path: &str, commit: &str) -> AppResult<(usize, usize, usize)> {
        let output = checked(path, &["show", "--numstat", "--format=", "--no-renames", commit])?.stdout;
        let mut additions = 0usize;
        let mut deletions = 0usize;
        let mut files = 0usize;
        for line in output.lines() {
            let mut fields = line.splitn(3, '\t');
            let Some(add) = fields.next() else { continue };
            let Some(del) = fields.next() else { continue };
            if fields.next().is_none() { continue; }
            files += 1;
            if add != "-" { additions = additions.saturating_add(add.parse().unwrap_or(0)); }
            if del != "-" { deletions = deletions.saturating_add(del.parse().unwrap_or(0)); }
        }
        Ok((additions, deletions, files))
    }

    fn commit_record(path: &str, commit: &str) -> AppResult<RebasePlanCommit> {
        let line = checked(path, &["show", "-s", "--date=iso-strict", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s", commit])?.stdout;
        let fields: Vec<&str> = line.trim().split('\u{1f}').collect();
        if fields.len() != 5 {
            return Err(AppError::Command(format!("unable to parse commit metadata for {commit}")));
        }
        let (additions, deletions, files_changed) = parse_numstat(path, commit)?;
        Ok(RebasePlanCommit {
            commit: fields[0].to_string(),
            author_name: fields[1].to_string(),
            author_email: fields[2].to_string(),
            authored_at: fields[3].to_string(),
            subject: fields[4].to_string(),
            additions,
            deletions,
            files_changed,
        })
    }

    pub fn prepare_rebase_plan(path: &str, target: &str) -> AppResult<RebasePlan> {
        if operation_state::repository_operation_state(path)?.operation.is_some() {
            return Err(AppError::Invalid("finish or abort the current Git operation before planning another rebase".into()));
        }
        if !repository_clean(path)? {
            return Err(AppError::Invalid("interactive rebase requires a clean working tree; commit or stash changes first".into()));
        }

        let target_commit = rev_parse(path, target)?;
        let head = rev_parse(path, "HEAD")?;
        let base = checked(path, &["merge-base", &target_commit, &head])?.stdout.trim().to_string();
        if base.is_empty() {
            return Err(AppError::Invalid("the selected target and HEAD do not have a merge base".into()));
        }

        let range = format!("{base}..{head}");
        let merge_commits = checked(path, &["rev-list", "--merges", &range])?.stdout
            .lines().filter(|line| !line.trim().is_empty()).count();
        let blocked_reason = if merge_commits > 0 {
            Some(format!("This branch contains {merge_commits} merge commit{}. The first planner slice intentionally refuses to flatten merge topology.", if merge_commits == 1 { "" } else { "s" }))
        } else { None };

        let list = checked(path, &["rev-list", "--reverse", "--topo-order", "--no-merges", &range])?.stdout;
        let mut commits = Vec::new();
        for commit in list.lines().map(str::trim).filter(|line| !line.is_empty()) {
            commits.push(commit_record(path, commit)?);
        }

        let warnings = if target_commit == base {
            Vec::new()
        } else {
            vec!["The selected target is not the current branch's merge base. GitAhead will replay the branch commits from the common base onto the selected target.".into()]
        };

        Ok(RebasePlan {
            target: target.to_string(),
            target_commit,
            base,
            head,
            commits,
            warnings,
            blocked_reason,
            supports_update_refs: supports_update_refs(path),
        })
    }

    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    fn sanitize_subject(subject: &str) -> String {
        subject.replace(['\r', '\n'], " ")
    }

    fn update_refs_by_commit(path: &str, commits: &HashSet<String>) -> AppResult<HashMap<String, Vec<String>>> {
        let checked_out: HashSet<String> = checked(path, &["worktree", "list", "--porcelain"])?.stdout
            .lines()
            .filter_map(|line| line.strip_prefix("branch "))
            .map(str::to_string)
            .collect();
        let refs = checked(path, &["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"])?.stdout;
        let mut by_commit: HashMap<String, Vec<String>> = HashMap::new();
        for line in refs.lines() {
            let Some((reference, commit)) = line.split_once('\0') else { continue };
            if checked_out.contains(reference) || !commits.contains(commit) { continue; }
            by_commit.entry(commit.to_string()).or_default().push(reference.to_string());
        }
        for refs in by_commit.values_mut() { refs.sort(); }
        Ok(by_commit)
    }

    fn build_todo(items: &[RebasePlanItem], update_refs: &HashMap<String, Vec<String>>) -> AppResult<String> {
        let mut todo = String::new();
        let mut previous_kept = false;
        for item in items {
            let action = item.action.as_str();
            if !matches!(action, "pick" | "reword" | "edit" | "squash" | "fixup" | "drop") {
                return Err(AppError::Invalid(format!("unknown rebase action: {action}")));
            }
            if matches!(action, "squash" | "fixup") && !previous_kept {
                return Err(AppError::Invalid(format!("{} cannot be the first surviving action in an interactive rebase", action)));
            }
            let subject = sanitize_subject(&item.subject);
            match action {
                "reword" => {
                    let message = item.new_message.as_deref().map(str::trim).filter(|value| !value.is_empty())
                        .ok_or_else(|| AppError::Invalid(format!("reword for {} requires a new commit message", item.commit)))?;
                    todo.push_str(&format!("pick {} {}\n", item.commit, subject));
                    todo.push_str(&format!("exec git commit --amend -m {}\n", shell_quote(message)));
                    previous_kept = true;
                }
                "drop" => {
                    todo.push_str(&format!("drop {} {}\n", item.commit, subject));
                }
                _ => {
                    todo.push_str(&format!("{} {} {}\n", action, item.commit, subject));
                    previous_kept = true;
                }
            }
            if let Some(references) = update_refs.get(&item.commit) {
                for reference in references { todo.push_str(&format!("update-ref {}\n", reference)); }
            }
        }
        if !previous_kept {
            return Err(AppError::Invalid("the plan drops every commit; use reset/branch operations for that history rewrite instead".into()));
        }
        Ok(todo)
    }

    fn normalized_script_path(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    pub fn start_rebase_plan(path: &str, request: &RebaseStartRequest) -> AppResult<RebaseStartResult> {
        let current = prepare_rebase_plan(path, &request.target)?;
        if let Some(reason) = current.blocked_reason.as_ref() {
            return Err(AppError::Invalid(reason.clone()));
        }
        if request.base != current.base {
            return Err(AppError::Invalid("the rebase base changed since the plan was loaded; refresh the plan before starting".into()));
        }

        let expected: HashSet<String> = current.commits.iter().map(|item| item.commit.clone()).collect();
        let supplied: HashSet<String> = request.items.iter().map(|item| item.commit.clone()).collect();
        if expected != supplied || supplied.len() != request.items.len() {
            return Err(AppError::Invalid("the submitted rebase plan does not contain exactly the commits from the current plan".into()));
        }

        let update_refs = if request.update_refs {
            if !current.supports_update_refs {
                return Err(AppError::Unsupported("this Git version does not support rebase --update-refs".into()));
            }
            update_refs_by_commit(path, &expected)?
        } else { HashMap::new() };
        let todo = build_todo(&request.items, &update_refs)?;
        let git_dir = git_dir(path)?;
        let todo_path = git_dir.join("gitahead-rebase-todo");
        let editor_path = git_dir.join("gitahead-sequence-editor.sh");
        fs::write(&todo_path, todo)?;
        fs::write(&editor_path, "#!/bin/sh\ncat \"$GITAHEAD_REBASE_TODO\" > \"$1\"\n")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&editor_path)?.permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&editor_path, permissions)?;
        }

        let sequence_editor = format!("sh {}", shell_quote(&normalized_script_path(&editor_path)));
        let mut command = Command::new("git");
        command.arg("-C").arg(path)
            .arg("rebase").arg("--interactive");
        if request.update_refs { command.arg("--update-refs"); }
        command.arg("--onto").arg(&current.target_commit)
            .arg(&current.base);
        command.env("GIT_TERMINAL_PROMPT", "0");
        command.env("GIT_SEQUENCE_EDITOR", sequence_editor);
        command.env("GITAHEAD_REBASE_TODO", normalized_script_path(&todo_path));
        command.env("GIT_EDITOR", "true");
        let output = command.output()?;
        let result = command_result(output);
        let state = operation_state::repository_operation_state(path)?;

        let _ = fs::remove_file(&todo_path);
        let _ = fs::remove_file(&editor_path);

        if result.exit_code != 0 && state.operation.is_none() {
            return Err(AppError::Command(format!("git rebase --interactive: {}", result.stderr.trim())));
        }

        Ok(RebaseStartResult { result, operation: state })
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::*;

    pub fn prepare_rebase_plan(_path: &str, _target: &str) -> AppResult<RebasePlan> {
        Err(AppError::Unsupported("interactive rebase planning is desktop-only in this slice".into()))
    }

    pub fn start_rebase_plan(_path: &str, _request: &RebaseStartRequest) -> AppResult<RebaseStartResult> {
        Err(AppError::Unsupported("interactive rebase execution is desktop-only in this slice".into()))
    }
}

#[cfg(not(target_os = "android"))]
pub use desktop::{prepare_rebase_plan, start_rebase_plan};
#[cfg(target_os = "android")]
pub use android::{prepare_rebase_plan, start_rebase_plan};

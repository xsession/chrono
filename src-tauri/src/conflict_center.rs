use crate::error::{AppError, AppResult};
use crate::models::{
    ConflictFileDetail, ConflictFileSummary, ConflictLabels, ConflictResolutionRequest,
    ConflictResolutionResult, ConflictStage,
};

#[cfg(not(target_os = "android"))]
mod desktop {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Component, Path, PathBuf};
    use std::process::{Command, Output};

    use super::*;

    const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

    #[derive(Debug, Clone)]
    struct StageEntry {
        mode: String,
        oid: String,
    }

    #[derive(Debug, Clone, Default)]
    struct ConflictEntries {
        base: Option<StageEntry>,
        current: Option<StageEntry>,
        incoming: Option<StageEntry>,
    }

    fn run_git(path: &str, args: &[&str]) -> AppResult<Output> {
        let mut command = Command::new("git");
        command.arg("-C").arg(path).args(args);
        command.env("GIT_TERMINAL_PROMPT", "0");
        Ok(command.output()?)
    }

    fn checked_git(path: &str, args: &[&str]) -> AppResult<Output> {
        let output = run_git(path, args)?;
        if output.status.success() {
            Ok(output)
        } else {
            Err(AppError::Command(format!(
                "git {}: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }

    fn repository_root(path: &str) -> AppResult<PathBuf> {
        let output = checked_git(path, &["rev-parse", "--show-toplevel"])?;
        Ok(PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
    }

    fn parse_conflicts(path: &str) -> AppResult<BTreeMap<String, ConflictEntries>> {
        let output = checked_git(path, &["ls-files", "--unmerged", "-z", "--"])?;
        let mut conflicts: BTreeMap<String, ConflictEntries> = BTreeMap::new();

        for record in output.stdout.split(|byte| *byte == 0).filter(|record| !record.is_empty()) {
            let Some(tab) = record.iter().position(|byte| *byte == b'\t') else { continue; };
            let header = String::from_utf8_lossy(&record[..tab]);
            let path = String::from_utf8_lossy(&record[tab + 1..]).into_owned();
            let mut fields = header.split_whitespace();
            let Some(mode) = fields.next() else { continue; };
            let Some(oid) = fields.next() else { continue; };
            let Some(stage) = fields.next().and_then(|value| value.parse::<u8>().ok()) else { continue; };
            let entry = StageEntry { mode: mode.to_string(), oid: oid.to_string() };
            let stages = conflicts.entry(path).or_default();
            match stage {
                1 => stages.base = Some(entry),
                2 => stages.current = Some(entry),
                3 => stages.incoming = Some(entry),
                _ => {}
            }
        }

        Ok(conflicts)
    }

    fn path_is_safe(path: &str) -> bool {
        let candidate = Path::new(path);
        !candidate.is_absolute()
            && candidate.components().all(|component| matches!(component, Component::Normal(_)))
    }

    fn stage_kind(mode: &str) -> &'static str {
        match mode {
            "160000" => "gitlink",
            "120000" => "symlink",
            _ => "blob",
        }
    }

    fn blob_size(path: &str, oid: &str) -> AppResult<usize> {
        let output = checked_git(path, &["cat-file", "-s", oid])?;
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<usize>()
            .map_err(|_| AppError::Invalid(format!("invalid blob size for {oid}")))
    }

    fn stage_detail(path: &str, entry: &StageEntry) -> AppResult<ConflictStage> {
        let kind = stage_kind(&entry.mode).to_string();
        if kind == "gitlink" {
            return Ok(ConflictStage {
                oid: entry.oid.clone(),
                mode: entry.mode.clone(),
                kind,
                text: None,
                binary: false,
                truncated: false,
                size: 0,
            });
        }

        let size = blob_size(path, &entry.oid)?;
        if size > MAX_TEXT_BYTES {
            return Ok(ConflictStage {
                oid: entry.oid.clone(),
                mode: entry.mode.clone(),
                kind,
                text: None,
                binary: false,
                truncated: true,
                size,
            });
        }

        let output = checked_git(path, &["cat-file", "blob", &entry.oid])?;
        let binary = output.stdout.iter().any(|byte| *byte == 0) || std::str::from_utf8(&output.stdout).is_err();
        let text = if binary { None } else { Some(String::from_utf8(output.stdout).unwrap_or_default()) };
        Ok(ConflictStage {
            oid: entry.oid.clone(),
            mode: entry.mode.clone(),
            kind,
            text,
            binary,
            truncated: false,
            size,
        })
    }

    fn conflict_kind(entries: &ConflictEntries) -> String {
        match (entries.base.is_some(), entries.current.is_some(), entries.incoming.is_some()) {
            (false, true, true) => "addAdd",
            (true, false, true) => "currentDeleted",
            (true, true, false) => "incomingDeleted",
            (true, true, true) => "content",
            (true, false, false) => "bothDeleted",
            _ => "complex",
        }.to_string()
    }

    fn labels(path: &str) -> ConflictLabels {
        let operation = crate::operation_state::repository_operation_state(path).ok().and_then(|state| state.operation);
        let (current, incoming) = match operation.as_deref() {
            Some("rebase") => ("Current base", "Replayed commit"),
            Some("cherryPick") => ("Current branch", "Cherry-picked commit"),
            Some("revert") => ("Current branch", "Revert result"),
            Some("merge") => ("Current branch", "Incoming branch"),
            _ => ("Current version", "Incoming version"),
        };
        ConflictLabels { base: "Base".into(), current: current.into(), incoming: incoming.into() }
    }

    fn safe_working_target(root: &Path, relative: &str) -> AppResult<PathBuf> {
        let canonical_root = fs::canonicalize(root)?;
        let target = root.join(relative);
        let mut ancestor = target.parent().unwrap_or(root);
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or_else(|| AppError::Invalid("conflict path has no existing repository ancestor".into()))?;
        }
        let canonical_ancestor = fs::canonicalize(ancestor)?;
        if !canonical_ancestor.starts_with(&canonical_root) {
            return Err(AppError::Invalid("conflict path escapes the repository through a symbolic-link parent".into()));
        }
        Ok(target)
    }

    fn read_working(root: &Path, relative: &str) -> AppResult<(Option<String>, bool, bool, usize)> {
        let file = safe_working_target(root, relative)?;
        let metadata = match fs::symlink_metadata(&file) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((None, false, false, 0)),
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            return Ok((None, false, false, 0));
        }
        if !metadata.is_file() {
            return Ok((None, true, false, metadata.len() as usize));
        }
        let size = metadata.len() as usize;
        if size > MAX_TEXT_BYTES {
            return Ok((None, false, true, size));
        }
        let bytes = fs::read(&file)?;
        let binary = bytes.iter().any(|byte| *byte == 0) || std::str::from_utf8(&bytes).is_err();
        let text = if binary { None } else { String::from_utf8(bytes).ok() };
        Ok((text, binary, false, size))
    }

    fn summarize(path: &str, relative: &str, entries: &ConflictEntries) -> AppResult<ConflictFileSummary> {
        let mut special = false;
        let mut too_large = false;
        for entry in [&entries.base, &entries.current, &entries.incoming].into_iter().flatten() {
            let kind = stage_kind(&entry.mode);
            special |= kind != "blob";
            if kind != "gitlink" {
                too_large |= blob_size(path, &entry.oid)? > MAX_TEXT_BYTES;
            }
        }
        Ok(ConflictFileSummary {
            path: relative.to_string(),
            kind: conflict_kind(entries),
            has_base: entries.base.is_some(),
            has_current: entries.current.is_some(),
            has_incoming: entries.incoming.is_some(),
            binary: false,
            special,
            too_large,
        })
    }

    pub fn repository_conflicts(path: &str) -> AppResult<Vec<ConflictFileSummary>> {
        parse_conflicts(path)?
            .iter()
            .map(|(relative, entries)| summarize(path, relative, entries))
            .collect()
    }

    pub fn conflict_detail(path: &str, relative: &str) -> AppResult<ConflictFileDetail> {
        if !path_is_safe(relative) {
            return Err(AppError::Invalid("conflict path is not a safe repository-relative path".into()));
        }
        let conflicts = parse_conflicts(path)?;
        let entries = conflicts.get(relative).ok_or_else(|| AppError::Invalid(format!("{relative} is not currently conflicted")))?;
        let root = repository_root(path)?;
        let (working_text, working_binary, working_truncated, working_size) = read_working(&root, relative)?;
        Ok(ConflictFileDetail {
            path: relative.to_string(),
            kind: conflict_kind(entries),
            labels: labels(path),
            base: entries.base.as_ref().map(|entry| stage_detail(path, entry)).transpose()?,
            current: entries.current.as_ref().map(|entry| stage_detail(path, entry)).transpose()?,
            incoming: entries.incoming.as_ref().map(|entry| stage_detail(path, entry)).transpose()?,
            working_text,
            working_binary,
            working_truncated,
            working_size,
        })
    }

    fn selected_stage<'a>(entries: &'a ConflictEntries, strategy: &str) -> Option<&'a StageEntry> {
        match strategy {
            "current" => entries.current.as_ref(),
            "incoming" => entries.incoming.as_ref(),
            _ => None,
        }
    }

    fn remove_working_path(root: &Path, relative: &str) -> AppResult<()> {
        let target = safe_working_target(root, relative)?;
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                return Err(AppError::Invalid("refusing to recursively remove a directory while resolving a file conflict".into()));
            }
            Ok(_) => fs::remove_file(&target)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    fn stage_deletion(path: &str, root: &Path, relative: &str, gitlink: bool) -> AppResult<()> {
        if gitlink {
            checked_git(path, &["update-index", "--force-remove", "--", relative])?;
            return Ok(());
        }
        remove_working_path(root, relative)?;
        checked_git(path, &["add", "-A", "--", relative])?;
        Ok(())
    }

    fn resolve_side(path: &str, root: &Path, relative: &str, entries: &ConflictEntries, strategy: &str) -> AppResult<()> {
        let Some(stage) = selected_stage(entries, strategy) else {
            let gitlink = [entries.base.as_ref(), entries.current.as_ref(), entries.incoming.as_ref()]
                .into_iter().flatten().any(|entry| stage_kind(&entry.mode) == "gitlink");
            return stage_deletion(path, root, relative, gitlink);
        };

        if stage_kind(&stage.mode) == "gitlink" {
            checked_git(path, &["update-index", "--add", "--cacheinfo", &stage.mode, &stage.oid, relative])?;
            return Ok(());
        }

        let stage_number = if strategy == "current" { "2" } else { "3" };
        let stage_arg = format!("--stage={stage_number}");
        checked_git(path, &["checkout-index", &stage_arg, "--force", "--", relative])?;
        checked_git(path, &["add", "-A", "--", relative])?;
        Ok(())
    }

    fn apply_executable_mode(target: &Path, entries: &ConflictEntries) -> AppResult<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = [entries.current.as_ref(), entries.incoming.as_ref(), entries.base.as_ref()]
                .into_iter().flatten().find(|entry| entry.mode == "100755").is_some();
            if executable && target.exists() {
                let mut permissions = fs::metadata(target)?.permissions();
                permissions.set_mode(0o755);
                fs::set_permissions(target, permissions)?;
            }
        }
        Ok(())
    }

    fn resolve_merged(path: &str, root: &Path, relative: &str, entries: &ConflictEntries, content: &str) -> AppResult<()> {
        let special = [entries.base.as_ref(), entries.current.as_ref(), entries.incoming.as_ref()]
            .into_iter().flatten().any(|entry| stage_kind(&entry.mode) != "blob");
        if special {
            return Err(AppError::Invalid("manual text editing is disabled for symlink and submodule conflicts; choose a side instead".into()));
        }
        let target = safe_working_target(root, relative)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        if fs::symlink_metadata(&target).map(|metadata| metadata.file_type().is_symlink()).unwrap_or(false) {
            fs::remove_file(&target)?;
        }
        fs::write(&target, content.as_bytes())?;
        apply_executable_mode(&target, entries)?;
        checked_git(path, &["add", "-A", "--", relative])?;
        Ok(())
    }

    pub fn resolve_conflict(path: &str, request: &ConflictResolutionRequest) -> AppResult<ConflictResolutionResult> {
        if !path_is_safe(&request.file) {
            return Err(AppError::Invalid("conflict path is not a safe repository-relative path".into()));
        }
        let conflicts = parse_conflicts(path)?;
        let entries = conflicts.get(&request.file).ok_or_else(|| AppError::Invalid(format!("{} is not currently conflicted", request.file)))?;
        let root = repository_root(path)?;

        match request.strategy.as_str() {
            "current" | "incoming" => resolve_side(path, &root, &request.file, entries, &request.strategy)?,
            "merged" => {
                let content = request.content.as_deref().ok_or_else(|| AppError::Invalid("merged resolution requires content".into()))?;
                resolve_merged(path, &root, &request.file, entries, content)?;
            }
            "working" => { checked_git(path, &["add", "-A", "--", &request.file])?; }
            "delete" => {
                let gitlink = [entries.base.as_ref(), entries.current.as_ref(), entries.incoming.as_ref()]
                    .into_iter().flatten().any(|entry| stage_kind(&entry.mode) == "gitlink");
                stage_deletion(path, &root, &request.file, gitlink)?;
            }
            _ => return Err(AppError::Invalid(format!("unknown conflict resolution strategy: {}", request.strategy))),
        }

        let remaining = parse_conflicts(path)?;
        let next_path = remaining.keys()
            .find(|candidate| candidate.as_str() > request.file.as_str())
            .cloned()
            .or_else(|| remaining.keys().next().cloned());
        Ok(ConflictResolutionResult {
            remaining: remaining.len(),
            next_path,
        })
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::*;

    pub fn repository_conflicts(_path: &str) -> AppResult<Vec<ConflictFileSummary>> {
        Err(AppError::Unsupported("the three-way Conflict Center is currently desktop-only".into()))
    }

    pub fn conflict_detail(_path: &str, _relative: &str) -> AppResult<ConflictFileDetail> {
        Err(AppError::Unsupported("the three-way Conflict Center is currently desktop-only".into()))
    }

    pub fn resolve_conflict(_path: &str, _request: &ConflictResolutionRequest) -> AppResult<ConflictResolutionResult> {
        Err(AppError::Unsupported("conflict resolution actions are currently desktop-only".into()))
    }
}

#[cfg(not(target_os = "android"))]
pub use desktop::{conflict_detail, repository_conflicts, resolve_conflict};
#[cfg(target_os = "android")]
pub use android::{conflict_detail, repository_conflicts, resolve_conflict};

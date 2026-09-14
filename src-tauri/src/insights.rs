use crate::error::{AppError, AppResult};
use crate::models::{
    BlameLine, BlameResult, CommitDetails, CommitFileChange, CommitRecord, CommitSearchResult,
    ContributorRecord, FileHistoryRequest, HistoryChangeStat, RefComparison, SearchRequest,
    WorktreeSummary,
};

#[cfg(not(target_os = "android"))]
mod desktop {
    use std::collections::HashMap;
    use std::process::{Command, Output};

    use super::*;

    fn run_git(path: &str, args: &[String]) -> AppResult<Output> {
        let mut command = Command::new("git");
        command.arg("-C").arg(path).args(args);
        command.env("GIT_TERMINAL_PROMPT", "0");
        Ok(command.output()?)
    }

    fn checked(path: &str, args: &[String]) -> AppResult<String> {
        let output = run_git(path, args)?;
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        if output.status.success() {
            Ok(stdout)
        } else {
            Err(AppError::Command(format!("git {}: {}", args.join(" "), stderr.trim())))
        }
    }

    fn commit_format() -> &'static str {
        "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e"
    }

    fn parse_commits(output: &str) -> Vec<CommitRecord> {
        output.split('\u{1e}').filter_map(|record| {
            let fields: Vec<&str> = record.trim().split('\u{1f}').collect();
            (fields.len() == 6).then(|| CommitRecord {
                id: fields[0].to_string(),
                parents: fields[1].split_whitespace().map(str::to_string).collect(),
                author_name: fields[2].to_string(),
                author_email: fields[3].to_string(),
                authored_at: fields[4].to_string(),
                subject: fields[5].to_string(),
            })
        }).collect()
    }

    fn tokenize(input: &str) -> Vec<String> {
        let mut output = Vec::new();
        let mut current = String::new();
        let mut quote: Option<char> = None;
        let mut escaped = false;
        for ch in input.chars() {
            if escaped {
                current.push(ch);
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if let Some(marker) = quote {
                if ch == marker { quote = None; } else { current.push(ch); }
                continue;
            }
            if matches!(ch, '\'' | '"') {
                quote = Some(ch);
            } else if ch.is_whitespace() {
                if !current.is_empty() { output.push(std::mem::take(&mut current)); }
            } else {
                current.push(ch);
            }
        }
        if !current.is_empty() { output.push(current); }
        output
    }

    fn safe_revision(value: &str) -> AppResult<String> {
        let value = value.trim();
        if value.is_empty() || value.starts_with('-') || value.contains('\0') {
            return Err(AppError::Invalid("invalid revision or range".into()));
        }
        Ok(value.to_string())
    }

    fn current_identity(path: &str) -> String {
        let name = checked(path, &["config".into(), "user.name".into()]).unwrap_or_default().trim().to_string();
        let email = checked(path, &["config".into(), "user.email".into()]).unwrap_or_default().trim().to_string();
        if !email.is_empty() { email } else { name }
    }

    pub fn search_commits(path: &str, request: &SearchRequest) -> AppResult<CommitSearchResult> {
        let mut messages = Vec::<String>::new();
        let mut authors = Vec::<String>::new();
        let mut files = Vec::<String>::new();
        let mut changes = Vec::<String>::new();
        let mut revision: Option<String> = None;
        let mut commit_exact: Option<String> = None;

        for token in tokenize(&request.query) {
            let Some((prefix, value)) = token.split_once(':') else {
                if token == "@me" {
                    let identity = current_identity(path);
                    if !identity.is_empty() { authors.push(identity); }
                } else {
                    messages.push(token);
                }
                continue;
            };
            if value.trim().is_empty() { continue; }
            match prefix.to_ascii_lowercase().as_str() {
                "message" | "msg" => messages.push(value.to_string()),
                "author" => authors.push(value.to_string()),
                "file" => files.push(value.to_string()),
                "change" | "patch" => changes.push(value.to_string()),
                "ref" | "range" => revision = Some(safe_revision(value)?),
                "commit" | "sha" => commit_exact = Some(safe_revision(value)?),
                _ => messages.push(token),
            }
        }

        let limit = request.limit.clamp(1, 1000).to_string();
        let mut args = vec!["log".into(), "--date=iso-strict".into(), format!("--pretty=format:{}", commit_format()), "-n".into(), limit];
        if let Some(commit) = commit_exact.as_ref() {
            args.push(commit.clone());
            args.push("--no-walk".into());
        } else {
            args.push(revision.unwrap_or_else(|| "--all".into()));
        }
        if messages.len() > 1 { args.push("--all-match".into()); }
        for value in &messages { args.push(format!("--grep={value}")); }
        for value in &authors { args.push(format!("--author={value}")); }
        for value in &changes { args.push(format!("-G{value}")); }
        if !files.is_empty() {
            args.push("--".into());
            args.extend(files.iter().cloned());
        }
        let output = checked(path, &args)?;
        Ok(CommitSearchResult { query: request.query.clone(), commits: parse_commits(&output) })
    }

    fn parse_numstat(output: &str) -> Vec<CommitFileChange> {
        output.lines().filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let add = fields.next()?;
            let del = fields.next()?;
            let path = fields.next()?.to_string();
            Some(CommitFileChange {
                path,
                additions: (add != "-").then(|| add.parse().unwrap_or(0)),
                deletions: (del != "-").then(|| del.parse().unwrap_or(0)),
                binary: add == "-" || del == "-",
            })
        }).collect()
    }

    pub fn commit_details(path: &str, commit: &str) -> AppResult<CommitDetails> {
        let revision = safe_revision(commit)?;
        let metadata = checked(path, &["show".into(), "-s".into(), "--date=iso-strict".into(), "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%B".into(), revision.clone()])?;
        let fields: Vec<&str> = metadata.trim().splitn(7, '\u{1f}').collect();
        if fields.len() != 7 { return Err(AppError::Command("unable to parse commit details".into())); }
        let files = parse_numstat(&checked(path, &["show".into(), "--numstat".into(), "--format=".into(), "--find-renames".into(), revision])?);
        let additions = files.iter().filter_map(|file| file.additions).sum();
        let deletions = files.iter().filter_map(|file| file.deletions).sum();
        Ok(CommitDetails {
            id: fields[0].to_string(),
            parents: fields[1].split_whitespace().map(str::to_string).collect(),
            author_name: fields[2].to_string(),
            author_email: fields[3].to_string(),
            authored_at: fields[4].to_string(),
            subject: fields[5].to_string(),
            body: fields[6].trim().to_string(),
            additions,
            deletions,
            files,
        })
    }

    pub fn history_change_stats(path: &str, limit: usize) -> AppResult<Vec<HistoryChangeStat>> {
        let limit = limit.clamp(1, 1000).to_string();
        let output = checked(path, &["log".into(), "-n".into(), limit, "--format=@@%H".into(), "--numstat".into(), "--no-renames".into()])?;
        let mut result = Vec::new();
        let mut current: Option<HistoryChangeStat> = None;
        for line in output.lines() {
            if let Some(id) = line.strip_prefix("@@") {
                if let Some(stat) = current.take() { result.push(stat); }
                current = Some(HistoryChangeStat { commit: id.trim().to_string(), additions: 0, deletions: 0, files_changed: 0, binary_files: 0 });
                continue;
            }
            let Some(stat) = current.as_mut() else { continue };
            let mut fields = line.splitn(3, '\t');
            let Some(add) = fields.next() else { continue };
            let Some(del) = fields.next() else { continue };
            if fields.next().is_none() { continue; }
            stat.files_changed += 1;
            if add == "-" || del == "-" { stat.binary_files += 1; }
            if add != "-" { stat.additions = stat.additions.saturating_add(add.parse().unwrap_or(0)); }
            if del != "-" { stat.deletions = stat.deletions.saturating_add(del.parse().unwrap_or(0)); }
        }
        if let Some(stat) = current { result.push(stat); }
        Ok(result)
    }

    fn commits_for_range(path: &str, range: &str, limit: usize) -> AppResult<Vec<CommitRecord>> {
        let output = checked(path, &["log".into(), "--date=iso-strict".into(), format!("--pretty=format:{}", commit_format()), "-n".into(), limit.clamp(1, 500).to_string(), range.into()])?;
        Ok(parse_commits(&output))
    }

    fn diff_numstat(path: &str, from: &str, to: &str) -> AppResult<Vec<CommitFileChange>> {
        let range = format!("{from}..{to}");
        Ok(parse_numstat(&checked(path, &["diff".into(), "--numstat".into(), "--find-renames".into(), range])?))
    }

    pub fn compare_refs(path: &str, left: &str, right: &str, limit: usize) -> AppResult<RefComparison> {
        let left = safe_revision(left)?;
        let right = safe_revision(right)?;
        let left_id = checked(path, &["rev-parse".into(), "--verify".into(), format!("{left}^{{commit}}")])?.trim().to_string();
        let right_id = checked(path, &["rev-parse".into(), "--verify".into(), format!("{right}^{{commit}}")])?.trim().to_string();
        let merge_base = checked(path, &["merge-base".into(), left_id.clone(), right_id.clone()])?.trim().to_string();
        let counts = checked(path, &["rev-list".into(), "--left-right".into(), "--count".into(), format!("{left_id}...{right_id}")])?;
        let mut count_fields = counts.split_whitespace();
        let left_only_count = count_fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let right_only_count = count_fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let left_only = commits_for_range(path, &format!("{right_id}..{left_id}"), limit)?;
        let right_only = commits_for_range(path, &format!("{left_id}..{right_id}"), limit)?;
        let files_from_base_to_left = diff_numstat(path, &merge_base, &left_id)?;
        let files_from_base_to_right = diff_numstat(path, &merge_base, &right_id)?;
        Ok(RefComparison {
            left,
            right,
            left_id,
            right_id,
            merge_base,
            left_only_count,
            right_only_count,
            left_only,
            right_only,
            files_from_base_to_left,
            files_from_base_to_right,
        })
    }

    pub fn file_history(path: &str, request: &FileHistoryRequest) -> AppResult<Vec<CommitRecord>> {
        let file = request.file.trim();
        if file.is_empty() { return Err(AppError::Invalid("file path is required".into())); }
        let mut args = vec!["log".into(), "--date=iso-strict".into(), format!("--pretty=format:{}", commit_format()), "-n".into(), request.limit.clamp(1, 1000).to_string()];
        if request.all_refs { args.push("--all".into()); }
        if request.follow_renames { args.push("--follow".into()); }
        args.push("--".into());
        args.push(file.to_string());
        Ok(parse_commits(&checked(path, &args)?))
    }

    pub fn line_history(path: &str, file: &str, start: usize, end: usize, limit: usize) -> AppResult<Vec<CommitRecord>> {
        let file = file.trim();
        if file.is_empty() || start == 0 || end < start { return Err(AppError::Invalid("valid file and 1-based line range are required".into())); }
        let range = format!("{start},{end}:{file}");
        let args = vec!["log".into(), "-L".into(), range, "--date=iso-strict".into(), format!("--format={}", commit_format()), "--no-patch".into(), "-n".into(), limit.clamp(1, 500).to_string()];
        Ok(parse_commits(&checked(path, &args)?))
    }

    pub fn blame_file(path: &str, file: &str, revision: Option<&str>, ignore_whitespace: bool, limit: usize) -> AppResult<BlameResult> {
        let file = file.trim();
        if file.is_empty() { return Err(AppError::Invalid("file path is required".into())); }
        let mut args = vec!["blame".into(), "--line-porcelain".into()];
        if ignore_whitespace { args.push("-w".into()); }
        if let Some(revision) = revision.map(str::trim).filter(|value| !value.is_empty()) { args.push(safe_revision(revision)?); }
        args.push("--".into());
        args.push(file.to_string());
        let output = checked(path, &args)?;
        let mut lines = Vec::new();
        let mut iter = output.lines().peekable();
        while let Some(header) = iter.next() {
            let mut head = header.split_whitespace();
            let Some(commit) = head.next() else { continue };
            let _original = head.next();
            let final_line = head.next().and_then(|value| value.parse::<usize>().ok()).unwrap_or(lines.len() + 1);
            if commit.len() < 8 { continue; }
            let mut author = String::new();
            let mut author_email = String::new();
            let mut authored_at = 0i64;
            let mut summary = String::new();
            let mut content = String::new();
            while let Some(next) = iter.next() {
                if let Some(value) = next.strip_prefix("author ") { author = value.to_string(); }
                else if let Some(value) = next.strip_prefix("author-mail ") { author_email = value.trim_matches(|ch| ch == '<' || ch == '>').to_string(); }
                else if let Some(value) = next.strip_prefix("author-time ") { authored_at = value.parse().unwrap_or(0); }
                else if let Some(value) = next.strip_prefix("summary ") { summary = value.to_string(); }
                else if let Some(value) = next.strip_prefix('\t') { content = value.to_string(); break; }
            }
            lines.push(BlameLine { line_number: final_line, commit: commit.to_string(), author, author_email, authored_at, summary, content });
            if lines.len() > limit { break; }
        }
        let truncated = lines.len() > limit;
        if truncated { lines.truncate(limit); }
        Ok(BlameResult { file: file.to_string(), lines, truncated })
    }

    pub fn contributors(path: &str, max_commits: usize) -> AppResult<Vec<ContributorRecord>> {
        let output = checked(path, &["log".into(), "--all".into(), format!("-n{}", max_commits.clamp(1, 100_000)), "--date=iso-strict".into(), "--format=%an%x1f%ae%x1f%aI%x1e".into()])?;
        #[derive(Default)]
        struct Acc { name: String, email: String, commits: usize, first: String, last: String }
        let mut map: HashMap<String, Acc> = HashMap::new();
        for record in output.split('\u{1e}') {
            let fields: Vec<&str> = record.trim().split('\u{1f}').collect();
            if fields.len() != 3 { continue; }
            let key = if fields[1].is_empty() { fields[0].to_ascii_lowercase() } else { fields[1].to_ascii_lowercase() };
            let entry = map.entry(key).or_default();
            entry.name = fields[0].to_string();
            entry.email = fields[1].to_string();
            entry.commits += 1;
            let date = fields[2].to_string();
            if entry.last.is_empty() || date > entry.last { entry.last = date.clone(); }
            if entry.first.is_empty() || date < entry.first { entry.first = date; }
        }
        let mut records: Vec<ContributorRecord> = map.into_values().map(|entry| ContributorRecord {
            name: entry.name,
            email: entry.email,
            commits: entry.commits,
            first_commit: entry.first,
            last_commit: entry.last,
        }).collect();
        records.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| a.name.cmp(&b.name)));
        Ok(records)
    }

    fn is_conflict_code(code: &str) -> bool {
        matches!(code, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") || code.contains('U')
    }

    pub fn worktree_summaries(path: &str) -> AppResult<Vec<WorktreeSummary>> {
        let output = checked(path, &["worktree".into(), "list".into(), "--porcelain".into()])?;
        let blocks: Vec<&str> = output.split("\n\n").filter(|block| !block.trim().is_empty()).collect();
        let mut result = Vec::new();
        for (index, block) in blocks.iter().enumerate() {
            let mut worktree_path = String::new();
            let mut head = String::new();
            let mut branch: Option<String> = None;
            let mut locked: Option<String> = None;
            let mut prunable: Option<String> = None;
            for line in block.lines() {
                let (key, value) = line.split_once(' ').unwrap_or((line, ""));
                match key {
                    "worktree" => worktree_path = value.to_string(),
                    "HEAD" => head = value.to_string(),
                    "branch" => branch = Some(value.trim_start_matches("refs/heads/").to_string()),
                    "detached" => branch = None,
                    "locked" => locked = Some(if value.is_empty() { "Locked".into() } else { value.into() }),
                    "prunable" => prunable = Some(if value.is_empty() { "Prunable".into() } else { value.into() }),
                    _ => {}
                }
            }
            if worktree_path.is_empty() { continue; }
            let status = checked(&worktree_path, &["status".into(), "--porcelain=v1".into()]).unwrap_or_default();
            let entries: Vec<&str> = status.lines().filter(|entry| !entry.is_empty()).collect();
            let conflict_count = entries.iter().filter(|entry| entry.len() >= 2 && is_conflict_code(&entry[..2])).count();
            result.push(WorktreeSummary {
                path: worktree_path,
                head,
                branch,
                is_main: index == 0,
                locked,
                prunable,
                dirty_count: entries.len(),
                conflict_count,
            });
        }
        Ok(result)
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    fn unsupported<T>() -> AppResult<T> { Err(AppError::Unsupported("Git intelligence workbench is desktop-only in this slice".into())) }
    pub fn search_commits(_path: &str, _request: &SearchRequest) -> AppResult<CommitSearchResult> { unsupported() }
    pub fn commit_details(_path: &str, _commit: &str) -> AppResult<CommitDetails> { unsupported() }
    pub fn history_change_stats(_path: &str, _limit: usize) -> AppResult<Vec<HistoryChangeStat>> { unsupported() }
    pub fn compare_refs(_path: &str, _left: &str, _right: &str, _limit: usize) -> AppResult<RefComparison> { unsupported() }
    pub fn file_history(_path: &str, _request: &FileHistoryRequest) -> AppResult<Vec<CommitRecord>> { unsupported() }
    pub fn line_history(_path: &str, _file: &str, _start: usize, _end: usize, _limit: usize) -> AppResult<Vec<CommitRecord>> { unsupported() }
    pub fn blame_file(_path: &str, _file: &str, _revision: Option<&str>, _ignore_whitespace: bool, _limit: usize) -> AppResult<BlameResult> { unsupported() }
    pub fn contributors(_path: &str, _max_commits: usize) -> AppResult<Vec<ContributorRecord>> { unsupported() }
    pub fn worktree_summaries(_path: &str) -> AppResult<Vec<WorktreeSummary>> { unsupported() }
}

#[cfg(not(target_os = "android"))]
pub use desktop::{blame_file, commit_details, compare_refs, contributors, file_history, history_change_stats, line_history, search_commits, worktree_summaries};
#[cfg(target_os = "android")]
pub use android::{blame_file, commit_details, compare_refs, contributors, file_history, history_change_stats, line_history, search_commits, worktree_summaries};

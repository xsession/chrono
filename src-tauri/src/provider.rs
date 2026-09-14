use serde_json::Value;
use crate::error::{AppError, AppResult};
use crate::models::PullRequestRecord;

pub async fn list_pull_requests(provider: &str, base_url: &str, owner: &str, repository: &str, token: &str) -> AppResult<Vec<PullRequestRecord>> {
    let client = reqwest::Client::new();
    let provider = provider.to_lowercase();
    let base = base_url.trim_end_matches('/');
    let (url, request) = match provider.as_str() {
        "github" => {
            let url = format!("{base}/repos/{owner}/{repository}/pulls?state=all&per_page=100");
            let request = client.get(&url).header("Accept", "application/vnd.github+json").bearer_auth(token);
            (url, request)
        }
        "gitlab" => {
            let project_path = format!("{owner}/{repository}");
            let project = urlencoding::encode(&project_path);
            let url = format!("{base}/projects/{project}/merge_requests?scope=all&per_page=100");
            let request = client.get(&url).header("PRIVATE-TOKEN", token);
            (url, request)
        }
        "gitea" | "forgejo" => {
            let url = format!("{base}/repos/{owner}/{repository}/pulls?state=all&limit=100");
            let request = client.get(&url).bearer_auth(token);
            (url, request)
        }
        _ => return Err(AppError::Invalid(format!("unsupported provider: {provider}"))),
    };
    let response = request.send().await?.error_for_status()?;
    let values: Vec<Value> = response.json().await?;
    values.into_iter().map(|value| normalize(&provider, value)).collect::<AppResult<Vec<_>>>()
        .map_err(|error| AppError::Command(format!("provider response from {url}: {error}")))
}
fn text(value: &Value, pointer: &str) -> String { value.pointer(pointer).and_then(Value::as_str).unwrap_or("").to_string() }
fn number(value: &Value, pointer: &str) -> u64 { value.pointer(pointer).and_then(Value::as_u64).unwrap_or(0) }
fn normalize(provider: &str, value: Value) -> AppResult<PullRequestRecord> {
    Ok(if provider == "gitlab" {
        PullRequestRecord { id: number(&value, "/id").to_string(), number: number(&value, "/iid"), title: text(&value, "/title"), author: text(&value, "/author/name"), state: text(&value, "/state"), source_branch: text(&value, "/source_branch"), target_branch: text(&value, "/target_branch"), web_url: text(&value, "/web_url"), updated_at: value.pointer("/updated_at").and_then(Value::as_str).map(str::to_string) }
    } else {
        PullRequestRecord { id: value.pointer("/id").map(ToString::to_string).unwrap_or_default(), number: number(&value, "/number"), title: text(&value, "/title"), author: text(&value, "/user/login"), state: text(&value, "/state"), source_branch: text(&value, "/head/ref"), target_branch: text(&value, "/base/ref"), web_url: { let html = text(&value, "/html_url"); if html.is_empty() { text(&value, "/url") } else { html } }, updated_at: value.pointer("/updated_at").and_then(Value::as_str).map(str::to_string) }
    })
}

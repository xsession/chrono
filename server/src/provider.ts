// Pull request providers: GitHub, GitLab, Gitea/Forgejo.
//
// Ported from `src-tauri/src/provider.rs` using Node's built-in fetch (the Rust
// backend used reqwest).

import { AppError, httpError } from "./lib/errors.ts";

export interface PullRequestRecord {
  id: string;
  number: number;
  title: string;
  author: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  updatedAt: string | null;
}

function text(value: unknown, pointer: string): string {
  let current: unknown = value;
  for (const segment of pointer.split("/").filter((segment) => segment.length > 0)) {
    if (typeof current !== "object" || current === null) return "";
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" ? current : "";
}

function number(value: unknown, pointer: string): number {
  let current: unknown = value;
  for (const segment of pointer.split("/").filter((segment) => segment.length > 0)) {
    if (typeof current !== "object" || current === null) return 0;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "number" && Number.isInteger(current) ? current : 0;
}

function normalize(provider: string, value: Record<string, unknown>): PullRequestRecord {
  if (provider === "gitlab") {
    return {
      id: String(number(value, "/id")),
      number: number(value, "/iid"),
      title: text(value, "/title"),
      author: text(value, "/author/name"),
      state: text(value, "/state"),
      sourceBranch: text(value, "/source_branch"),
      targetBranch: text(value, "/target_branch"),
      webUrl: text(value, "/web_url"),
      updatedAt: (typeof value.updated_at === "string" && value.updated_at) || null,
    };
  }
  const html = text(value, "/html_url");
  return {
    id: text(value, "/id"),
    number: number(value, "/number"),
    title: text(value, "/title"),
    author: text(value, "/user/login"),
    state: text(value, "/state"),
    sourceBranch: text(value, "/head/ref"),
    targetBranch: text(value, "/base/ref"),
    webUrl: html.length > 0 ? html : text(value, "/url"),
    updatedAt: (typeof value.updated_at === "string" && value.updated_at) || null,
  };
}

export async function listPullRequests(
  provider: string,
  baseUrl: string,
  owner: string,
  repository: string,
  token: string,
): Promise<PullRequestRecord[]> {
  const normalized = provider.toLowerCase();
  const base = baseUrl.replace(/\/+$/, "");
  let url: string;
  const headers: Record<string, string> = {};

  switch (normalized) {
    case "github":
      url = `${base}/repos/${owner}/${repository}/pulls?state=all&per_page=100`;
      headers["Accept"] = "application/vnd.github+json";
      if (token) headers["Authorization"] = `Bearer ${token}`;
      break;
    case "gitlab":
      url = `${base}/projects/${encodeURIComponent(`${owner}/${repository}`)}/merge_requests?scope=all&per_page=100`;
      if (token) headers["PRIVATE-TOKEN"] = token;
      break;
    case "gitea":
    case "forgejo":
      url = `${base}/repos/${owner}/${repository}/pulls?state=all&limit=100`;
      if (token) headers["Authorization"] = `Bearer ${token}`;
      break;
    default:
      throw new AppError("invalid", `unsupported provider: ${provider}`);
  }

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    throw httpError(`request to ${url} failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw httpError(`provider responded ${response.status} for ${url}`);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!Array.isArray(body)) {
    throw new AppError("command", `provider response from ${url}: expected a JSON array`);
  }
  return body.map((value) =>
    normalize(normalized, (value ?? {}) as Record<string, unknown>),
  );
}

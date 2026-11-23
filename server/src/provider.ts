// Pull request providers: GitHub, GitLab, Gitea/Forgejo, Bitbucket Server.
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
  if (provider === "bitbucket-server") {
    const self = (value.links as { self?: Array<{ href?: unknown }> } | undefined)?.self?.[0]?.href;
    const updated = typeof value.updatedDate === "number" ? new Date(value.updatedDate).toISOString() : null;
    return {
      id: String(number(value, "/id")),
      number: number(value, "/id"),
      title: text(value, "/title"),
      author: text(value, "/author/user/displayName") || text(value, "/author/user/name"),
      state: text(value, "/state").toLowerCase(), // OPEN | MERGED | DECLINED
      sourceBranch: text(value, "/fromRef/displayId"),
      targetBranch: text(value, "/toRef/displayId"),
      webUrl: typeof self === "string" ? self : "",
      updatedAt: updated,
    };
  }
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
    case "bitbucket-server":
      // base is the REST API root, e.g. https://bitbucket.example.com/rest/api/1.0;
      // owner is the project key (~user for personal repositories).
      url = `${base}/projects/${encodeURIComponent(owner)}/repos/${encodeURIComponent(repository)}/pull-requests?state=ALL&limit=100`;
      headers["Accept"] = "application/json";
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
  let body: unknown = await response.json().catch(() => null);
  // Bitbucket Server pages its results: { values: [...], isLastPage, ... }.
  if (normalized === "bitbucket-server" && body && typeof body === "object" && Array.isArray((body as { values?: unknown }).values)) {
    body = (body as { values: unknown[] }).values;
  }
  if (!Array.isArray(body)) {
    throw new AppError("command", `provider response from ${url}: expected a JSON array`);
  }
  return body.map((value) =>
    normalize(normalized, (value ?? {}) as Record<string, unknown>),
  );
}

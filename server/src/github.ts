// GitHub integration (github.com and GitHub Enterprise), in the spirit of
// GitKraken's: the signed-in account, your repositories for cloning and adding
// remotes, forking, pull requests (view, edit, review, comment, merge, check
// out) and issues (search, create, comment, branch per issue), plus SSH keys.
//
// Every request goes through hostingFetch, so a host's TLS options, timeout
// and remembered token (Settings → Hosting connections) apply here too.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AppError, invalidError } from "./lib/errors.ts";
import { checked, repositoryRoot, runGit } from "./lib/git.ts";
import { hostingFetch } from "./hosting.ts";
import { ciChecks, type CheckRun, type RemoteHost } from "./features.ts";

const run = promisify(execFile);

export interface GithubTarget { apiBase: string; owner: string; repository: string }

// ------------------------------------------------------------------ requests

async function gh<T>(apiBase: string, token: string, method: string, route: string, body?: unknown): Promise<T> {
  const url = /^https?:\/\//.test(route) ? route : `${apiBase.replace(/\/+$/, "")}${route}`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "chrono-git-client" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await hostingFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const data = text ? (() => { try { return JSON.parse(text) as unknown; } catch { return text; } })() : null;
  if (!response.ok) {
    const record = data && typeof data === "object" ? data as { message?: string; errors?: Array<{ message?: string; code?: string; field?: string }> } : null;
    const details = (record?.errors ?? []).map((entry) => entry.message ?? [entry.field, entry.code].filter(Boolean).join(" ")).filter(Boolean).join("; ");
    const hint = response.status === 401 ? " (sign in again: Settings → Hosting connections)" : response.status === 403 && /scope|permission|not accessible/i.test(record?.message ?? "") ? " (the token lacks a scope this needs)" : "";
    throw new AppError("http", `GitHub answered ${response.status}: ${record?.message ?? response.statusText}${details ? ` — ${details}` : ""}${hint}`);
  }
  return data as T;
}

/** Follow Link: rel="next" up to `maxPages` pages. */
async function paged<T>(apiBase: string, token: string, route: string, maxPages = 10): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = `${apiBase.replace(/\/+$/, "")}${route}${route.includes("?") ? "&" : "?"}per_page=100`;
  for (let page = 0; url && page < maxPages; page++) {
    const response = await hostingFetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "chrono-git-client", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (!response.ok) {
      const record = await response.json().catch(() => null) as { message?: string } | null;
      throw new AppError("http", `GitHub answered ${response.status}: ${record?.message ?? response.statusText}`);
    }
    out.push(...await response.json() as T[]);
    url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] ?? null;
  }
  return out;
}

const repoPath = (target: GithubTarget) => `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}`;
const requireToken = (token: string) => { if (!token) throw invalidError("connect to GitHub first (Settings → Hosting connections)"); };
const number = (value: unknown) => { const n = Number(value); if (!Number.isInteger(n) || n <= 0) throw invalidError("invalid number"); return n; };

type Json = Record<string, any>;
const user = (value: Json | null | undefined) => value ? { login: String(value.login ?? ""), avatarUrl: String(value.avatar_url ?? "") } : null;
const label = (value: Json) => ({ name: String(value.name ?? ""), color: String(value.color ?? "888888") });

// ------------------------------------------------------------------ account

export interface GithubAccount { login: string; name: string | null; avatarUrl: string; htmlUrl: string; scopes: string[] }

export async function account(apiBase: string, token: string): Promise<GithubAccount> {
  requireToken(token);
  const response = await hostingFetch(`${apiBase.replace(/\/+$/, "")}/user`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "chrono-git-client" } });
  if (!response.ok) throw new AppError("http", response.status === 401 ? "GitHub refused the token: connect again" : `GitHub answered ${response.status}`);
  const body = await response.json() as Json;
  const scopes = (response.headers.get("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);
  return { login: String(body.login), name: body.name ? String(body.name) : null, avatarUrl: String(body.avatar_url ?? ""), htmlUrl: String(body.html_url ?? ""), scopes };
}

/** GitHub's page for a new token with the scopes Chrono uses pre-selected. */
export function tokenPageUrl(apiBase: string): string {
  const web = webBase(apiBase);
  return `${web}/settings/tokens/new?description=${encodeURIComponent(`Chrono (${os.hostname()})`)}&scopes=repo,read:org,workflow,admin:public_key`;
}

/** https://api.github.com → https://github.com; https://ghe/api/v3 → https://ghe. */
export function webBase(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, "");
  if (/^https:\/\/api\.github\.com$/i.test(base)) return "https://github.com";
  return base.replace(/\/api\/v3$/i, "");
}

// ------------------------------------------------------------------ repositories

export interface GithubRepo { fullName: string; owner: string; name: string; description: string; private: boolean; fork: boolean; cloneUrl: string; sshUrl: string; htmlUrl: string; defaultBranch: string; updatedAt: string | null }
const repo = (value: Json): GithubRepo => ({
  fullName: String(value.full_name), owner: String(value.owner?.login ?? ""), name: String(value.name), description: String(value.description ?? ""),
  private: Boolean(value.private), fork: Boolean(value.fork), cloneUrl: String(value.clone_url ?? ""), sshUrl: String(value.ssh_url ?? ""),
  htmlUrl: String(value.html_url ?? ""), defaultBranch: String(value.default_branch ?? "main"), updatedAt: value.pushed_at ?? value.updated_at ?? null,
});

/** Repositories you own, collaborate on or reach through an organization, newest first. */
export async function myRepositories(apiBase: string, token: string): Promise<GithubRepo[]> {
  requireToken(token);
  const list = await paged<Json>(apiBase, token, "/user/repos?sort=pushed&affiliation=owner,collaborator,organization_member", 10);
  return list.map(repo);
}

/** Your fork of `target` (if any), and other forks to add as remotes. */
export async function forks(target: GithubTarget, token: string): Promise<{ me: string; parent: GithubRepo; mine: GithubRepo | null; others: GithubRepo[] }> {
  requireToken(token);
  const me = (await account(target.apiBase, token)).login;
  const parentRaw = await gh<Json>(target.apiBase, token, "GET", repoPath(target));
  // Forking a fork forks its source; look for yours among the source's forks.
  const source = parentRaw.fork && parentRaw.source ? parentRaw.source as Json : parentRaw;
  const parent = repo(source);
  const list = (await paged<Json>(target.apiBase, token, `/repos/${source.owner.login}/${source.name}/forks?sort=newest`, 3)).map(repo);
  let mine = list.find((entry) => entry.owner.toLowerCase() === me.toLowerCase()) ?? null;
  if (!mine && parent.owner.toLowerCase() !== me.toLowerCase()) {
    // Forks can be renamed: also ask for a repository of yours with the same name.
    const same = await gh<Json>(target.apiBase, token, "GET", `/repos/${encodeURIComponent(me)}/${encodeURIComponent(parent.name)}`).catch(() => null);
    if (same?.fork && same.parent?.full_name === parent.fullName) mine = repo(same);
  }
  return { me, parent, mine, others: list.filter((entry) => entry !== mine).slice(0, 50) };
}

/** Fork `target` into your account (or an organization). GitHub finishes the
 *  copy in the background; the clone URL is valid right away. */
export async function createFork(target: GithubTarget, token: string, organization?: string): Promise<GithubRepo> {
  requireToken(token);
  return repo(await gh<Json>(target.apiBase, token, "POST", `${repoPath(target)}/forks`, organization ? { organization } : {}));
}

// ------------------------------------------------------------------ pull requests

export interface GithubPullSummary { number: number; title: string; author: string; avatarUrl: string; draft: boolean; head: string; base: string; updatedAt: string; htmlUrl: string; labels: Array<{ name: string; color: string }>; reviewDecision?: string }

export async function openPulls(target: GithubTarget, token: string): Promise<GithubPullSummary[]> {
  const list = await paged<Json>(target.apiBase, token, `${repoPath(target)}/pulls?state=open&sort=updated&direction=desc`, 2);
  return list.map((pull) => ({
    number: pull.number, title: pull.title, author: pull.user?.login ?? "", avatarUrl: pull.user?.avatar_url ?? "", draft: Boolean(pull.draft),
    head: pull.head?.ref ?? "", base: pull.base?.ref ?? "", updatedAt: pull.updated_at, htmlUrl: pull.html_url, labels: (pull.labels ?? []).map(label),
  }));
}

export interface TimelineItem { kind: "comment" | "review"; author: string; avatarUrl: string; body: string; state?: string; createdAt: string; htmlUrl: string }

export interface GithubPullDetail {
  number: number; title: string; body: string; state: "open" | "closed" | "merged"; draft: boolean; htmlUrl: string;
  author: { login: string; avatarUrl: string } | null; createdAt: string; updatedAt: string;
  head: { ref: string; sha: string; repo: string | null; cloneUrl: string | null; sameRepo: boolean }; base: { ref: string };
  mergeable: boolean | null; mergeableState: string; commits: number; additions: number; deletions: number; changedFiles: number;
  reviewers: Array<{ login: string; avatarUrl: string; state: string }>; assignees: string[]; labels: Array<{ name: string; color: string }>;
  milestone: { number: number; title: string } | null; timeline: TimelineItem[]; checks: { state: string; checks: CheckRun[] }; viewer: string;
  canMerge: boolean;
}

export async function pullDetail(target: RemoteHost, token: string, numberValue: unknown): Promise<GithubPullDetail> {
  const n = number(numberValue);
  const base = repoPath(target);
  const [pull, comments, reviews, requested, viewer] = await Promise.all([
    gh<Json>(target.apiBase, token, "GET", `${base}/pulls/${n}`),
    paged<Json>(target.apiBase, token, `${base}/issues/${n}/comments`, 3),
    paged<Json>(target.apiBase, token, `${base}/pulls/${n}/reviews`, 3),
    gh<Json>(target.apiBase, token, "GET", `${base}/pulls/${n}/requested_reviewers`).catch(() => ({ users: [] })),
    token ? account(target.apiBase, token).then((me) => me.login).catch(() => "") : Promise.resolve(""),
  ]);
  const checks = await ciChecks(target, token, pull.head.sha).catch(() => ({ state: "none", checks: [] as CheckRun[] }));
  // Latest review per reviewer, plus everyone still asked to review.
  const latest = new Map<string, { login: string; avatarUrl: string; state: string }>();
  for (const review of reviews) {
    if (!review.user || review.state === "COMMENTED" && latest.has(review.user.login)) continue;
    latest.set(review.user.login, { login: review.user.login, avatarUrl: review.user.avatar_url ?? "", state: review.state });
  }
  for (const reviewer of requested.users ?? []) latest.set(reviewer.login, { login: reviewer.login, avatarUrl: reviewer.avatar_url ?? "", state: "PENDING" });
  const timeline: TimelineItem[] = [
    ...comments.map((comment) => ({ kind: "comment" as const, author: comment.user?.login ?? "", avatarUrl: comment.user?.avatar_url ?? "", body: comment.body ?? "", createdAt: comment.created_at, htmlUrl: comment.html_url })),
    ...reviews.filter((review) => review.body || review.state !== "COMMENTED").map((review) => ({ kind: "review" as const, author: review.user?.login ?? "", avatarUrl: review.user?.avatar_url ?? "", body: review.body ?? "", state: review.state, createdAt: review.submitted_at, htmlUrl: review.html_url })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const headRepo = pull.head?.repo as Json | null;
  return {
    number: n, title: pull.title, body: pull.body ?? "", state: pull.merged ? "merged" : pull.state, draft: Boolean(pull.draft), htmlUrl: pull.html_url,
    author: user(pull.user), createdAt: pull.created_at, updatedAt: pull.updated_at,
    head: { ref: pull.head.ref, sha: pull.head.sha, repo: headRepo?.full_name ?? null, cloneUrl: headRepo?.clone_url ?? null, sameRepo: headRepo?.full_name === pull.base?.repo?.full_name },
    base: { ref: pull.base.ref },
    mergeable: pull.mergeable ?? null, mergeableState: pull.mergeable_state ?? "unknown", commits: pull.commits ?? 0, additions: pull.additions ?? 0, deletions: pull.deletions ?? 0, changedFiles: pull.changed_files ?? 0,
    reviewers: [...latest.values()], assignees: (pull.assignees ?? []).map((entry: Json) => entry.login), labels: (pull.labels ?? []).map(label),
    milestone: pull.milestone ? { number: pull.milestone.number, title: pull.milestone.title } : null, timeline, checks, viewer,
    canMerge: pull.state === "open" && !pull.draft && pull.mergeable !== false,
  };
}

export async function updatePull(target: GithubTarget, token: string, n: unknown, patch: { title?: string; body?: string; state?: "open" | "closed"; base?: string }): Promise<void> {
  requireToken(token);
  if (patch.title !== undefined && !patch.title.trim()) throw invalidError("the title cannot be empty");
  await gh(target.apiBase, token, "PATCH", `${repoPath(target)}/pulls/${number(n)}`, patch);
}

/** Labels, assignees and milestone are issue fields; pull requests share them. */
export async function updateIssueFields(target: GithubTarget, token: string, n: unknown, patch: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[]; assignees?: string[]; milestone?: number | null }): Promise<void> {
  requireToken(token);
  if (patch.title !== undefined && !patch.title.trim()) throw invalidError("the title cannot be empty");
  await gh(target.apiBase, token, "PATCH", `${repoPath(target)}/issues/${number(n)}`, patch);
}

export async function setReviewers(target: GithubTarget, token: string, n: unknown, add: string[], remove: string[]): Promise<void> {
  requireToken(token);
  const route = `${repoPath(target)}/pulls/${number(n)}/requested_reviewers`;
  if (remove.length) await gh(target.apiBase, token, "DELETE", route, { reviewers: remove });
  if (add.length) await gh(target.apiBase, token, "POST", route, { reviewers: add });
}

export async function comment(target: GithubTarget, token: string, n: unknown, body: string): Promise<void> {
  requireToken(token);
  if (!body.trim()) throw invalidError("the comment is empty");
  await gh(target.apiBase, token, "POST", `${repoPath(target)}/issues/${number(n)}/comments`, { body });
}

export async function review(target: GithubTarget, token: string, n: unknown, event: string, body: string): Promise<void> {
  requireToken(token);
  if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(event)) throw invalidError("invalid review event");
  if (event !== "APPROVE" && !body.trim()) throw invalidError(event === "COMMENT" ? "write a comment first" : "say what should change");
  await gh(target.apiBase, token, "POST", `${repoPath(target)}/pulls/${number(n)}/reviews`, { event, body });
}

export async function merge(target: GithubTarget, token: string, n: unknown, method: string, title?: string, message?: string): Promise<string> {
  requireToken(token);
  if (!["merge", "squash", "rebase"].includes(method)) throw invalidError("invalid merge method");
  const result = await gh<Json>(target.apiBase, token, "PUT", `${repoPath(target)}/pulls/${number(n)}/merge`, { merge_method: method, ...(title ? { commit_title: title } : {}), ...(message ? { commit_message: message } : {}) });
  return String(result.message ?? "Merged");
}

/** Check a pull request out locally: its own branch when it comes from this
 *  repository, else pr/<number>-<branch> from refs/pull/<n>/head. */
export async function checkoutPull(inputPath: string, remote: string, pull: { number: number; headRef: string; sameRepo: boolean }): Promise<string> {
  const root = await repositoryRoot(inputPath);
  if (!/^[\w.-]+$/.test(remote)) throw invalidError("invalid remote name");
  const n = number(pull.number);
  const safeBranch = pull.headRef.replace(/[^\w./-]/g, "-").replace(/^-+/, "");
  if (!safeBranch) throw invalidError("invalid branch name");
  if (pull.sameRepo) {
    await checked(root, ["fetch", remote, `+refs/heads/${safeBranch}:refs/remotes/${remote}/${safeBranch}`]);
    const exists = (await runGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${safeBranch}`])).code === 0;
    if (exists) { await checked(root, ["switch", safeBranch]); await runGit(root, ["merge", "--ff-only", `${remote}/${safeBranch}`]); }
    else await checked(root, ["switch", "--track", "-c", safeBranch, `${remote}/${safeBranch}`]);
    return safeBranch;
  }
  const local = `pr/${n}-${safeBranch}`.slice(0, 120);
  await checked(root, ["fetch", remote, `+refs/pull/${n}/head:refs/heads/${local}`]);
  await checked(root, ["switch", local]);
  return local;
}

// ------------------------------------------------------------------ issues

export interface GithubIssueSummary { number: number; title: string; state: string; author: string; avatarUrl: string; labels: Array<{ name: string; color: string }>; assignees: string[]; comments: number; updatedAt: string; htmlUrl: string }
const issueSummary = (issue: Json): GithubIssueSummary => ({
  number: issue.number, title: issue.title, state: issue.state, author: issue.user?.login ?? "", avatarUrl: issue.user?.avatar_url ?? "",
  labels: (issue.labels ?? []).map(label), assignees: (issue.assignees ?? []).map((entry: Json) => entry.login), comments: issue.comments ?? 0, updatedAt: issue.updated_at, htmlUrl: issue.html_url,
});

/** Issues of the repository, filtered with GitHub's own search syntax
 *  ("is:open assignee:@me label:bug"). */
export async function searchIssues(target: GithubTarget, token: string, query: string): Promise<{ total: number; items: GithubIssueSummary[] }> {
  const extra = query.trim() || "is:open";
  if (extra.length > 250) throw invalidError("the filter is too long");
  const q = `repo:${target.owner}/${target.repository} is:issue ${extra}`;
  const result = await gh<Json>(target.apiBase, token, "GET", `/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=50`);
  return { total: result.total_count ?? 0, items: (result.items ?? []).map(issueSummary) };
}

export interface GithubIssueDetail extends GithubIssueSummary { body: string; createdAt: string; milestone: { number: number; title: string } | null; timeline: TimelineItem[]; viewer: string }

export async function issueDetail(target: GithubTarget, token: string, n: unknown): Promise<GithubIssueDetail> {
  const id = number(n);
  const [issue, comments, viewer] = await Promise.all([
    gh<Json>(target.apiBase, token, "GET", `${repoPath(target)}/issues/${id}`),
    paged<Json>(target.apiBase, token, `${repoPath(target)}/issues/${id}/comments`, 3),
    token ? account(target.apiBase, token).then((me) => me.login).catch(() => "") : Promise.resolve(""),
  ]);
  return {
    ...issueSummary(issue), body: issue.body ?? "", createdAt: issue.created_at, viewer,
    milestone: issue.milestone ? { number: issue.milestone.number, title: issue.milestone.title } : null,
    timeline: comments.map((entry) => ({ kind: "comment" as const, author: entry.user?.login ?? "", avatarUrl: entry.user?.avatar_url ?? "", body: entry.body ?? "", createdAt: entry.created_at, htmlUrl: entry.html_url })),
  };
}

export async function createIssue(target: GithubTarget, token: string, issue: { title: string; body: string; labels: string[]; assignees: string[] }): Promise<{ number: number; htmlUrl: string }> {
  requireToken(token);
  if (!issue.title.trim()) throw invalidError("the title is required");
  const created = await gh<Json>(target.apiBase, token, "POST", `${repoPath(target)}/issues`, issue);
  return { number: created.number, htmlUrl: created.html_url };
}

/** People, labels and milestones to pick from in the editors. */
export async function repoOptions(target: GithubTarget, token: string): Promise<{ assignees: string[]; labels: Array<{ name: string; color: string }>; milestones: Array<{ number: number; title: string }> }> {
  const [assignees, labels, milestones] = await Promise.all([
    paged<Json>(target.apiBase, token, `${repoPath(target)}/assignees`, 3).catch(() => []),
    paged<Json>(target.apiBase, token, `${repoPath(target)}/labels`, 3).catch(() => []),
    paged<Json>(target.apiBase, token, `${repoPath(target)}/milestones?state=open`, 1).catch(() => []),
  ]);
  return { assignees: assignees.map((entry) => entry.login), labels: labels.map(label), milestones: milestones.map((entry) => ({ number: entry.number, title: entry.title })) };
}

/** Branch name for an issue: 42-fix-login-on-safari. */
export function issueBranchName(n: number, title: string): string {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return slug ? `${n}-${slug}` : `issue-${n}`;
}

/** Create (and check out) a branch for an issue, remembering the link in
 *  branch.<name>.chrono-issue so the branch shows its issue. */
export async function branchForIssue(inputPath: string, name: string, base: string, issueUrl: string): Promise<void> {
  const root = await repositoryRoot(inputPath);
  if ((await runGit(root, ["check-ref-format", "--branch", name])).code !== 0 || name.startsWith("-")) throw invalidError(`invalid branch name: ${name}`);
  if (!/^https?:\/\/\S+\/issues\/\d+$/.test(issueUrl)) throw invalidError("invalid issue URL");
  const start = base.trim() || "HEAD";
  if (start.startsWith("-")) throw invalidError("invalid base");
  await checked(root, ["switch", "-c", name, start]);
  await checked(root, ["config", `branch.${name}.chrono-issue`, issueUrl]);
}

/** branch → issue URL, for branches made by branchForIssue. */
export async function issueBranches(inputPath: string): Promise<Record<string, string>> {
  const root = await repositoryRoot(inputPath);
  const out = await runGit(root, ["config", "--get-regexp", "^branch\\..*\\.chrono-issue$"]);
  const map: Record<string, string> = {};
  for (const line of out.stdout.split("\n")) {
    const match = /^branch\.(.+)\.chrono-issue\s+(\S+)$/.exec(line.trim());
    if (match) map[match[1]] = match[2];
  }
  return map;
}

// ------------------------------------------------------------------ SSH keys

export interface SshKeyInfo { path: string; type: string; comment: string; fingerprint: string; onGithub: boolean | null }

const sshDir = () => path.join(os.homedir(), ".ssh");
const keyBody = (line: string) => line.trim().split(/\s+/).slice(0, 2).join(" ");

/** Public keys in ~/.ssh, and whether each is on the GitHub account. */
export async function sshKeys(apiBase: string, token: string): Promise<SshKeyInfo[]> {
  const names = await fs.readdir(sshDir()).catch(() => [] as string[]);
  const onAccount = token ? await paged<Json>(apiBase, token, "/user/keys", 2).then((keys) => new Set(keys.map((key) => keyBody(String(key.key))))).catch(() => null) : null;
  const keys: SshKeyInfo[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".pub")).sort()) {
    const file = path.join(sshDir(), name);
    const text = (await fs.readFile(file, "utf8").catch(() => "")).trim();
    if (!/^(ssh-|ecdsa-|sk-)/.test(text)) continue;
    const fingerprint = await run("ssh-keygen", ["-lf", file]).then(({ stdout }) => stdout.trim().split(/\s+/)[1] ?? "").catch(() => "");
    keys.push({ path: file, type: text.split(/\s+/)[0], comment: text.split(/\s+/).slice(2).join(" "), fingerprint, onGithub: onAccount ? onAccount.has(keyBody(text)) : null });
  }
  return keys;
}

export async function uploadSshKey(apiBase: string, token: string, publicKeyPath: string, title: string): Promise<void> {
  requireToken(token);
  const resolved = path.resolve(publicKeyPath);
  if (path.dirname(resolved) !== sshDir() || !resolved.endsWith(".pub")) throw invalidError("pick a public key (.pub) in ~/.ssh");
  const key = (await fs.readFile(resolved, "utf8")).trim();
  await gh(apiBase, token, "POST", "/user/keys", { title: title.trim() || `Chrono on ${os.hostname()}`, key });
}

/**
 * Generate an ed25519 key and add it to GitHub. Uses ~/.ssh/id_ed25519 when
 * that does not exist yet (ssh finds it on its own). Otherwise the key goes
 * to ~/.ssh/id_ed25519_chrono_<host> and, with `writeConfig`, a "Host <host>"
 * entry pointing at it is appended to ~/.ssh/config.
 */
export async function generateSshKey(apiBase: string, token: string, gitHost: string, writeConfig: boolean): Promise<{ path: string; configured: boolean; note: string }> {
  requireToken(token);
  const host = gitHost.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) throw invalidError("invalid host");
  await fs.mkdir(sshDir(), { recursive: true, mode: 0o700 });
  const standard = path.join(sshDir(), "id_ed25519");
  const useStandard = !(await fs.stat(standard).then(() => true, () => false));
  const file = useStandard ? standard : path.join(sshDir(), `id_ed25519_chrono_${host.replace(/[^a-z0-9]+/g, "_")}`);
  if (await fs.stat(file).then(() => true, () => false)) throw invalidError(`${file} already exists: add its .pub key instead`);
  await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `chrono@${os.hostname()}`, "-f", file]);
  await uploadSshKey(apiBase, token, `${file}.pub`, `Chrono on ${os.hostname()}`);
  if (useStandard) return { path: file, configured: true, note: `Created ${file} and added it to GitHub; ssh uses it automatically.` };
  if (!writeConfig) return { path: file, configured: false, note: `Created ${file} and added it to GitHub. Point ssh at it for ${host} (IdentityFile in ~/.ssh/config).` };
  const config = path.join(sshDir(), "config");
  const existing = await fs.readFile(config, "utf8").catch(() => "");
  if (new RegExp(`^\\s*Host\\s+(.*\\s)?${host.replace(/\./g, "\\.")}(\\s|$)`, "mi").test(existing)) {
    return { path: file, configured: false, note: `Created ${file} and added it to GitHub. ~/.ssh/config already has a Host entry for ${host}; add "IdentityFile ${file}" to it.` };
  }
  await fs.appendFile(config, `${existing && !existing.endsWith("\n") ? "\n" : ""}\n# Added by Chrono\nHost ${host}\n  IdentityFile ${file}\n  IdentitiesOnly yes\n`, { mode: 0o600 });
  return { path: file, configured: true, note: `Created ${file}, added it to GitHub and to ~/.ssh/config for ${host}.` };
}

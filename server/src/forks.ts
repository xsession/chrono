// Forks and their upstreams, for a repository and every submodule inside it.
//
// A fork here is a checkout whose `origin` is your copy and which also has the
// repository it was forked from as a remote (usually `upstream`). Chrono reads
// that from the remotes alone (no network), can look up the parent on GitHub,
// GitLab or Gitea to add the `upstream` remote, and keeps forks current:
// fetch upstream, fast-forward the default branch, push it to your fork, or
// merge upstream into the branch you are on. Submodules are often forks too
// (patched dependencies), so the whole tree is covered the same way.

import { promises as fs } from "node:fs";
import path from "node:path";
import { invalidError } from "./lib/errors.ts";
import { repositoryRoot, runGit } from "./lib/git.ts";
import { bitbucketRepoPath, parseRemote } from "./features.ts";
import { submodulesOf } from "./nestedCommit.ts";

export interface ForkRemote { name: string; url: string; web: string | null; owner: string | null; repository: string | null }

export interface ForkStatus {
  /** Path relative to the repository the request started in ("" = itself). */
  path: string;
  absolute: string;
  name: string;
  /** fork: has an upstream remote · plain: one remote, not known to be a fork · local: no remotes. */
  kind: "fork" | "plain" | "local";
  origin: ForkRemote | null;
  upstream: ForkRemote | null;
  /** The upstream's default branch (upstream/HEAD, else main/master). */
  defaultBranch: string | null;
  currentBranch: string | null;
  /** Local default branch vs upstream's: commits to pull in / your own commits on it. */
  behind: number | null;
  ahead: number | null;
  /** Your fork on the server (origin/<default>) vs upstream: what a push would bring it up to. */
  originBehind: number | null;
  /** Current branch vs upstream's default branch, when it is not the default branch. */
  branchBehind: number | null;
  /** When upstream was last fetched (FETCH_HEAD), ISO time. */
  fetchedAt: string | null;
  /** A pull-request / merge-request page from your fork to upstream for the current branch. */
  compareUrl: string | null;
  depth: number;
}

const MAX_DEPTH = 6;

function remoteInfo(name: string, url: string): ForkRemote {
  // Local paths and file:// URLs have no host: no web pages, but the name still pairs forks.
  const parsed = parseRemote(url);
  const host = parsed?.host ? parsed : null;
  const local = host ? null : url.replace(/\.git$/, "").replace(/[\\/]+$/, "").split(/[\\/:]/).filter(Boolean);
  return { name, url, web: host?.webBase ?? null, owner: host?.owner ?? local?.at(-2) ?? null, repository: host?.repository ?? local?.at(-1) ?? null };
}

async function remotesOf(dir: string): Promise<ForkRemote[]> {
  const listed = await runGit(dir, ["remote", "-v"]);
  const seen = new Map<string, ForkRemote>();
  for (const line of listed.stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match && !seen.has(match[1])) seen.set(match[1], remoteInfo(match[1], match[2]));
  }
  return [...seen.values()];
}

/** origin = your copy; upstream = the remote called upstream, or another copy of the same repository. */
function pickRemotes(remotes: ForkRemote[]): { origin: ForkRemote | null; upstream: ForkRemote | null } {
  const origin = remotes.find((remote) => remote.name === "origin") ?? remotes[0] ?? null;
  let upstream = remotes.find((remote) => remote.name === "upstream" && remote !== origin) ?? null;
  if (!upstream && origin?.repository) {
    upstream = remotes.find((remote) => remote !== origin && remote.repository?.toLowerCase() === origin.repository?.toLowerCase() && remote.owner !== origin.owner) ?? null;
  }
  return { origin, upstream };
}

async function count(dir: string, range: string): Promise<number | null> {
  const result = await runGit(dir, ["rev-list", "--count", range]);
  return result.code === 0 ? Number(result.stdout.trim()) : null;
}

const refExists = async (dir: string, ref: string) => (await runGit(dir, ["rev-parse", "--verify", "--quiet", ref])).code === 0;

async function upstreamDefault(dir: string, remote: string): Promise<string | null> {
  const head = await runGit(dir, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  if (head.code === 0) return head.stdout.trim().replace(`refs/remotes/${remote}/`, "");
  for (const name of ["main", "master", "develop", "trunk"]) if (await refExists(dir, `refs/remotes/${remote}/${name}`)) return name;
  return null;
}

function compareUrl(origin: ForkRemote | null, upstream: ForkRemote | null, base: string | null, branch: string | null): string | null {
  if (!origin?.web || !upstream?.web || !base || !branch || !origin.owner) return null;
  const host = parseRemote(upstream.url);
  if (host?.provider === "gitlab") return `${origin.web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
  // Bitbucket Server opens the create page on the fork; the target repository is picked there.
  if (host?.provider === "bitbucket-server") return `${origin.web}/pull-requests?create&sourceBranch=${encodeURIComponent(`refs/heads/${branch}`)}`;
  if (host?.provider === "github") return `${upstream.web}/compare/${encodeURIComponent(base)}...${encodeURIComponent(origin.owner)}:${encodeURIComponent(origin.repository ?? "")}:${encodeURIComponent(branch)}`;
  return `${upstream.web}/compare/${encodeURIComponent(base)}...${encodeURIComponent(origin.owner)}:${encodeURIComponent(branch)}`;
}

/** Fork status of one checkout, from its remotes and the last fetch only (no network). */
export async function forkStatusOf(dir: string, relative = "", depth = 0): Promise<ForkStatus> {
  const remotes = await remotesOf(dir);
  const { origin, upstream } = pickRemotes(remotes);
  const current = (await runGit(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim() || null;
  const status: ForkStatus = {
    path: relative, absolute: dir, name: path.basename(dir), kind: upstream ? "fork" : origin ? "plain" : "local",
    origin, upstream, defaultBranch: null, currentBranch: current, behind: null, ahead: null, originBehind: null, branchBehind: null,
    fetchedAt: null, compareUrl: null, depth,
  };
  if (!upstream) return status;
  const base = await upstreamDefault(dir, upstream.name);
  status.defaultBranch = base;
  const gitDir = (await runGit(dir, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  try { status.fetchedAt = (await fs.stat(path.join(gitDir, "FETCH_HEAD"))).mtime.toISOString(); } catch { status.fetchedAt = null; }
  if (!base) return status;
  const upstreamRef = `refs/remotes/${upstream.name}/${base}`;
  if (await refExists(dir, `refs/heads/${base}`)) {
    status.behind = await count(dir, `refs/heads/${base}..${upstreamRef}`);
    status.ahead = await count(dir, `${upstreamRef}..refs/heads/${base}`);
  }
  if (origin && await refExists(dir, `refs/remotes/${origin.name}/${base}`)) status.originBehind = await count(dir, `refs/remotes/${origin.name}/${base}..${upstreamRef}`);
  if (current && current !== base) status.branchBehind = await count(dir, `HEAD..${upstreamRef}`);
  status.compareUrl = compareUrl(origin, upstream, base, current);
  return status;
}

/** The repository and every initialised submodule below it, depth first. */
export async function forkTree(inputPath: string): Promise<ForkStatus[]> {
  const root = await repositoryRoot(inputPath);
  const out: ForkStatus[] = [];
  const visit = async (dir: string, relative: string, depth: number) => {
    out.push(await forkStatusOf(dir, relative, depth));
    if (depth >= MAX_DEPTH) return;
    for (const sub of await submodulesOf(dir)) await visit(path.join(dir, sub), relative ? `${relative}/${sub}` : sub, depth + 1);
  };
  await visit(root, "", 0);
  return out;
}

async function resolveTarget(inputPath: string, relative: string): Promise<string> {
  const root = await repositoryRoot(inputPath);
  if (!relative) return root;
  if (relative.split(/[\\/]/).includes("..") || path.isAbsolute(relative)) throw invalidError("invalid submodule path");
  return repositoryRoot(path.join(root, relative));
}

async function git(dir: string, args: string[], what: string): Promise<string> {
  const result = await runGit(dir, args);
  if (result.code !== 0) throw invalidError(`${what}: ${(result.stderr || result.stdout).trim().split("\n").pop()}`);
  return result.stdout;
}

/** Look up the repository `origin` was forked from (GitHub, GitLab, Gitea, Bitbucket Server; public API, no token). */
export async function detectParent(inputPath: string, relative = ""): Promise<{ url: string; web: string; defaultBranch: string | null } | null> {
  const dir = await resolveTarget(inputPath, relative);
  const { origin } = pickRemotes(await remotesOf(dir));
  const host = origin ? parseRemote(origin.url) : null;
  if (!host) return null;
  const headers = { accept: "application/json", "user-agent": "chrono-git-client" };
  const get = async (url: string) => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    return response?.ok ? response.json() as Promise<Record<string, any>> : null;
  };
  if (host.provider === "github") {
    const data = await get(`${host.apiBase}/repos/${host.owner}/${host.repository}`);
    const parent = data?.fork ? data.parent : null;
    return parent ? { url: parent.clone_url, web: parent.html_url, defaultBranch: parent.default_branch ?? null } : null;
  }
  if (host.provider === "gitlab") {
    const data = await get(`${host.apiBase}/projects/${encodeURIComponent(`${host.owner}/${host.repository}`)}`);
    const parent = data?.forked_from_project;
    return parent ? { url: parent.http_url_to_repo, web: parent.web_url, defaultBranch: parent.default_branch ?? null } : null;
  }
  if (host.provider === "bitbucket-server") {
    // Anonymous access only works on public projects; private servers answer 401 → no parent.
    const data = await get(`${host.apiBase}${bitbucketRepoPath(host)}`);
    const parent = data?.origin;
    if (!parent?.slug || !parent.project?.key) return null;
    const clone = (parent.links?.clone ?? []) as Array<{ href?: string; name?: string }>;
    const url = clone.find((link) => link.name === "http")?.href ?? clone[0]?.href;
    if (!url) return null;
    const branch = await get(`${host.apiBase}${bitbucketRepoPath({ owner: parent.project.key, repository: parent.slug })}/default-branch`)
      ?? await get(`${host.apiBase}${bitbucketRepoPath({ owner: parent.project.key, repository: parent.slug })}/branches/default`);
    return { url, web: parent.links?.self?.[0]?.href ?? url, defaultBranch: branch?.displayId ?? null };
  }
  const data = await get(`${host.apiBase}/repos/${host.owner}/${host.repository}`);
  const parent = data?.fork ? data.parent : null;
  return parent ? { url: parent.clone_url, web: parent.html_url, defaultBranch: parent.default_branch ?? null } : null;
}

/** Add the original repository as a remote (default name `upstream`) and fetch it. */
export async function addUpstream(inputPath: string, relative: string, url: string, name = "upstream"): Promise<ForkStatus> {
  const dir = await resolveTarget(inputPath, relative);
  if (!/^[\w.-]{1,40}$/.test(name)) throw invalidError("invalid remote name");
  if (!url.trim() || url.trim().startsWith("-")) throw invalidError("invalid URL");
  const existing = (await remotesOf(dir)).find((remote) => remote.name === name);
  if (existing) await git(dir, ["remote", "set-url", name, url.trim()], "set the upstream URL");
  else await git(dir, ["remote", "add", name, url.trim()], "add the upstream remote");
  await fetchUpstream(dir);
  return forkStatusOf(dir, relative);
}

async function fetchUpstream(dir: string): Promise<void> {
  const { upstream } = pickRemotes(await remotesOf(dir));
  if (!upstream) throw invalidError("no upstream remote: add the repository this was forked from first");
  await git(dir, ["fetch", "--prune", upstream.name], `fetch ${upstream.name}`);
  await runGit(dir, ["remote", "set-head", upstream.name, "--auto"]); // learn upstream's default branch
}

export interface SyncResult { path: string; ok: boolean; message: string; from: string | null; to: string | null; pushed: boolean }

/**
 * Bring a fork's default branch up to upstream: fetch upstream, fast-forward
 * the local default branch (checked out or not), and optionally push it to
 * your fork. Never rewrites history: a diverged branch is reported instead.
 */
export async function syncFork(inputPath: string, relative = "", options: { push?: boolean } = {}): Promise<SyncResult> {
  const dir = await resolveTarget(inputPath, relative);
  const result: SyncResult = { path: relative, ok: false, message: "", from: null, to: null, pushed: false };
  try {
    await fetchUpstream(dir);
    const status = await forkStatusOf(dir, relative);
    const { upstream, origin, defaultBranch: base } = status;
    if (!upstream || !base) { result.message = "upstream has no default branch to follow"; return result; }
    const target = (await git(dir, ["rev-parse", `refs/remotes/${upstream.name}/${base}`], "read upstream")).trim();
    result.to = target;
    if (await refExists(dir, `refs/heads/${base}`)) {
      result.from = (await git(dir, ["rev-parse", `refs/heads/${base}`], "read the branch")).trim();
      if (result.from === target) result.message = `${base} is up to date with ${upstream.name}`;
      else if ((status.ahead ?? 0) > 0) {
        result.message = `${base} has ${status.ahead} commit(s) that ${upstream.name} does not: merge or rebase it yourself`;
        return result;
      } else if (status.currentBranch === base) {
        await git(dir, ["merge", "--ff-only", `refs/remotes/${upstream.name}/${base}`], `fast-forward ${base}`);
        result.message = `${base} fast-forwarded by ${status.behind} commit(s)`;
      } else {
        // Not checked out: move the branch without touching the working tree (fast-forward only).
        await git(dir, ["fetch", ".", `refs/remotes/${upstream.name}/${base}:refs/heads/${base}`], `fast-forward ${base}`);
        result.message = `${base} fast-forwarded by ${status.behind} commit(s)`;
      }
    } else {
      await git(dir, ["branch", "--track", base, `refs/remotes/${upstream.name}/${base}`], `create ${base}`);
      result.message = `created ${base} from ${upstream.name}`;
    }
    if (options.push && origin) {
      const push = await runGit(dir, ["push", origin.name, `refs/heads/${base}:refs/heads/${base}`]);
      if (push.code !== 0) { result.message += `; push to ${origin.name} failed: ${(push.stderr || push.stdout).trim().split("\n").pop()}`; return result; }
      result.pushed = true;
      result.message += `; pushed to ${origin.name}`;
    }
    result.ok = true;
    return result;
  } catch (error) {
    result.message = error instanceof Error ? error.message : String(error);
    return result;
  }
}

/** Sync every fork in the tree (the repository and all submodules). */
export async function syncAllForks(inputPath: string, options: { push?: boolean } = {}): Promise<SyncResult[]> {
  const tree = await forkTree(inputPath);
  const results: SyncResult[] = [];
  for (const entry of tree) if (entry.kind === "fork") results.push(await syncFork(inputPath, entry.path, options));
  return results;
}

/** Merge upstream's default branch into the branch that is checked out. */
export async function mergeUpstream(inputPath: string, relative = ""): Promise<string> {
  const dir = await resolveTarget(inputPath, relative);
  await fetchUpstream(dir);
  const status = await forkStatusOf(dir, relative);
  if (!status.upstream || !status.defaultBranch) throw invalidError("upstream has no default branch");
  if (!status.currentBranch) throw invalidError("check out a branch first");
  const out = await git(dir, ["merge", "--no-edit", `refs/remotes/${status.upstream.name}/${status.defaultBranch}`], `merge ${status.upstream.name}/${status.defaultBranch}`);
  return out.trim().split("\n").pop() ?? "merged";
}

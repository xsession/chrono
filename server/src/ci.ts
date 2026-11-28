// CI monitoring for every hosting provider, in one model:
//   GitHub Actions · GitLab CI/CD pipelines · Gitea/Forgejo Actions ·
//   Bitbucket Cloud Pipelines · Bitbucket Server build statuses.
//
// A run (workflow run, pipeline) has jobs (jobs, steps) with logs. Each
// provider says what it can do (`CiCapabilities`): re-run, re-run failed
// jobs, cancel, re-run or start one job, and start a run by hand with inputs
// (workflow_dispatch inputs, pipeline variables, custom pipelines). The
// inputs come from the workflow files in the repository (miniYaml.ts).

import fs from "node:fs";
import path from "node:path";
import { AppError, invalidError } from "./lib/errors.ts";
import { runGit } from "./lib/git.ts";
import { parseYaml, type YamlValue } from "./lib/miniYaml.ts";
import { authHeaders, hostingFetch } from "./hosting.ts";
import { bitbucketServerRoot, type HostingProvider, type RemoteHost } from "./features.ts";

export type CiStatus = "queued" | "running" | "waiting" | "manual" | "success" | "failure" | "cancelled" | "skipped" | "neutral";

export interface CiRun {
  id: string;
  number: number | null;
  /** Workflow or pipeline name. */
  name: string;
  /** Commit subject or the run's display title. */
  title: string;
  branch: string | null;
  sha: string;
  event: string;
  status: CiStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  url: string;
  actor: string | null;
  workflowId: string | null;
  attempt: number | null;
}

export interface CiStep { number: number; name: string; status: CiStatus }

export interface CiJob {
  id: string;
  name: string;
  stage: string | null;
  status: CiStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  url: string;
  steps: CiStep[];
}

export interface CiInput {
  name: string;
  description: string;
  required: boolean;
  default: string;
  type: "string" | "boolean" | "choice" | "number" | "environment";
  options: string[];
}

export interface CiWorkflow {
  id: string;
  name: string;
  path: string | null;
  active: boolean;
  /** Can be started by hand (workflow_dispatch, GitLab pipeline, custom pipeline). */
  dispatchable: boolean;
  inputs: CiInput[];
}

export interface CiCapabilities {
  provider: HostingProvider;
  system: string;
  rerun: boolean;
  rerunFailed: boolean;
  cancel: boolean;
  jobRerun: boolean;
  /** Start a manual GitLab job. */
  jobPlay: boolean;
  logs: boolean;
  dispatch: boolean;
  /** Runs are build statuses reported per commit (no runs of its own). */
  statusesOnly: boolean;
}

export function ciCapabilities(provider: HostingProvider): CiCapabilities {
  const none = { rerun: false, rerunFailed: false, cancel: false, jobRerun: false, jobPlay: false, logs: false, dispatch: false, statusesOnly: false };
  switch (provider) {
    case "github": return { ...none, provider, system: "GitHub Actions", rerun: true, rerunFailed: true, cancel: true, jobRerun: true, logs: true, dispatch: true };
    case "gitlab": return { ...none, provider, system: "GitLab CI/CD", rerun: true, rerunFailed: true, cancel: true, jobRerun: true, jobPlay: true, logs: true, dispatch: true };
    case "gitea": return { ...none, provider, system: "Gitea Actions", logs: true, dispatch: true };
    case "bitbucket-cloud": return { ...none, provider, system: "Bitbucket Pipelines", rerun: true, cancel: true, logs: true, dispatch: true };
    case "bitbucket-server": return { ...none, provider, system: "Bitbucket build statuses", statusesOnly: true };
  }
}

// --------------------------------------------------------------- HTTP helpers

async function call(target: RemoteHost, token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = { Accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...authHeaders(target.provider, token), ...(init.headers as Record<string, string> | undefined) };
  return hostingFetch(url, { ...init, headers });
}

async function json<T>(target: RemoteHost, token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await call(target, token, url, init);
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const nested = record.error && typeof record.error === "object" ? String((record.error as Record<string, unknown>).message ?? "") : "";
    // Not JSON (a proxy or GitHub's plain-text refusals): show the text itself.
    const plain = body === null ? text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const detail = nested || (typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : "") || plain;
    const limited = response.headers.get("x-ratelimit-remaining") === "0";
    const hint = limited ? " (API rate limit reached; set a token or wait)"
      : response.status === 401 ? " (set a token for this host)"
      : response.status === 403 && /not accessible|permission|scope/i.test(detail) ? " (the token lacks permission: GitHub needs Actions read access, and the workflow scope to change runs; GitLab api; Bitbucket pipeline)"
      : response.status === 404 ? " (not found, or this server's API does not offer it)" : "";
    throw new AppError("http", `${target.host} responded ${response.status}${detail ? `: ${detail}` : ""}${hint}`);
  }
  return body as T;
}

async function ok(target: RemoteHost, token: string, url: string, init: RequestInit): Promise<void> {
  await json<unknown>(target, token, url, init);
}

const MAX_LOG = 2 * 1024 * 1024;

/** Logs may redirect to blob storage: follow by hand, without credentials. */
async function text(target: RemoteHost, token: string, url: string): Promise<string> {
  let response = await call(target, token, url, { redirect: "manual", headers: { Accept: "text/plain, application/octet-stream, */*" } });
  for (let hop = 0; hop < 3 && response.status >= 300 && response.status < 400; hop++) {
    const location = response.headers.get("location");
    if (!location) break;
    response = await hostingFetch(new URL(location, url).toString(), { redirect: "manual" });
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 410) throw new AppError("http", "the log is not available (expired, or the job has not started)");
    throw new AppError("http", `${target.host} responded ${response.status} for the log`);
  }
  const body = await response.text();
  return body.length > MAX_LOG ? `… (showing the last ${Math.round(MAX_LOG / 1024 / 1024)} MB)\n${body.slice(-MAX_LOG)}` : body;
}

/** ANSI colours, GitLab section markers and GitHub's per-line timestamps removed. */
export function cleanLog(raw: string): string {
  return raw
    .replace(/section_(start|end):\d+:[^\r\n]*?(\r|\x1b\[0K)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/, "").replace(/^.*\r(?=.)/, ""))
    .join("\n");
}

const seconds = (from: string | null | undefined, to: string | null | undefined): number | null => {
  if (!from || !to) return null;
  const value = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
};
const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const opt = (value: unknown): string | null => (value === null || value === undefined || value === "" ? null : String(value));

function repoPath(target: RemoteHost): string {
  return `${target.apiBase}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}`;
}
const gitlabProject = (target: RemoteHost) => `${target.apiBase}/projects/${encodeURIComponent(`${target.owner}/${target.repository}`)}`;
const bitbucketRepo = (target: RemoteHost) => `${target.apiBase}/repositories/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}`;

function safeId(value: string, what = "id"): string {
  if (!/^[\w{}.-]+$/.test(value)) throw invalidError(`invalid ${what}`);
  return value;
}

// ------------------------------------------------------------ status mapping

export function githubStatus(status: unknown, conclusion: unknown): CiStatus {
  const state = str(status);
  if (state !== "completed") return state === "queued" || state === "pending" || state === "requested" ? "queued" : state === "waiting" ? "waiting" : "running";
  switch (str(conclusion)) {
    case "success": return "success";
    case "cancelled": return "cancelled";
    case "skipped": return "skipped";
    case "neutral": case "stale": return "neutral";
    case "action_required": return "waiting";
    default: return "failure"; // failure, timed_out, startup_failure
  }
}

export function gitlabStatus(status: unknown): CiStatus {
  switch (str(status)) {
    case "success": return "success";
    case "failed": return "failure";
    case "canceled": case "canceling": return "cancelled";
    case "skipped": return "skipped";
    case "manual": return "manual";
    case "running": return "running";
    case "scheduled": case "waiting_for_resource": case "waiting_for_callback": return "waiting";
    default: return "queued"; // created, pending, preparing
  }
}

export function bitbucketStatus(state: unknown): CiStatus {
  const record = (state && typeof state === "object" ? state : {}) as Record<string, any>;
  const name = str(record.name);
  const result = str(record.result?.name);
  const stage = str(record.stage?.name);
  if (name === "COMPLETED") return result === "SUCCESSFUL" ? "success" : result === "STOPPED" ? "cancelled" : result === "EXPIRED" ? "cancelled" : "failure";
  if (name === "PAUSED" || stage === "PAUSED" || stage === "HALTED") return "waiting";
  if (name === "PENDING") return "queued";
  if (name === "NOT_RUN") return "skipped";
  return "running";
}

const buildStatus = (state: string): CiStatus => state === "SUCCESSFUL" ? "success" : state === "FAILED" ? "failure" : state === "STOPPED" ? "cancelled" : state === "INPROGRESS" ? "running" : "neutral";

/** Worst status first: what a group of statuses adds up to. */
export function combineStatus(statuses: CiStatus[]): CiStatus {
  for (const candidate of ["failure", "running", "queued", "waiting", "manual", "cancelled", "success", "neutral", "skipped"] as CiStatus[]) if (statuses.includes(candidate)) return candidate;
  return "neutral";
}

// ---------------------------------------------------------------- local repo

/** Commit subjects from the local repository, for providers that only give ids. */
async function subjects(root: string, shas: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(shas.filter((sha) => /^[0-9a-f]{7,64}$/.test(sha)))];
  const result = new Map<string, string>();
  if (!unique.length) return result;
  const output = await runGit(root, ["show", "-s", "--format=%H%x00%s", "--no-walk=unsorted", ...unique]);
  for (const line of output.stdout.split("\n")) {
    const [sha, subject] = line.split("\0");
    if (sha && subject !== undefined) for (const wanted of unique) if (sha.startsWith(wanted)) result.set(wanted, subject);
  }
  return result;
}

// --------------------------------------------------------------------- runs

export interface RunsQuery { branch?: string | null; workflowId?: string | null; page?: number; limit?: number }

export async function ciRuns(root: string, target: RemoteHost, token: string, query: RunsQuery = {}): Promise<{ runs: CiRun[]; capabilities: CiCapabilities; hasMore: boolean }> {
  const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const branch = query.branch?.trim() || null;
  const capabilities = ciCapabilities(target.provider);
  let runs: CiRun[] = [];
  let hasMore = false;
  switch (target.provider) {
    case "github":
    case "gitea": {
      const params = new URLSearchParams({ per_page: String(limit), limit: String(limit), page: String(page) });
      if (branch) params.set("branch", branch);
      const base = query.workflowId && target.provider === "github" ? `${repoPath(target)}/actions/workflows/${encodeURIComponent(query.workflowId)}/runs` : `${repoPath(target)}/actions/runs`;
      let body: { workflow_runs?: Array<Record<string, any>>; total_count?: number };
      try {
        body = await json(target, token, `${base}?${params}`);
      } catch (error) {
        // Gitea before 1.24 lists runs as "tasks" only.
        if (target.provider !== "gitea" || !/ 404/.test(String((error as Error).message))) throw error;
        body = await json(target, token, `${repoPath(target)}/actions/tasks?${new URLSearchParams({ page: String(page), limit: String(limit) })}`);
      }
      const list = body.workflow_runs ?? [];
      runs = list.map((run) => {
        const started = opt(run.run_started_at) ?? opt(run.created_at);
        const done = githubStatus(run.status, run.conclusion);
        const finished = ["success", "failure", "cancelled", "skipped", "neutral"].includes(done) ? opt(run.updated_at) : null;
        return {
          id: str(run.id),
          number: Number(run.run_number) || null,
          name: str(run.name ?? run.workflow_id ?? "workflow"),
          title: str(run.display_title ?? run.head_commit?.message?.split("\n")[0] ?? run.name ?? ""),
          branch: opt(run.head_branch),
          sha: str(run.head_sha),
          event: str(run.event),
          status: done,
          createdAt: str(run.created_at),
          startedAt: started,
          finishedAt: finished,
          durationSeconds: finished ? seconds(started, finished) : null,
          url: str(run.html_url ?? run.url),
          actor: opt(run.triggering_actor?.login ?? run.actor?.login),
          workflowId: opt(run.workflow_id),
          attempt: Number(run.run_attempt) || null,
        };
      });
      if (target.provider === "gitea" && branch) runs = runs.filter((run) => !run.branch || run.branch === branch);
      hasMore = typeof body.total_count === "number" ? page * limit < body.total_count : list.length === limit;
      break;
    }
    case "gitlab": {
      const params = new URLSearchParams({ per_page: String(limit), page: String(page), order_by: "id", sort: "desc" });
      if (branch) params.set("ref", branch);
      const list = await json<Array<Record<string, any>>>(target, token, `${gitlabProject(target)}/pipelines?${params}`);
      const titles = await subjects(root, list.map((pipeline) => str(pipeline.sha)));
      runs = list.map((pipeline) => {
        const status = gitlabStatus(pipeline.status);
        const finished = ["success", "failure", "cancelled", "skipped"].includes(status) ? opt(pipeline.updated_at) : null;
        return {
          id: str(pipeline.id),
          number: Number(pipeline.iid) || Number(pipeline.id) || null,
          name: str(pipeline.name ?? "pipeline") || "pipeline",
          title: titles.get(str(pipeline.sha)) ?? str(pipeline.ref),
          branch: opt(pipeline.ref),
          sha: str(pipeline.sha),
          event: str(pipeline.source),
          status,
          createdAt: str(pipeline.created_at),
          startedAt: opt(pipeline.created_at),
          finishedAt: finished,
          durationSeconds: finished ? seconds(pipeline.created_at, finished) : null,
          url: str(pipeline.web_url),
          actor: null,
          workflowId: null,
          attempt: null,
        };
      });
      hasMore = list.length === limit;
      break;
    }
    case "bitbucket-cloud": {
      const params = new URLSearchParams({ pagelen: String(limit), page: String(page), sort: "-created_on" });
      if (branch) params.set("target.branch", branch);
      const body = await json<{ values?: Array<Record<string, any>>; next?: string }>(target, token, `${bitbucketRepo(target)}/pipelines/?${params}`);
      const list = body.values ?? [];
      const titles = await subjects(root, list.map((pipeline) => str(pipeline.target?.commit?.hash)));
      runs = list.map((pipeline) => {
        const sha = str(pipeline.target?.commit?.hash);
        const status = bitbucketStatus(pipeline.state);
        const selector = pipeline.target?.selector;
        return {
          id: str(pipeline.uuid),
          number: Number(pipeline.build_number) || null,
          name: selector?.pattern ? `${str(selector.type)}: ${str(selector.pattern)}` : "default",
          title: titles.get(sha) ?? str(pipeline.target?.ref_name ?? sha.slice(0, 8)),
          branch: opt(pipeline.target?.ref_name),
          sha,
          event: str(pipeline.trigger?.name ?? pipeline.trigger?.type).toLowerCase(),
          status,
          createdAt: str(pipeline.created_on),
          startedAt: opt(pipeline.created_on),
          finishedAt: opt(pipeline.completed_on),
          durationSeconds: Number(pipeline.duration_in_seconds) || seconds(pipeline.created_on, pipeline.completed_on),
          url: `${target.webBase}/pipelines/results/${str(pipeline.build_number)}`,
          actor: opt(pipeline.creator?.display_name ?? pipeline.creator?.nickname),
          workflowId: selector?.pattern ? `${str(selector.type)}:${str(selector.pattern)}` : null,
          attempt: null,
        };
      });
      if (branch) runs = runs.filter((run) => !run.branch || run.branch === branch);
      hasMore = Boolean(body.next);
      break;
    }
    case "bitbucket-server": {
      // No runs of its own: the build statuses CI servers post, per commit.
      const ref = branch ?? "HEAD";
      if (ref.startsWith("-")) throw invalidError("invalid branch");
      const log = await runGit(root, ["log", `--max-count=${limit}`, `--skip=${(page - 1) * limit}`, "--format=%H%x00%s%x00%cI", ref, "--"]);
      const commits = log.stdout.split("\n").filter(Boolean).map((line) => { const [sha, subject, date] = line.split("\0"); return { sha, subject, date }; });
      const server = bitbucketServerRoot(target.apiBase);
      const statuses = await Promise.all(commits.map((commit) => json<{ values?: Array<Record<string, any>> }>(target, token, `${server}/rest/build-status/1.0/commits/${commit.sha}?limit=50`).catch(() => ({ values: [] }))));
      runs = commits.flatMap((commit, index) => {
        const builds = statuses[index].values ?? [];
        if (!builds.length) return [];
        const status = combineStatus(builds.map((build) => buildStatus(str(build.state))));
        return [{
          id: commit.sha,
          number: null,
          name: builds.map((build) => str(build.name ?? build.key)).join(", "),
          title: commit.subject,
          branch,
          sha: commit.sha,
          event: "build status",
          status,
          createdAt: commit.date,
          startedAt: null,
          finishedAt: null,
          durationSeconds: null,
          url: str(builds[0].url) || `${target.webBase}/commits/${commit.sha}`,
          actor: null,
          workflowId: null,
          attempt: null,
        }];
      });
      hasMore = commits.length === limit;
      break;
    }
  }
  return { runs, capabilities, hasMore };
}

// ---------------------------------------------------------------- run detail

export async function ciRunJobs(root: string, target: RemoteHost, token: string, runId: string): Promise<CiJob[]> {
  const id = safeId(runId, "run id");
  switch (target.provider) {
    case "github":
    case "gitea": {
      const jobs: Array<Record<string, any>> = [];
      for (let page = 1; page <= 5; page++) {
        const body = await json<{ jobs?: Array<Record<string, any>>; total_count?: number }>(target, token, `${repoPath(target)}/actions/runs/${id}/jobs?per_page=100&page=${page}`);
        jobs.push(...(body.jobs ?? []));
        if ((body.jobs ?? []).length < 100) break;
      }
      return jobs.map((job) => ({
        id: str(job.id),
        name: str(job.name),
        stage: null,
        status: githubStatus(job.status, job.conclusion),
        startedAt: opt(job.started_at),
        finishedAt: opt(job.completed_at),
        durationSeconds: seconds(job.started_at, job.completed_at),
        url: str(job.html_url),
        steps: (job.steps ?? []).map((step: Record<string, any>) => ({ number: Number(step.number) || 0, name: str(step.name), status: githubStatus(step.status, step.conclusion) })),
      }));
    }
    case "gitlab": {
      const params = "per_page=100&include_retried=false";
      const [jobs, bridges] = await Promise.all([
        json<Array<Record<string, any>>>(target, token, `${gitlabProject(target)}/pipelines/${id}/jobs?${params}`),
        json<Array<Record<string, any>>>(target, token, `${gitlabProject(target)}/pipelines/${id}/bridges?per_page=100`).catch(() => []),
      ]);
      return [...jobs, ...bridges].map((job) => ({
        id: str(job.id),
        name: str(job.name),
        stage: opt(job.stage),
        status: gitlabStatus(job.status),
        startedAt: opt(job.started_at),
        finishedAt: opt(job.finished_at),
        durationSeconds: job.duration ? Math.round(Number(job.duration)) : seconds(job.started_at, job.finished_at),
        url: str(job.web_url),
        steps: [],
      })).sort((a, b) => Number(a.id) - Number(b.id));
    }
    case "bitbucket-cloud": {
      const body = await json<{ values?: Array<Record<string, any>> }>(target, token, `${bitbucketRepo(target)}/pipelines/${encodeURIComponent(id)}/steps/?pagelen=100`);
      return (body.values ?? []).map((step) => ({
        id: str(step.uuid),
        name: str(step.name ?? "step") || "step",
        stage: null,
        status: bitbucketStatus(step.state),
        startedAt: opt(step.started_on),
        finishedAt: opt(step.completed_on),
        durationSeconds: Number(step.duration_in_seconds) || seconds(step.started_on, step.completed_on),
        url: "",
        steps: [],
      }));
    }
    case "bitbucket-server": {
      if (!/^[0-9a-f]{40}$/.test(id)) throw invalidError("invalid commit");
      const body = await json<{ values?: Array<Record<string, any>> }>(target, token, `${bitbucketServerRoot(target.apiBase)}/rest/build-status/1.0/commits/${id}?limit=100`);
      return (body.values ?? []).map((build) => ({
        id: str(build.key ?? build.name),
        name: str(build.name ?? build.key ?? "build"),
        stage: null,
        status: buildStatus(str(build.state)),
        startedAt: build.dateAdded ? new Date(Number(build.dateAdded)).toISOString() : null,
        finishedAt: null,
        durationSeconds: null,
        url: str(build.url),
        steps: [],
      }));
    }
  }
}

export async function ciJobLog(target: RemoteHost, token: string, runId: string, jobId: string): Promise<string> {
  const run = safeId(runId, "run id");
  const job = safeId(jobId, "job id");
  switch (target.provider) {
    case "github":
    case "gitea":
      return cleanLog(await text(target, token, `${repoPath(target)}/actions/jobs/${job}/logs`));
    case "gitlab":
      return cleanLog(await text(target, token, `${gitlabProject(target)}/jobs/${job}/trace`));
    case "bitbucket-cloud":
      return cleanLog(await text(target, token, `${bitbucketRepo(target)}/pipelines/${encodeURIComponent(run)}/steps/${encodeURIComponent(job)}/log`));
    default:
      throw new AppError("unsupported", "logs are kept by the build server; open the build to read them");
  }
}

// ------------------------------------------------------------------ actions

export type CiRunAction = "rerun" | "rerun_failed" | "cancel" | "rerun_job" | "play_job";

export async function ciRunAction(target: RemoteHost, token: string, action: CiRunAction, runId: string, jobId?: string | null): Promise<string> {
  if (!token) throw invalidError("a token for this host is needed to change runs");
  const capabilities = ciCapabilities(target.provider);
  const run = safeId(runId, "run id");
  const job = jobId ? safeId(jobId, "job id") : null;
  const unsupported = () => new AppError("unsupported", `${capabilities.system} cannot do this through its API; open the run in the browser`);
  switch (target.provider) {
    case "github":
      if (action === "rerun") { await ok(target, token, `${repoPath(target)}/actions/runs/${run}/rerun`, { method: "POST" }); return `Re-running run ${run}`; }
      if (action === "rerun_failed") { await ok(target, token, `${repoPath(target)}/actions/runs/${run}/rerun-failed-jobs`, { method: "POST" }); return `Re-running the failed jobs of run ${run}`; }
      if (action === "cancel") { await ok(target, token, `${repoPath(target)}/actions/runs/${run}/cancel`, { method: "POST" }); return `Cancelling run ${run}`; }
      if (action === "rerun_job" && job) { await ok(target, token, `${repoPath(target)}/actions/jobs/${job}/rerun`, { method: "POST" }); return `Re-running job ${job}`; }
      throw unsupported();
    case "gitlab":
      if (action === "rerun_failed") { await ok(target, token, `${gitlabProject(target)}/pipelines/${run}/retry`, { method: "POST" }); return `Retrying the failed jobs of pipeline ${run}`; }
      if (action === "rerun") {
        const pipeline = await json<Record<string, any>>(target, token, `${gitlabProject(target)}/pipelines/${run}`);
        const created = await json<Record<string, any>>(target, token, `${gitlabProject(target)}/pipeline`, { method: "POST", body: JSON.stringify({ ref: str(pipeline.ref) }) });
        return `Started pipeline ${str(created.id)} on ${str(pipeline.ref)}`;
      }
      if (action === "cancel") { await ok(target, token, `${gitlabProject(target)}/pipelines/${run}/cancel`, { method: "POST" }); return `Cancelling pipeline ${run}`; }
      if (action === "rerun_job" && job) { await ok(target, token, `${gitlabProject(target)}/jobs/${job}/retry`, { method: "POST" }); return `Retrying job ${job}`; }
      if (action === "play_job" && job) { await ok(target, token, `${gitlabProject(target)}/jobs/${job}/play`, { method: "POST" }); return `Started manual job ${job}`; }
      throw unsupported();
    case "bitbucket-cloud":
      if (action === "cancel") { await ok(target, token, `${bitbucketRepo(target)}/pipelines/${encodeURIComponent(run)}/stopPipeline`, { method: "POST" }); return "Stopping the pipeline"; }
      if (action === "rerun") {
        // No re-run endpoint: start the same pipeline on the same commit again.
        const pipeline = await json<Record<string, any>>(target, token, `${bitbucketRepo(target)}/pipelines/${encodeURIComponent(run)}`);
        const source = pipeline.target ?? {};
        const again: Record<string, unknown> = { type: str(source.type) || "pipeline_ref_target", ref_type: source.ref_type, ref_name: source.ref_name, commit: source.commit?.hash ? { type: "commit", hash: source.commit.hash } : undefined, selector: source.selector };
        const created = await json<Record<string, any>>(target, token, `${bitbucketRepo(target)}/pipelines/`, { method: "POST", body: JSON.stringify({ target: again }) });
        return `Started pipeline #${str(created.build_number)}`;
      }
      throw unsupported();
    default:
      throw unsupported();
  }
}

// ---------------------------------------------------------------- workflows

function inputType(value: unknown): CiInput["type"] {
  const type = str(value);
  return type === "boolean" || type === "choice" || type === "number" || type === "environment" ? type : "string";
}

function asRecord(value: YamlValue | undefined): Record<string, YamlValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** workflow_dispatch of a GitHub/Gitea workflow file: dispatchable and its inputs. */
export function dispatchInputs(source: string): { dispatchable: boolean; inputs: CiInput[]; name: string | null } {
  const doc = asRecord(parseYaml(source));
  const on = doc.on ?? doc.true ?? null; // "on" may be read as true by YAML 1.1 parsers
  const name = typeof doc.name === "string" ? doc.name : null;
  if (on === "workflow_dispatch") return { dispatchable: true, inputs: [], name };
  if (Array.isArray(on)) return { dispatchable: on.includes("workflow_dispatch"), inputs: [], name };
  const triggers = asRecord(on);
  if (!("workflow_dispatch" in triggers)) return { dispatchable: false, inputs: [], name };
  const inputs = asRecord(asRecord(triggers.workflow_dispatch).inputs);
  return {
    dispatchable: true,
    name,
    inputs: Object.entries(inputs).map(([key, raw]) => {
      const input = asRecord(raw);
      return {
        name: key,
        description: str(input.description),
        required: input.required === true,
        default: input.default === null || input.default === undefined ? "" : String(input.default),
        type: inputType(input.type),
        options: Array.isArray(input.options) ? input.options.map(String) : [],
      };
    }),
  };
}

/** Variables a GitLab "Run pipeline" form offers: top-level ones with a description. */
export function gitlabPipelineInputs(source: string): CiInput[] {
  const variables = asRecord(asRecord(parseYaml(source)).variables);
  return Object.entries(variables).flatMap(([key, raw]) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const variable = raw as Record<string, YamlValue>;
    if (!("description" in variable)) return [];
    const options = Array.isArray(variable.options) ? variable.options.map(String) : [];
    return [{ name: key, description: str(variable.description), required: false, default: str(variable.value), type: options.length ? "choice" as const : "string" as const, options }];
  });
}

/** Custom pipelines of bitbucket-pipelines.yml with their variables. */
export function bitbucketCustomPipelines(source: string): Array<{ name: string; inputs: CiInput[] }> {
  const custom = asRecord(asRecord(asRecord(parseYaml(source)).pipelines).custom);
  return Object.entries(custom).map(([name, steps]) => {
    const list = Array.isArray(steps) ? steps : [];
    const variables = list.map((step) => asRecord(step).variables).find(Array.isArray) as YamlValue[] | undefined;
    return {
      name,
      inputs: (variables ?? []).map((entry) => {
        const variable = asRecord(entry);
        const options = Array.isArray(variable["allowed-values"]) ? (variable["allowed-values"] as YamlValue[]).map(String) : [];
        return { name: str(variable.name), description: str(variable.description), required: false, default: str(variable.default), type: options.length ? "choice" as const : "string" as const, options };
      }).filter((input) => input.name),
    };
  });
}

function readLocal(root: string, file: string): string | null {
  try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return null; }
}

function workflowFiles(root: string, dirs: string[]): Array<{ file: string; source: string }> {
  const result: Array<{ file: string; source: string }> = [];
  for (const dir of dirs) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(path.join(root, dir)); } catch { continue; }
    for (const entry of entries.sort()) {
      if (!/\.ya?ml$/i.test(entry)) continue;
      const source = readLocal(root, `${dir}/${entry}`);
      if (source !== null) result.push({ file: `${dir}/${entry}`, source });
    }
  }
  return result;
}

export async function ciWorkflows(root: string, target: RemoteHost, token: string): Promise<CiWorkflow[]> {
  switch (target.provider) {
    case "github": {
      const body = await json<{ workflows?: Array<Record<string, any>> }>(target, token, `${repoPath(target)}/actions/workflows?per_page=100`);
      return (body.workflows ?? []).map((workflow) => {
        const file = str(workflow.path);
        const local = file.startsWith(".github/workflows/") ? readLocal(root, file) : null;
        const parsed = local ? dispatchInputs(local) : { dispatchable: false, inputs: [], name: null };
        return { id: str(workflow.id), name: str(workflow.name), path: file || null, active: str(workflow.state) === "active", dispatchable: parsed.dispatchable, inputs: parsed.inputs };
      });
    }
    case "gitea":
      // Gitea runs workflows from .gitea/workflows, else .github/workflows.
      return workflowFiles(root, [".gitea/workflows", ".github/workflows"]).map(({ file, source }) => {
        const parsed = dispatchInputs(source);
        return { id: path.posix.basename(file), name: parsed.name ?? path.posix.basename(file), path: file, active: true, dispatchable: parsed.dispatchable, inputs: parsed.inputs };
      });
    case "gitlab": {
      const source = readLocal(root, ".gitlab-ci.yml");
      return [{ id: "pipeline", name: "Pipeline (.gitlab-ci.yml)", path: source !== null ? ".gitlab-ci.yml" : null, active: true, dispatchable: true, inputs: source ? gitlabPipelineInputs(source) : [] }];
    }
    case "bitbucket-cloud": {
      const source = readLocal(root, "bitbucket-pipelines.yml");
      const custom = source ? bitbucketCustomPipelines(source) : [];
      return [
        { id: "default", name: "Branch pipeline", path: source !== null ? "bitbucket-pipelines.yml" : null, active: true, dispatchable: true, inputs: [] },
        ...custom.map((entry) => ({ id: `custom:${entry.name}`, name: `custom: ${entry.name}`, path: "bitbucket-pipelines.yml", active: true, dispatchable: true, inputs: entry.inputs })),
      ];
    }
    default:
      return [];
  }
}

export async function ciDispatch(target: RemoteHost, token: string, request: { workflowId: string; ref: string; inputs: Record<string, string> }): Promise<string> {
  if (!token) throw invalidError("a token for this host is needed to start runs");
  const ref = request.ref.trim();
  if (!ref || ref.startsWith("-") || /[\s\0]/.test(ref)) throw invalidError("choose a branch or tag to run on");
  const inputs = Object.fromEntries(Object.entries(request.inputs ?? {}).filter(([key]) => /^[\w.-]+$/.test(key)).map(([key, value]) => [key, String(value)]));
  switch (target.provider) {
    case "github":
    case "gitea": {
      const workflow = encodeURIComponent(request.workflowId);
      if (!request.workflowId || /[/\\]/.test(request.workflowId)) throw invalidError("choose a workflow");
      await ok(target, token, `${repoPath(target)}/actions/workflows/${workflow}/dispatches`, { method: "POST", body: JSON.stringify({ ref, inputs }) });
      return `Started ${request.workflowId} on ${ref}`;
    }
    case "gitlab": {
      const variables = Object.entries(inputs).map(([key, value]) => ({ key, value, variable_type: "env_var" }));
      const created = await json<Record<string, any>>(target, token, `${gitlabProject(target)}/pipeline`, { method: "POST", body: JSON.stringify({ ref, variables }) });
      return `Started pipeline ${str(created.id)} on ${ref}`;
    }
    case "bitbucket-cloud": {
      const custom = request.workflowId.startsWith("custom:") ? request.workflowId.slice(7) : null;
      const body: Record<string, unknown> = {
        target: { type: "pipeline_ref_target", ref_type: "branch", ref_name: ref, ...(custom ? { selector: { type: "custom", pattern: custom } } : {}) },
        ...(Object.keys(inputs).length ? { variables: Object.entries(inputs).map(([key, value]) => ({ key, value })) } : {}),
      };
      const created = await json<Record<string, any>>(target, token, `${bitbucketRepo(target)}/pipelines/`, { method: "POST", body: JSON.stringify(body) });
      return `Started pipeline #${str(created.build_number)} on ${ref}`;
    }
    default:
      throw new AppError("unsupported", "this provider cannot start runs");
  }
}

/** Latest run of a branch, for the toolbar badge. */
export async function ciLatest(root: string, target: RemoteHost, token: string, branch: string): Promise<{ run: CiRun | null; system: string }> {
  const { runs, capabilities } = await ciRuns(root, target, token, { branch, limit: 5 });
  return { run: runs[0] ?? null, system: capabilities.system };
}


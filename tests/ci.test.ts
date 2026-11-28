// CI monitoring against mock provider APIs: runs, jobs, logs, actions,
// workflows with dispatch inputs, for GitHub, GitLab, Gitea, Bitbucket Cloud
// and Bitbucket Server.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrono-ci-")));
Object.assign(process.env, { HOME: temp, CHRONO_CONFIG_DIR: path.join(temp, "cfg"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: process.env }).trim();
const ci = await import("../server/src/ci.ts");
let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks += 1; console.log(`  ok  ${message}`); };

// A repository with workflow files and two commits.
const root = path.join(temp, "repo");
fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
git(root, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(root, ".github/workflows/deploy.yml"), "name: Deploy\non:\n  workflow_dispatch:\n    inputs:\n      env:\n        description: Target\n        type: choice\n        options: [staging, prod]\n        default: staging\n        required: true\n      dry:\n        type: boolean\n");
fs.writeFileSync(path.join(root, ".github/workflows/ci.yml"), "name: CI\non: [push, pull_request]\njobs: {}\n");
fs.writeFileSync(path.join(root, ".gitlab-ci.yml"), "variables:\n  DEPLOY_ENV:\n    value: staging\n    description: Where to deploy\n    options: [staging, production]\n  PLAIN: x\nbuild:\n  script: [make]\n");
fs.writeFileSync(path.join(root, "bitbucket-pipelines.yml"), "pipelines:\n  default:\n    - step:\n        script: [make]\n  custom:\n    release:\n      - variables:\n          - name: VERSION\n            default: '1.0'\n      - step:\n          script: [make release]\n");
git(root, "add", "."); git(root, "commit", "-qm", "first commit");
const sha1 = git(root, "rev-parse", "HEAD");
fs.writeFileSync(path.join(root, "x.txt"), "x"); git(root, "add", "."); git(root, "commit", "-qm", "second commit");
const sha2 = git(root, "rev-parse", "HEAD");

// --------------------------------------------------------------- mock APIs
const requests: string[] = [];
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://x");
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    requests.push(`${request.method} ${url.pathname}${body ? ` ${body}` : ""} auth=${request.headers.authorization ?? request.headers["private-token"] ?? ""}`);
    const send = (status: number, data: unknown, type = "application/json") => { response.writeHead(status, { "content-type": type }); response.end(typeof data === "string" ? data : JSON.stringify(data)); };
    const p = url.pathname;
    // GitHub
    if (p === "/gh/repos/o/r/actions/runs") return send(200, { total_count: 2, workflow_runs: [
      { id: 11, run_number: 7, name: "CI", display_title: "second commit", head_branch: url.searchParams.get("branch") ?? "main", head_sha: sha2, event: "push", status: "in_progress", conclusion: null, created_at: "2026-11-28T10:00:00Z", run_started_at: "2026-11-28T10:00:05Z", updated_at: "2026-11-28T10:01:00Z", html_url: "https://github.com/o/r/actions/runs/11", actor: { login: "ann" }, workflow_id: 5, run_attempt: 1 },
      { id: 10, run_number: 6, name: "CI", display_title: "first commit", head_branch: "main", head_sha: sha1, event: "push", status: "completed", conclusion: "failure", created_at: "2026-11-27T10:00:00Z", run_started_at: "2026-11-27T10:00:00Z", updated_at: "2026-11-27T10:02:30Z", html_url: "https://github.com/o/r/actions/runs/10", actor: { login: "bob" }, workflow_id: 5, run_attempt: 2 },
    ] });
    if (p === "/gh/repos/o/r/actions/runs/10/jobs") return send(200, { total_count: 1, jobs: [{ id: 99, name: "build", status: "completed", conclusion: "failure", started_at: "2026-11-27T10:00:00Z", completed_at: "2026-11-27T10:02:00Z", html_url: "https://github.com/o/r/actions/runs/10/job/99", steps: [{ number: 1, name: "checkout", status: "completed", conclusion: "success" }, { number: 2, name: "test", status: "completed", conclusion: "failure" }] }] });
    if (p === "/gh/repos/o/r/actions/jobs/99/logs") { response.writeHead(302, { location: `http://127.0.0.1:${port}/blob/log99` }); return response.end(); }
    if (p === "/blob/log99") return send(200, request.headers.authorization ? "LEAKED" : "2026-11-27T10:00:01.1234567Z \x1b[31merror\x1b[0m: test failed\n2026-11-27T10:00:02.0000000Z done\n", "text/plain");
    if (p === "/gh/repos/o/r/actions/workflows") return send(200, { workflows: [{ id: 5, name: "CI", path: ".github/workflows/ci.yml", state: "active" }, { id: 6, name: "Deploy", path: ".github/workflows/deploy.yml", state: "active" }] });
    if (request.method === "POST" && p.startsWith("/gh/")) { response.writeHead(p.endsWith("/dispatches") ? 204 : 201); return response.end(); }
    // GitLab
    if (p === "/gl/projects/g%2Fr/pipelines" || p === "/gl/projects/g/r/pipelines") return send(200, [{ id: 300, iid: 30, sha: sha2, ref: "main", status: "manual", source: "push", created_at: "2026-11-28T09:00:00Z", updated_at: "2026-11-28T09:05:00Z", web_url: "https://gitlab.example/g/r/-/pipelines/300" }, { id: 299, iid: 29, sha: sha1, ref: "main", status: "failed", source: "web", created_at: "2026-11-27T09:00:00Z", updated_at: "2026-11-27T09:03:00Z", web_url: "u" }]);
    if (/\/gl\/projects\/g(%2F|\/)r\/pipelines\/300\/jobs/.test(p)) return send(200, [{ id: 3002, name: "deploy", stage: "deploy", status: "manual", web_url: "j" }, { id: 3001, name: "build", stage: "build", status: "success", started_at: "2026-11-28T09:00:00Z", finished_at: "2026-11-28T09:01:00Z", duration: 60.4, web_url: "j" }]);
    if (/\/gl\/projects\/g(%2F|\/)r\/pipelines\/300\/bridges/.test(p)) return send(200, []);
    if (/\/gl\/projects\/g(%2F|\/)r\/jobs\/3001\/trace/.test(p)) return send(200, "section_start:1700000000:build\r\x1b[0K\x1b[32mBuilding\x1b[0m\nsection_end:1700000001:build\r\x1b[0Kok\n", "text/plain");
    if (/\/gl\/projects\/g(%2F|\/)r\/pipelines\/299$/.test(p)) return send(200, { id: 299, ref: "main" });
    if (request.method === "POST" && p.startsWith("/gl/")) return send(201, { id: 301 });
    // Gitea (old server: no /actions/runs)
    if (p === "/gt/repos/o/r/actions/runs") return send(404, { message: "not found" });
    if (p === "/gt/repos/o/r/actions/tasks") return send(200, { total_count: 1, workflow_runs: [{ id: 4, run_number: 2, name: "build", display_title: "second commit", head_branch: "main", head_sha: sha2, event: "push", status: "completed", conclusion: "success", created_at: "2026-11-28T08:00:00Z", run_started_at: "2026-11-28T08:00:00Z", updated_at: "2026-11-28T08:00:40Z", url: "https://gitea.example/o/r/actions/runs/2", workflow_id: "ci.yml" }] });
    if (request.method === "POST" && p.startsWith("/gt/")) { response.writeHead(204); return response.end(); }
    // Bitbucket Cloud
    if (p === "/bb/repositories/w/r/pipelines/" && request.method === "GET") return send(200, { values: [{ uuid: "{aaa}", build_number: 41, state: { name: "COMPLETED", result: { name: "FAILED" } }, target: { ref_name: "main", commit: { hash: sha1 }, selector: { type: "custom", pattern: "release" } }, created_on: "2026-11-26T10:00:00Z", completed_on: "2026-11-26T10:04:00Z", duration_in_seconds: 240, trigger: { name: "MANUAL" }, creator: { display_name: "Ann" } }] });
    if (p === "/bb/repositories/w/r/pipelines/%7Baaa%7D/steps/") return send(200, { values: [{ uuid: "{s1}", name: "Build", state: { name: "COMPLETED", result: { name: "FAILED" } }, started_on: "2026-11-26T10:00:00Z", completed_on: "2026-11-26T10:03:00Z" }] });
    if (p === "/bb/repositories/w/r/pipelines/%7Baaa%7D/steps/%7Bs1%7D/log") return send(200, "+ make\nboom\n", "text/plain");
    if (p === "/bb/repositories/w/r/pipelines/%7Baaa%7D" && request.method === "GET") return send(200, { target: { type: "pipeline_ref_target", ref_type: "branch", ref_name: "main", commit: { hash: sha1 }, selector: { type: "custom", pattern: "release" } } });
    if (request.method === "POST" && p.startsWith("/bb/")) return send(201, { build_number: 42 });
    // Bitbucket Server build statuses
    if (p === `/bbs/rest/build-status/1.0/commits/${sha2}`) return send(200, { values: [{ key: "J1", name: "Jenkins", state: "SUCCESSFUL", url: "https://jenkins/1", dateAdded: 1764320000000 }, { key: "S1", name: "Sonar", state: "FAILED", url: "https://sonar/1" }] });
    if (p.startsWith("/bbs/rest/build-status/1.0/commits/")) return send(200, { values: [] });
    send(404, { message: `no mock for ${p}` });
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const host = (provider: string, prefix: string, owner = "o", repository = "r") => ({ provider, host: "127.0.0.1", owner, repository, apiBase: `${base}/${prefix}`, webBase: `https://web/${owner}/${repository}` }) as never;

try {
  eq(ci.cleanLog("2026-01-01T00:00:00.123Z \x1b[1mhi\x1b[0m\nsection_start:1:x\r\x1b[0Kline"), "hi\nline", "logs lose colours, timestamps and section markers");
  eq(ci.combineStatus(["success", "running", "failure"]), "failure", "worst status wins");

  // GitHub
  const gh = host("github", "gh");
  let result = await ci.ciRuns(root, gh, "tok", { branch: "main" });
  eq(result.runs.map((run) => [run.id, run.status, run.number, run.actor]), [["11", "running", 7, "ann"], ["10", "failure", 6, "bob"]], "GitHub runs mapped");
  eq([result.runs[1].durationSeconds, result.runs[1].attempt, result.capabilities.cancel, result.hasMore], [150, 2, true, false], "duration, attempt, capabilities");
  const jobs = await ci.ciRunJobs(root, gh, "tok", "10");
  eq([jobs[0].name, jobs[0].status, jobs[0].durationSeconds, jobs[0].steps.map((step) => step.status)], ["build", "failure", 120, ["success", "failure"]], "GitHub jobs and steps");
  eq(await ci.ciJobLog(gh, "tok", "10", "99"), "error: test failed\ndone\n", "GitHub log follows the redirect without sending the token");
  requests.length = 0;
  eq(await ci.ciRunAction(gh, "tok", "rerun_failed", "10"), "Re-running the failed jobs of run 10", "re-run failed jobs");
  await ci.ciRunAction(gh, "tok", "cancel", "11");
  await ci.ciRunAction(gh, "tok", "rerun_job", "10", "99");
  eq(requests.map((line) => line.split(" ").slice(0, 2).join(" ")), ["POST /gh/repos/o/r/actions/runs/10/rerun-failed-jobs", "POST /gh/repos/o/r/actions/runs/11/cancel", "POST /gh/repos/o/r/actions/jobs/99/rerun"], "GitHub action endpoints");
  const workflows = await ci.ciWorkflows(root, gh, "tok");
  const deploy = workflows.find((workflow) => workflow.name === "Deploy")!;
  eq([workflows.find((workflow) => workflow.name === "CI")?.dispatchable, deploy.dispatchable, deploy.inputs.map((input) => [input.name, input.type, input.default, input.options, input.required])], [false, true, [["env", "choice", "staging", ["staging", "prod"], true], ["dry", "boolean", "", [], false]]], "workflow_dispatch inputs read from the workflow file");
  requests.length = 0;
  await ci.ciDispatch(gh, "tok", { workflowId: "6", ref: "main", inputs: { env: "prod", dry: "true" } });
  eq(requests[0].split(" auth=")[0], 'POST /gh/repos/o/r/actions/workflows/6/dispatches {"ref":"main","inputs":{"env":"prod","dry":"true"}}', "dispatch with inputs");
  await assert.rejects(() => ci.ciRunAction(gh, "", "cancel", "11"), /token/); checks += 1;
  await assert.rejects(() => ci.ciRunJobs(root, gh, "tok", "../x"), /invalid run id/); checks += 1;

  // GitLab
  const gl = host("gitlab", "gl", "g", "r");
  result = await ci.ciRuns(root, gl, "tok", { branch: "main" });
  eq(result.runs.map((run) => [run.id, run.status, run.title]), [["300", "manual", "second commit"], ["299", "failure", "first commit"]], "GitLab pipelines with commit subjects from the local repository");
  const glJobs = await ci.ciRunJobs(root, gl, "tok", "300");
  eq(glJobs.map((job) => [job.name, job.stage, job.status, job.durationSeconds]), [["build", "build", "success", 60], ["deploy", "deploy", "manual", null]], "GitLab jobs with stages, manual job");
  eq(await ci.ciJobLog(gl, "tok", "300", "3001"), "Building\nok\n", "GitLab trace cleaned");
  requests.length = 0;
  await ci.ciRunAction(gl, "tok", "play_job", "300", "3002");
  await ci.ciRunAction(gl, "tok", "rerun_failed", "299");
  eq(await ci.ciRunAction(gl, "tok", "rerun", "299"), "Started pipeline 301 on main", "GitLab run again starts a new pipeline on the ref");
  eq(requests.filter((line) => line.startsWith("POST")).map((line) => line.split(" auth=")[0].replace(/g%2Fr/, "g/r")), ["POST /gl/projects/g/r/jobs/3002/play", "POST /gl/projects/g/r/pipelines/299/retry", 'POST /gl/projects/g/r/pipeline {"ref":"main"}'], "GitLab action endpoints");
  eq(requests[0].endsWith("auth=tok"), true, "GitLab token sent as PRIVATE-TOKEN");
  const glWorkflows = await ci.ciWorkflows(root, gl, "tok");
  eq(glWorkflows[0].inputs.map((input) => [input.name, input.default, input.type]), [["DEPLOY_ENV", "staging", "choice"]], "GitLab pipeline variables with a description become inputs");
  requests.length = 0;
  await ci.ciDispatch(gl, "tok", { workflowId: "pipeline", ref: "main", inputs: { DEPLOY_ENV: "production" } });
  eq(requests[0].split(" auth=")[0].replace(/g%2Fr/, "g/r"), 'POST /gl/projects/g/r/pipeline {"ref":"main","variables":[{"key":"DEPLOY_ENV","value":"production","variable_type":"env_var"}]}', "GitLab run pipeline with variables");

  // Gitea
  const gt = host("gitea", "gt");
  result = await ci.ciRuns(root, gt, "tok", { branch: "main" });
  eq([result.runs.map((run) => [run.id, run.status, run.durationSeconds]), result.capabilities.cancel], [[["4", "success", 40]], false], "Gitea runs from the older tasks API");
  const gtWorkflows = await ci.ciWorkflows(root, gt, "tok");
  eq(gtWorkflows.map((workflow) => [workflow.id, workflow.dispatchable]), [["ci.yml", false], ["deploy.yml", true]], "Gitea workflows from the repository files");
  await assert.rejects(() => ci.ciRunAction(gt, "tok", "cancel", "4"), /cannot do this/); checks += 1;

  // Bitbucket Cloud
  const bb = host("bitbucket-cloud", "bb", "w", "r");
  result = await ci.ciRuns(root, bb, "tok", {});
  eq(result.runs.map((run) => [run.id, run.status, run.number, run.name, run.durationSeconds, run.event]), [["{aaa}", "failure", 41, "custom: release", 240, "manual"]], "Bitbucket pipelines");
  eq((await ci.ciRunJobs(root, bb, "tok", "{aaa}")).map((job) => [job.id, job.status, job.durationSeconds]), [["{s1}", "failure", 180]], "Bitbucket steps");
  eq(await ci.ciJobLog(bb, "tok", "{aaa}", "{s1}"), "+ make\nboom\n", "Bitbucket step log");
  requests.length = 0;
  eq(await ci.ciRunAction(bb, "tok", "rerun", "{aaa}"), "Started pipeline #42", "Bitbucket run again");
  eq(JSON.parse(requests.find((line) => line.startsWith("POST"))!.split(" ").slice(2).join(" ").split(" auth=")[0]).target.selector, { type: "custom", pattern: "release" }, "same custom pipeline started again");
  const bbWorkflows = await ci.ciWorkflows(root, bb, "tok");
  eq(bbWorkflows.map((workflow) => [workflow.id, workflow.inputs.map((input) => `${input.name}=${input.default}`)]), [["default", []], ["custom:release", ["VERSION=1.0"]]], "Bitbucket custom pipelines with variables");
  requests.length = 0;
  await ci.ciDispatch(bb, "tok", { workflowId: "custom:release", ref: "main", inputs: { VERSION: "2.0" } });
  eq(JSON.parse(requests[0].split(" ").slice(2).join(" ").split(" auth=")[0]), { target: { type: "pipeline_ref_target", ref_type: "branch", ref_name: "main", selector: { type: "custom", pattern: "release" } }, variables: [{ key: "VERSION", value: "2.0" }] }, "Bitbucket custom pipeline with variables");

  // Bitbucket Server
  const bbs = host("bitbucket-server", "bbs/rest/api/1.0");
  result = await ci.ciRuns(root, bbs, "tok", { branch: "main" });
  eq([result.runs.map((run) => [run.sha === sha2, run.status, run.name, run.title]), result.capabilities.statusesOnly], [[[true, "failure", "Jenkins, Sonar", "second commit"]], true], "Bitbucket Server: build statuses per commit");
  eq((await ci.ciRunJobs(root, bbs, "tok", sha2)).map((job) => [job.name, job.status, job.url]), [["Jenkins", "success", "https://jenkins/1"], ["Sonar", "failure", "https://sonar/1"]], "each build is a job with its link");
  eq((await ci.ciLatest(root, gh, "tok", "main")).run?.id, "11", "latest run of a branch");
} finally {
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`ci: ${checks} checks passed`);

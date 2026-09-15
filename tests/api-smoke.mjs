// End-to-end smoke test for the TypeScript API server.
//
// Boots the server on a random port against a real temporary Git repository
// and exercises every /api route, including a full merge-conflict resolution
// cycle and an interactive rebase through the planner.
//
// Run: npm run test:api   (Node 22+, git on PATH)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "..", "server", "index.ts");

const PORT = 14231 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "chrono-api-test-"));
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chrono-config-"));

let failures = 0;
let checks = 0;

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function write(file, content) {
  fs.writeFileSync(path.join(ROOT, file), content);
}

function assert(condition, label) {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

async function api(command, payload) {
  const response = await fetch(`${BASE}/api/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`${command}: ${body.error}`);
  return body.result;
}

async function apiError(command, payload) {
  const response = await fetch(`${BASE}/api/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await response.json();
  if (body.ok) throw new Error(`${command}: expected failure but got success`);
  return body.error;
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("API server did not start in time");
}

// --- fixture repository -------------------------------------------------------
//
//  base ── main change ── main C ── M (merge)
//    └──── A ── B ── feature change   (feature)
function buildRepo() {
  git(["init", "-q", "-b", "main", ROOT]);
  git(["config", "user.name", "API Smoke"]);
  git(["config", "user.email", "smoke@example.test"]);

  write("base.txt", "base\n");
  git(["add", "base.txt"]);
  git(["commit", "-q", "-m", "base commit"]);

  git(["switch", "-qc", "feature"]);
  write("a.txt", "a\n");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "feature A"]);
  write("b.txt", "b\n");
  git(["add", "b.txt"]);
  git(["commit", "-q", "-m", "feature B"]);

  git(["switch", "-q", "main"]);
  write("base.txt", "main\n");
  git(["commit", "-q", "-am", "main change"]);
  write("c.txt", "c\n");
  git(["add", "c.txt"]);
  git(["commit", "-q", "-m", "main C"]);

  git(["switch", "-q", "feature"]);
  write("base.txt", "feature\n");
  git(["commit", "-q", "-am", "feature change"]);
  git(["switch", "-q", "main"]);
}

async function run() {
  // health
  const health = await api("health");
  assert(health.name === "chrono-next-server", "health reports server name");

  // summary / history / status / branches
  const summary = await api("repository_summary", { path: ROOT });
  assert(summary.branch === "main", "summary reports current branch");
  assert(summary.name === path.basename(ROOT), "summary reports repo name");

  const history = await api("repository_history", { path: ROOT, limit: 100 });
  assert(history.length === 3, `main history lists 3 commits (got ${history.length})`);
  assert(history[0].id.length === 40, "history commit id is full sha");
  assert(history[0].authorName === "API Smoke", "history parses author name");

  const status = await api("repository_status", { path: ROOT });
  assert(Array.isArray(status) && status.length === 0, "status is clean at setup");

  const branches = await api("repository_branches", { path: ROOT });
  assert(branches.some((b) => b.name === "main" && b.current), "branches marks main current");
  assert(branches.some((b) => b.name === "feature" && !b.current), "branches lists feature");

  // operation state (idle)
  const idle = await api("repository_operation_state", { path: ROOT });
  assert(idle.operation === null, "operation state idle");
  assert(idle.canAbort === false, "idle state cannot abort");

  // create / switch branches
  await api("create_branch", { path: ROOT, branch: "smoke-branch" });
  const afterCreate = await api("repository_summary", { path: ROOT });
  assert(afterCreate.branch === "smoke-branch", "create_branch switches to new branch");
  await api("switch_branch", { path: ROOT, branch: "main" });

  // merge -> conflict -> detail -> resolve -> continue
  let merged = false;
  try {
    git(["merge", "--no-edit", "feature"]);
    merged = true;
  } catch {
    // expected: conflict
  }
  assert(!merged, "merge conflicts on base.txt");
  assert(fs.existsSync(path.join(ROOT, ".git", "MERGE_HEAD")), "MERGE_HEAD exists");

  const mergeState = await api("repository_operation_state", { path: ROOT });
  assert(mergeState.operation === "merge", "operation state detects merge");
  assert(mergeState.conflictCount === 1, `merge has 1 conflict (got ${mergeState.conflictCount})`);
  assert(mergeState.canContinue === false, "cannot continue while conflicted");

  const conflicts = await api("repository_conflicts", { path: ROOT });
  assert(conflicts.length === 1 && conflicts[0].path === "base.txt", "conflict center lists base.txt");
  assert(conflicts[0].kind === "content", "conflict kind is content");

  const detail = await api("conflict_detail", { path: ROOT, file: "base.txt" });
  assert(detail.current !== null && detail.current.text.includes("main"), "detail current side");
  assert(detail.incoming !== null && detail.incoming.text.includes("feature"), "detail incoming side");
  assert(detail.base !== null && detail.base.text.includes("base"), "detail base side");

  const refused = await apiError("control_repository_operation", { path: ROOT, action: "continue" });
  assert(refused.includes("resolve"), "continue refused while conflicts remain");

  const resolution = await api("resolve_conflict", {
    path: ROOT,
    file: "base.txt",
    strategy: "merged",
    content: "resolved\n",
  });
  assert(resolution.remaining === 0, "resolution reports 0 remaining");
  assert(fs.readFileSync(path.join(ROOT, "base.txt"), "utf8") === "resolved\n", "resolved content written");

  const continued = await api("control_repository_operation", { path: ROOT, action: "continue" });
  assert(continued.exitCode === 0, "merge continue succeeds");
  const afterMerge = await api("repository_operation_state", { path: ROOT });
  assert(afterMerge.operation === null, "merge finished");

  // rebase planner: new branch from the root commit, two commits, no overlaps.
  const firstCommit = git(["rev-list", "--max-parents=0", "HEAD"]);
  git(["switch", "-qc", "planner", firstCommit]);
  write("p1.txt", "one\n");
  git(["add", "p1.txt"]);
  git(["commit", "-q", "-m", "planner one"]);
  write("p2.txt", "two\n");
  git(["add", "p2.txt"]);
  git(["commit", "-q", "-m", "planner two"]);

  const plan = await api("prepare_rebase_plan", { path: ROOT, target: "main" });
  assert(plan.commits.length === 2, `plan covers the 2 planner commits (got ${plan.commits.length})`);
  assert(plan.commits[0].subject === "planner one", "plan preserves commit order");
  assert(plan.blockedReason === null, "plan not blocked");

  const planItems = plan.commits.map((commit) => ({
    commit: commit.commit,
    subject: commit.subject,
    action: "pick",
  }));
  const started = await api("start_rebase_plan", {
    path: ROOT,
    target: "main",
    base: plan.base,
    items: planItems,
    updateRefs: false,
  });
  assert(started.result.exitCode === 0, "rebase completes cleanly");
  assert(started.operation.operation === null, "rebase finished in one go");
  const headSubject = git(["log", "-1", "--format=%s", "planner"]);
  assert(headSubject === "planner two", "rebased branch head is the second commit");

  // a stale base must be rejected
  const staleBase = await apiError("start_rebase_plan", {
    path: ROOT,
    target: "main",
    base: "0000000000000000000000000000000000000000",
    items: planItems,
    updateRefs: false,
  });
  assert(staleBase.length > 0, "stale rebase base rejected");
  git(["switch", "-q", "main"]);

  // insights
  const search = await api("search_commits", { path: ROOT, query: "feature A" });
  assert(search.commits.length >= 1, "search finds commit by message");
  const searchAtMe = await api("search_commits", { path: ROOT, query: "@me" });
  assert(searchAtMe.commits.length >= 1, "search @me matches configured identity");

  const details = await api("commit_details", { path: ROOT, commit: history[1].id });
  assert(details.subject === "main change", "commit details parse subject");
  assert(Array.isArray(details.files) && details.files.some((file) => file.path === "base.txt"), "commit details include files");

  const modifiedDiff = await api("commit_file_diff", { path: ROOT, commit: history[1].id, file: "base.txt" });
  assert(modifiedDiff.status === "modified", `commit_file_diff reports modified (got ${modifiedDiff.status})`);
  assert(modifiedDiff.additions === 1 && modifiedDiff.deletions === 1, "commit_file_diff counts add/del lines");
  assert(modifiedDiff.binary === false && modifiedDiff.hunks.length === 1, "commit_file_diff returns one hunk");
  const hunkTexts = modifiedDiff.hunks[0].lines.map((line) => line.kind + ":" + line.text);
  assert(hunkTexts.includes("del:base") && hunkTexts.includes("add:main"), "commit_file_diff hunk lines parse");
  assert(modifiedDiff.hunks[0].lines.every((line) => line.number === null || Number.isInteger(line.number)), "commit_file_diff line numbers");

  const addedDiff = await api("commit_file_diff", { path: ROOT, commit: history[2].id, file: "base.txt" });
  assert(addedDiff.status === "added" && addedDiff.additions === 1 && addedDiff.deletions === 0, "commit_file_diff reports root commit file as added");
  const badDiff = await apiError("commit_file_diff", { path: ROOT, commit: history[1].id, file: "-malicious" });
  assert(badDiff.length > 0, "commit_file_diff rejects path-like revisions");

  const stats = await api("history_change_stats", { path: ROOT, limit: 50 });
  const mergeSha = git(["log", "--merges", "-1", "--format=%H"]);
  assert(stats.length >= 3, "history stats cover commits");
  assert(stats.every((stat) => stat.filesChanged >= 1 || stat.commit === mergeSha), "history stats count files");

  const comparison = await api("compare_refs", { path: ROOT, left: "main", right: "feature" });
  assert(comparison.leftId.length === 40 && comparison.rightId.length === 40, "compare refs resolve ids");
  assert(comparison.leftOnlyCount >= 1, "compare refs counts left-only commits");
  assert(Array.isArray(comparison.filesFromBaseToLeft), "compare refs reports file diffs");

  const fileHistory = await api("file_history", { path: ROOT, file: "base.txt", followRenames: true, allRefs: true, limit: 50 });
  assert(fileHistory.length >= 3, `file history lists base.txt commits (got ${fileHistory.length})`);

  const lineHistory = await api("line_history", { path: ROOT, file: "base.txt", start: 1, end: 1, limit: 20 });
  assert(lineHistory.length >= 1, "line history returns commits");

  const blame = await api("blame_file", { path: ROOT, file: "base.txt" });
  assert(blame.lines.length >= 1, "blame returns lines");
  assert(blame.lines.every((line) => line.commit.length === 40), "blame commit ids are full shas");
  assert(blame.lines[0].content.includes("resolved"), "blame content matches working tree");

  const contributors = await api("contributors", { path: ROOT, maxCommits: 1000 });
  assert(contributors.length === 1 && contributors[0].email === "smoke@example.test", "contributors aggregate identity");

  const worktrees = await api("worktree_summaries", { path: ROOT });
  assert(worktrees.length === 1 && worktrees[0].isMain, "worktree summary lists main worktree");
  assert(worktrees[0].dirtyCount === 0, "worktree summary reports clean tree");

  // workflows
  const stash = await api("run_workflow", { path: ROOT, operation: "stash_list", args: [] });
  assert(stash.exitCode === 0, "workflow stash_list runs");
  const reflog = await api("run_workflow", { path: ROOT, operation: "reflog", args: [] });
  assert(reflog.stdout.length > 0, "workflow reflog returns output");
  const badWorkflow = await apiError("run_workflow", { path: ROOT, operation: "nope", args: [] });
  assert(badWorkflow.includes("unknown workflow"), "unknown workflow rejected");
  const shortArgs = await apiError("run_workflow", { path: ROOT, operation: "worktree_add", args: ["only-one"] });
  assert(shortArgs.includes("requires at least"), "workflow arg validation works");

  // stage / unstage / commit
  write("staged.txt", "staged\n");
  git(["add", "staged.txt"]);
  const status2 = await api("repository_status", { path: ROOT });
  assert(status2.length === 1 && status2[0].indexStatus === "A", "staged file reported");
  await api("unstage_paths", { path: ROOT, files: ["staged.txt"] });
  const status3 = await api("repository_status", { path: ROOT });
  assert(status3.length === 1 && status3[0].indexStatus === "?", "unstaged file reported as untracked");
  await api("stage_paths", { path: ROOT, files: ["staged.txt"] });
  const commitId = await api("create_commit", { path: ROOT, message: "add staged file" });
  assert(commitId.length === 40, "commit returns head sha");
  const emptyCommit = await apiError("create_commit", { path: ROOT, message: "   " });
  assert(emptyCommit.includes("empty"), "empty commit message rejected");

  // workspaces
  const saved = [{ id: "local", name: "Local repositories", repositories: [{ path: ROOT }] }];
  await api("save_workspaces", { workspaces: saved });
  const loaded = await api("load_workspaces", {});
  assert(loaded.length === 1 && loaded[0].repositories[0].path === ROOT, "workspaces round-trip");

  // validation errors
  const missingPath = await apiError("repository_summary", {});
  assert(missingPath.includes("path"), "missing path field rejected");
  const unsafePath = await apiError("conflict_detail", { path: ROOT, file: "../escape.txt" });
  assert(unsafePath.includes("safe"), "unsafe conflict path rejected");
  const missingField = await apiError("resolve_conflict", { path: ROOT, file: "base.txt" });
  assert(missingField.includes("strategy"), "missing required strategy rejected");

  // unknown route
  const unknown = await fetch(`${BASE}/api/definitely_not_a_command`, {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
  assert(unknown.status === 404, "unknown route returns 404");

  // pull requests (offline: expect a controlled error, not a crash)
  const prError = await apiError("list_pull_requests", {
    provider: "github",
    baseUrl: "http://127.0.0.1:1",
    owner: "o",
    repository: "r",
    token: "t",
  });
  assert(prError.length > 0, "pull requests fail gracefully offline");
  const prProvider = await apiError("list_pull_requests", {
    provider: "bitbucket",
    baseUrl: "http://example.invalid",
    owner: "o",
    repository: "r",
    token: "t",
  });
  assert(prProvider.includes("unsupported provider"), "unknown provider rejected");
}

// --- main ----------------------------------------------------------------------
const server = spawn(process.execPath, ["--experimental-strip-types", serverEntry], {
  env: { ...process.env, CHRONO_PORT: String(PORT), CHRONO_CONFIG_DIR: CONFIG_DIR, CHRONO_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });

let exiting = false;
function cleanup() {
  exiting = true;
  try { server.kill(); } catch { /* already dead */ }
  for (const dir of [ROOT, CONFIG_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

server.on("exit", (code) => {
  if (!exiting) {
    console.error("server exited early:\n", serverLog);
    cleanup();
    process.exit(1);
  }
});

try {
  buildRepo();
  await waitForServer();
  await run();
} catch (error) {
  failures += 1;
  console.error("UNEXPECTED ERROR:", error);
  console.error(serverLog.slice(-4000));
} finally {
  cleanup();
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);

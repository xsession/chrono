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
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chrono-api-output-"));
const APPLY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chrono-api-apply-"));
const WORKTREE_DIR = path.join(os.tmpdir(), `chrono-api-worktree-${process.pid}-${Date.now()}`);

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
  git(["remote", "add", "origin", "git@github.com:xsession/chrono.git"]);
  const remotes = await api("repository_remotes", { path: ROOT });
  assert(remotes.length === 1 && remotes[0].fetchUrl.includes("github.com:xsession/chrono.git"), "repository_remotes parses fetch URLs");
  assert(remotes[0].pushUrl === remotes[0].fetchUrl, "repository_remotes preserves the push URL");
  git(["remote", "remove", "origin"]);

  const history = await api("repository_history", { path: ROOT, limit: 100 });
  assert(history.length === 3, `main history lists 3 commits (got ${history.length})`);
  assert(history[0].id.length === 40, "history commit id is full sha");
  assert(history[0].authorName === "API Smoke", "history parses author name");

  const historyPage1 = await api("repository_history_page", { path: ROOT, limit: 2 });
  assert(historyPage1.commits.length === 2 && historyPage1.hasMore, "history page returns a bounded first slice");
  const historyPage2 = await api("repository_history_page", { path: ROOT, limit: 2, cursor: historyPage1.nextCursor });
  assert(historyPage2.commits.length >= 1 && historyPage2.commits[0].id !== historyPage1.commits[0].id, "history cursor advances without repeating the page");

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

  const rangeBase = git(["rev-parse", "HEAD"]);
  git(["switch", "-qc", "range-before", rangeBase]);
  write("range.txt", "before\n");
  git(["add", "range.txt"]);
  git(["commit", "-q", "-m", "range before"]);
  const rangeBefore = git(["rev-parse", "HEAD"]);
  git(["switch", "-q", "main"]);
  git(["switch", "-qc", "range-after", rangeBase]);
  write("range.txt", "after\n");
  git(["add", "range.txt"]);
  git(["commit", "-q", "-m", "range after"]);
  const rangeAfter = git(["rev-parse", "HEAD"]);
  git(["switch", "-q", "main"]);
  const rangeDiff = await api("range_diff", { path: ROOT, base: rangeBase, before: rangeBefore, after: rangeAfter });
  assert(rangeDiff.entries.length === 2, "range_diff reports the rewritten patch series");
  assert(rangeDiff.entries.some((entry) => entry.status === "deleted" && entry.oldCommit) && rangeDiff.entries.some((entry) => entry.status === "added" && entry.newCommit), "range_diff reports removed and added patch entries");

  const repositoryHealth = await api("repository_health", { path: ROOT });
  assert(repositoryHealth.worktreeCount === 1 && repositoryHealth.dirtyFiles === 0, "repository_health reports a clean main worktree");
  assert(repositoryHealth.reflogEntries > 0 && repositoryHealth.objectCount >= 0, "repository_health reports recovery and object metrics");
  const scannedHealth = await api("repository_health", { path: ROOT, scanObjects: true });
  assert(scannedHealth.fsck.scanned === true && Array.isArray(scannedHealth.fsck.warnings), "repository_health can run an object scan");

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
  git(["tag", "v-smoke"]);
  const tagCheckout = await api("run_workflow", { path: ROOT, operation: "checkout_tag", args: ["v-smoke"] });
  assert(tagCheckout.exitCode === 0, "workflow checkout_tag detaches at the tag");
  const detachedSummary = await api("repository_summary", { path: ROOT });
  assert(detachedSummary.branch === null, "tag checkout reports detached HEAD");
  git(["switch", "-q", "main"]);
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
  const draft = await api("draft_commit_message", { path: ROOT, mode: "rules" });
  assert(draft.source === "local-rules" && draft.files.length === 1 && draft.files[0].path === "staged.txt", "local commit writer summarizes staged files");
  assert(draft.subject.length > 0 && draft.subject.length <= 72 && draft.message.startsWith(draft.subject), "local commit writer returns a bounded commit message");
  const conventionalDraft = await api("draft_commit_message", { path: ROOT, mode: "rules", style: "conventional", issueReference: "CHRONO-42" });
  assert(conventionalDraft.style === "conventional" && conventionalDraft.issueReference === "CHRONO-42" && /^\w+: /.test(conventionalDraft.subject) && conventionalDraft.body.includes("Refs: CHRONO-42"), "commit writer applies conventional style and issue references");
  const plainDraft = await api("draft_commit_message", { path: ROOT, mode: "rules", style: "plain", issueReference: "#7" });
  assert(plainDraft.style === "plain" && !/^\w+: /.test(plainDraft.subject) && plainDraft.body.includes("Refs: #7"), "commit writer supports plain style with issue references");
  const invalidIssue = await apiError("draft_commit_message", { path: ROOT, mode: "rules", issueReference: "not an issue" });
  assert(invalidIssue.includes("issue reference"), "commit writer rejects unsafe issue references");
  const autoDraft = await api("draft_commit_message", { path: ROOT, mode: "auto" });
  assert((autoDraft.source === "local-rules" || autoDraft.source === "ollama") && autoDraft.message.length > 0, "auto commit writer uses a local model or offline fallback");
  const commitId = await api("create_commit", { path: ROOT, message: "add staged file" });
  assert(commitId.length === 40, "commit returns head sha");
  const emptyCommit = await apiError("create_commit", { path: ROOT, message: "   " });
  assert(emptyCommit.includes("empty"), "empty commit message rejected");
  const emptyDraft = await apiError("draft_commit_message", { path: ROOT, mode: "rules" });
  assert(emptyDraft.includes("no staged changes"), "local commit writer rejects an empty index");

  // workspaces
  const saved = [{ id: "local", name: "Local repositories", repositories: [{ path: ROOT }] }];
  await api("save_workspaces", { workspaces: saved });
  const loaded = await api("load_workspaces", {});
  assert(loaded.length === 1 && loaded[0].repositories[0].path === ROOT, "workspaces round-trip");

  // direct repository actions backing the Repo browser, Branches, Recovery,
  // References and History controls
  const currentHead = git(["rev-parse", "HEAD"]);
  const parentHead = git(["rev-parse", "HEAD^"]);
  const refsBefore = await api("reference_groups", { path: ROOT });
  assert(Array.isArray(refsBefore.branches) && Array.isArray(refsBefore.tags) && Array.isArray(refsBefore.stashes), "reference groups return every ref collection");

  const tagsBefore = await api("list_tags", { path: ROOT });
  assert(Array.isArray(tagsBefore), "list_tags returns a list");
  await api("create_branch_at", { path: ROOT, branch: "ui-commit-action", revision: parentHead });
  assert((await api("repository_branches", { path: ROOT })).some((branch) => branch.name === "ui-commit-action"), "create_branch_at creates a branch without switching HEAD");
  await api("delete_branch", { path: ROOT, branch: "ui-commit-action", force: false });
  await api("create_tag", { path: ROOT, name: "v-direct", revision: currentHead, message: "direct endpoint tag" });
  const directTag = (await api("list_tags", { path: ROOT })).find((tag) => tag.name === "v-direct");
  assert(directTag?.annotated === true && directTag.target === currentHead, "create_tag creates an annotated tag at the requested revision");
  await api("delete_tag", { path: ROOT, name: "v-direct" });
  assert(!(await api("list_tags", { path: ROOT })).some((tag) => tag.name === "v-direct"), "delete_tag removes the tag");

  write("working.txt", "working\n");
  const workingDiff = await api("working_tree_diff", { path: ROOT, file: "working.txt" });
  assert(workingDiff.status === "??" && workingDiff.additions === 1, "working_tree_diff includes an untracked file");
  const cleanPreview = await api("clean_untracked", { path: ROOT, dryRun: true });
  assert(cleanPreview.stdout.includes("working.txt"), "clean_untracked dry-run lists untracked files");
  await api("clean_untracked", { path: ROOT, dryRun: false });
  assert(!fs.existsSync(path.join(ROOT, "working.txt")), "clean_untracked deletes only after the explicit non-dry run");

  const hunkLines = Array.from({ length: 12 }, (_value, index) => `line-${index + 1}`).join("\n") + "\n";
  write("hunks.txt", hunkLines);
  git(["add", "hunks.txt"]);
  git(["commit", "-q", "-m", "hunk staging fixture"]);
  write("hunks.txt", hunkLines.replace("line-2", "line-2 changed").replace("line-11", "line-11 changed"));
  const unstagedHunks = await api("unstaged_file_diff", { path: ROOT, file: "hunks.txt" });
  assert(unstagedHunks.hunks.length === 2, `unstaged_file_diff exposes separate text hunks (got ${unstagedHunks.hunks.length})`);
  await api("stage_hunks", { path: ROOT, file: "hunks.txt", hunks: [0] });
  const stagedHunkDiff = git(["diff", "--cached", "--", "hunks.txt"]);
  const remainingHunks = await api("unstaged_file_diff", { path: ROOT, file: "hunks.txt" });
  assert(stagedHunkDiff.includes("line-2 changed") && remainingHunks.hunks.length === 1, "stage_hunks stages only the selected hunk");
  await api("stage_hunks", { path: ROOT, file: "hunks.txt", hunks: [0] });
  assert(git(["diff", "--cached", "--name-only"]).includes("hunks.txt") && (await api("repository_status", { path: ROOT })).every((change) => change.path !== "hunks.txt" || change.worktreeStatus === " "), "stage_hunks can finish staging the remaining hunk");
  const emptyHunkSelection = await apiError("stage_hunks", { path: ROOT, file: "hunks.txt", hunks: [] });
  assert(emptyHunkSelection.includes("at least one hunk"), "stage_hunks rejects an empty selection");
  git(["commit", "-q", "-m", "complete hunk staging fixture"]);

  const tree = await api("list_tree", { path: ROOT, revision: "HEAD", dir: "" });
  assert(tree.some((entry) => entry.path === "staged.txt" && entry.type === "blob"), "list_tree exposes files at a revision");
  const fileAtRevision = await api("file_at_revision", { path: ROOT, revision: "HEAD", dir: "staged.txt" });
  assert(fileAtRevision.content === "staged\n" && fileAtRevision.binary === false, "file_at_revision returns text content");
  const rootFile = await api("file_at_revision", { path: ROOT, revision: history[2].id, dir: "base.txt" });
  assert(rootFile.content === "base\n" && rootFile.binary === false, "file_at_revision previews a root revision");

  const patch = await api("create_patch", { path: ROOT, from: parentHead, to: currentHead });
  assert(patch.size > 0 && patch.base64.length > 0 && patch.name.endsWith(".patch"), "create_patch returns a binary-safe patch export");
  const patchPath = path.join(OUT_DIR, "direct.patch");
  const savedPatch = await api("save_patch", { path: ROOT, from: parentHead, to: currentHead, destination: patchPath });
  assert(savedPatch.includes("direct.patch") && fs.statSync(patchPath).size > 0, "save_patch writes the requested destination");
  execFileSync("git", ["clone", "-q", ROOT, APPLY_DIR]);
  execFileSync("git", ["-C", APPLY_DIR, "reset", "-q", "--hard", parentHead]);
  const applied = await api("apply_patch", { path: ROOT, data: patch.base64, dir: APPLY_DIR });
  assert(applied.exitCode === 0 && fs.existsSync(path.join(APPLY_DIR, "staged.txt")), "apply_patch applies the generated patch to another checkout");

  const revisionDiff = await api("diff_revisions", { path: ROOT, from: parentHead, to: currentHead, file: "staged.txt" });
  assert(revisionDiff.additions === 1 && revisionDiff.deletions === 0, "diff_revisions reports file changes between refs");
  assert(revisionDiff.hunks.length > 0 && revisionDiff.hunks[0].lines.some((line) => line.kind === "add"), "diff_revisions exposes unified hunk lines for the revision viewer");
  const activity = await api("commit_activity", { path: ROOT, days: 7 });
  assert(activity.length === 7 && activity.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date)), "commit_activity returns a dated heatmap window");
  const mergeNoop = await api("merge_branch", { path: ROOT, branch: "main", strategy: "ff-only" });
  assert(mergeNoop.exitCode === 0, "merge_branch supports a safe fast-forward no-op on the current branch");
  const exportDir = path.join(OUT_DIR, "exported");
  const exported = await api("export_revision", { path: ROOT, revision: "HEAD", destination: exportDir });
  assert(exported.stdout.includes("Exported") && fs.existsSync(path.join(exportDir, "staged.txt")), "export_revision archives a revision outside the repository");

  // per-item stash and worktree actions used by References and Workflow views
  git(["branch", "workflow-worktree"]);
  const addedWorktree = await api("run_workflow", { path: ROOT, operation: "worktree_add", args: [WORKTREE_DIR, "workflow-worktree"] });
  assert(addedWorktree.exitCode === 0 && fs.existsSync(path.join(WORKTREE_DIR, ".git")), "worktree_add creates a linked checkout");
  const refsWithWorktree = await api("reference_groups", { path: ROOT });
  assert(refsWithWorktree.worktrees.some((worktree) => worktree.path === WORKTREE_DIR), "reference groups expose the created worktree");
  fs.writeFileSync(path.join(WORKTREE_DIR, "monitor.txt"), "dirty worktree\n");
  const monitoredWorktrees = await api("worktree_summaries", { path: ROOT });
  const monitoredWorktree = monitoredWorktrees.find((worktree) => worktree.path === WORKTREE_DIR);
  assert(monitoredWorktree && monitoredWorktree.dirtyCount === 1 && monitoredWorktree.conflictCount === 0, "worktree summaries expose dirty session state");
  fs.unlinkSync(path.join(WORKTREE_DIR, "monitor.txt"));
  const removedWorktree = await api("run_workflow", { path: ROOT, operation: "worktree_remove", args: [WORKTREE_DIR] });
  assert(removedWorktree.exitCode === 0 && !fs.existsSync(WORKTREE_DIR), "worktree_remove removes the linked checkout");

  write("stash-apply.txt", "stash action\n");
  const pushedStash = await api("run_workflow", { path: ROOT, operation: "stash_push", args: ["UI action coverage"] });
  assert(pushedStash.exitCode === 0, "stash_push creates a stash from tracked and untracked changes");
  const stashRef = (await api("reference_groups", { path: ROOT })).stashes.find((stash) => stash.message.includes("UI action coverage"));
  assert(Boolean(stashRef), "reference groups expose the new stash");
  const appliedStash = await api("run_workflow", { path: ROOT, operation: "stash_apply", args: [stashRef.ref] });
  assert(appliedStash.exitCode === 0 && fs.existsSync(path.join(ROOT, "stash-apply.txt")), "stash_apply restores changes while keeping the stash");
  await api("clean_untracked", { path: ROOT, dryRun: false });
  const droppedStash = await api("run_workflow", { path: ROOT, operation: "stash_drop", args: [stashRef.ref] });
  assert(droppedStash.exitCode === 0, "stash_drop deletes the selected stash");
  write("stash-pop.txt", "pop action\n");
  await api("run_workflow", { path: ROOT, operation: "stash_push", args: ["UI pop coverage"] });
  const poppedStash = await api("run_workflow", { path: ROOT, operation: "stash_pop", args: [] });
  assert(poppedStash.exitCode === 0 && fs.existsSync(path.join(ROOT, "stash-pop.txt")), "stash_pop applies and removes the latest stash");
  await api("clean_untracked", { path: ROOT, dryRun: false });

  const bisectStart = await api("run_workflow", { path: ROOT, operation: "bisect_start", args: ["HEAD", "HEAD~3"] });
  assert(bisectStart.exitCode === 0, "bisect_start accepts bad then good revisions");
  const bisectReset = await api("run_workflow", { path: ROOT, operation: "bisect_reset", args: [] });
  assert(bisectReset.exitCode === 0, "bisect_reset returns the repository to its original branch");

  git(["switch", "-qc", "reset-action"]);
  write("reset-action.txt", "reset action\n");
  git(["add", "reset-action.txt"]);
  git(["commit", "-q", "-m", "reset action commit"]);
  const resetTarget = git(["rev-parse", "HEAD^"]);
  const resetResult = await api("reset_to_commit", { path: ROOT, revision: resetTarget, mode: "mixed" });
  assert(resetResult.exitCode === 0 && git(["rev-parse", "HEAD"]) === resetTarget, "reset_to_commit moves the branch with the requested mode");
  fs.unlinkSync(path.join(ROOT, "reset-action.txt"));
  git(["switch", "-q", "main"]);
  git(["branch", "-D", "reset-action"]);

  // validation errors
  const missingPath = await apiError("repository_summary", {});
  assert(missingPath.includes("path"), "missing path field rejected");
  // A folder that is not a git checkout (or is missing) must report the
  // problem with the path, not a bare "git rev-parse --show-toplevel: ".
  const nonRepo = await apiError("repository_summary", { path: CONFIG_DIR });
  assert(nonRepo.includes(CONFIG_DIR), `non-repo path is named in the error (got: ${nonRepo})`);
  assert(!nonRepo.endsWith(": "), "no dangling-colon error (empty git stderr)");
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

  // --- history filter (SourceGit query modes) -----------------------------------
  const msgFilter = await api("history_query", { path: ROOT, query: "feature change", mode: "message", limit: 50 });
  assert(msgFilter.length === 1 && msgFilter[0].subject === "feature change", `message filter finds the exact commit (got ${msgFilter.length})`);
  const msgNoMatch = await api("history_query", { path: ROOT, query: "zzz-no-such-message", mode: "message", limit: 50 });
  assert(msgNoMatch.length === 0, "message filter with no hits returns empty");
  const authorFilter = await api("history_query", { path: ROOT, query: "smoke@example.test", mode: "author", limit: 50 });
  assert(authorFilter.length >= 3 && authorFilter.every((commit) => commit.authorEmail === "smoke@example.test"), "author filter returns only that author");
  const pathFilter = await api("history_query", { path: ROOT, query: "base.txt", mode: "path", limit: 50 });
  assert(pathFilter.length >= 3, `path filter lists base.txt commits (got ${pathFilter.length})`);
  const pathNoMatch = await api("history_query", { path: ROOT, query: "does-not-exist.txt", mode: "path", limit: 50 });
  assert(pathNoMatch.length === 0, "path filter with no hits returns empty");

  // :(literal) pathspec: a file whose name contains glob characters must not
  // match its glob siblings.
  write("b[0].txt", "bracket\n");
  write("b1.txt", "sibling\n");
  git(["add", "b[0].txt", "b1.txt"]);
  git(["commit", "-q", "-m", "add bracket file"]);
  const literalHistory = await api("file_history", { path: ROOT, file: "b[0].txt", followRenames: true, allRefs: true, limit: 50 });
  assert(literalHistory.length === 1, `literal pathspec isolates the bracket file (got ${literalHistory.length} commits)`);

  // unborn HEAD: a fresh repo with zero commits returns empty, never an error.
  const UNBORN = fs.mkdtempSync(path.join(os.tmpdir(), "chrono-unborn-"));
  git(["init", "-q", UNBORN]);
  const unbornSummary = await api("repository_summary", { path: UNBORN });
  assert(unbornSummary.head === null, "unborn HEAD summary reports null head");
  const unbornHistory = await api("repository_history", { path: UNBORN, limit: 50 });
  assert(Array.isArray(unbornHistory) && unbornHistory.length === 0, "unborn HEAD history is empty, not an error");
  const unbornStatus = await api("repository_status", { path: UNBORN });
  assert(Array.isArray(unbornStatus) && unbornStatus.length === 0, "unborn HEAD status is empty, not an error");
  const unbornQuery = await api("history_query", { path: UNBORN, query: "anything", mode: "message", limit: 50 });
  assert(unbornQuery.length === 0, "unborn HEAD filter is empty, not an error");
  try { fs.rmSync(UNBORN, { recursive: true, force: true }); } catch { /* best effort */ }

  // invalid filter mode is rejected by the route
  const badMode = await apiError("history_query", { path: ROOT, query: "x", mode: "bogus" });
  assert(badMode.includes("filter mode"), "unknown filter mode rejected");
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
  for (const dir of [ROOT, CONFIG_DIR, OUT_DIR, APPLY_DIR, WORKTREE_DIR]) {
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

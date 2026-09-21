// Contract coverage for visible UI controls. This complements the API smoke
// test by ensuring every user-facing surface still has a handler or binding.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
let checks = 0;
let failures = 0;

function must(relative, needle, label) {
  checks += 1;
  const source = read(relative);
  const matched = typeof needle === "string" ? source.includes(needle) : needle.test(source);
  if (matched) console.log(`  ok  ${label}`);
  else { failures += 1; console.error(`FAIL  ${label}`); }
}

for (const view of ["conflicts", "changes", "history", "branches", "refs", "rebase", "insights", "repo", "worktrees", "submodules", "stashes", "recovery"]) {
  must("src/components/RepositorySidebar.tsx", `id: "${view}"`, `sidebar exposes ${view} view`);
}
for (const action of ["Fetch", "Pull", "Push", "refresh", "Open repository", "Clone from URL", "CommandPalette", "operation-continue", "operation-skip"]) {
  must("src/App.tsx", action, `app binds ${action}`);
}

for (const control of ["setHighlight(\"all\")", "setHighlight(\"current\")", "setHighlight(\"selected\")", "setShowChanges", "setScope", "Graph scope", "Reference visibility", "Solo current", "Show all", "toggleRef", "onLoadNewer", "onLoadMore", "onContextMenu", "ux-commit-context-menu", "CommitDiffView", "setDiffFile", "Cherry-pick", "Create branch here", "Create tag here", "onCommitAction", "Reset soft", "Reset mixed", "Reset hard", "onResetTo", "visibleHistoryRows", "onScroll", "ResizeObserver", "ux-history-virtual-spacer"]) {
  must("src/components/CommitGraph.tsx", control, `history binds ${control}`);
}
for (const control of ["onCreate", "onDelete", "api.listTags", "api.createTag", "api.deleteTag", "api.mergeBranch", "setAnnotated"]) {
  must("src/components/BranchPanel.tsx", control, `branches binds ${control}`);
}
for (const control of ["Show All", "Collapse All", "stash_pop", "stash_apply", "stash_drop", "onCheckoutTag", "submodule_init_path", "submodule_update_path", "onOpenWorktree", "Refresh references"]) {
  must("src/components/RefsBrowser.tsx", control, `references binds ${control}`);
}
for (const control of ["worktree_add", "worktree_remove", "worktree_prune", "api.worktreeSummaries", "Open", "dirty", "conflict", "submodule_update", "submodule_sync", "submodule_init_path", "submodule_update_path", "stash_push", "stash_pop", "stash_apply", "stash_drop", "cleanUntracked", "savePatch", "applyPatch", "fsck", "maintenance", "lfs_locks", "lfs_pull", "lfs_prune", "bisect_start", "bisect_good", "bisect_bad", "bisect_reset"]) {
  must("src/components/WorkflowPanel.tsx", control, `workflow binds ${control}`);
}
for (const control of ["id: \"search\"", "id: \"compare\"", "id: \"review\"", "id: \"health\"", "id: \"file\"", "id: \"blame\"", "id: \"contributors\"", "id: \"stats\"", "id: \"pulls\"", "api.searchCommits", "api.compareRefs", "api.rangeDiff", "api.repositoryHealth", "RangeDiffList", "HealthPanel", "api.fileHistory", "api.lineHistory", "RevisionDiffView", "api.blameFile", "api.contributors", "api.commitActivity", "api.pullRequests", "api.remotes", "Refresh activity", "Load PRs", "Open review", "Review series", "Run object scan"]) {
  must("src/components/GitIntelligencePanel.tsx", control, `intelligence binds ${control}`);
}
for (const control of ["api.diffRevisions", "api.fileAtRevision", "Previous revision", "Next revision", "onSelectIndex"]) {
  must("src/components/RevisionDiffView.tsx", control, `revision viewer binds ${control}`);
}
for (const control of ["api.listTree", "api.fileAtRevision", "onExport", "jumpTo", "toggleDir"]) {
  must("src/components/RepoBrowser.tsx", control, `repo browser binds ${control}`);
}
for (const control of ["api.conflicts", "api.conflictDetail", "api.resolveConflict", "Reset working copy", "Save, stage & next", "Stage working copy & next"]) {
  must("src/components/ConflictCenter.tsx", control, `conflict center binds ${control}`);
}
for (const control of ["onDraftCommit", "Draft with local AI", "draftCommit", "CommitDraftOptions", "draftStyle", "issueReference", "Issue reference", "Conventional", "Plain", "Commit message quality", "Subject ≤ 72 characters", "Offline local draft"]) {
  must(control === "draftCommit" ? "src/api.ts" : "src/components/StatusPanel.tsx", control, `commit writer binds ${control}`);
}
for (const control of ["onStageHunks", "Stage hunks", "StageHunksPanel", "Select all", "Clear", "unstagedFileDiff", "stageHunks"]) {
  must(control === "unstagedFileDiff" || control === "stageHunks" ? "src/api.ts" : control === "StageHunksPanel" || control === "Select all" || control === "Clear" ? "src/components/StageHunksPanel.tsx" : "src/components/WorkingDiffView.tsx", control, `hunk staging binds ${control}`);
}
for (const control of ["api.prepareRebase", "api.startRebase", "changeAction", "move", "dropAt", "Start rebase", "Rewrite history"]) {
  must("src/components/RebasePlanner.tsx", control, `rebase planner binds ${control}`);
}
for (const control of ["clickWidgetButton", "runScript", "setThemeId", "setDockPreset", "toggleFeature", "setMarkdown"]) {
  must("src/components/CherryParityPanel.tsx", control, `workbench binds ${control}`);
}

for (const route of ["list_tags", "create_tag", "delete_tag", "merge_branch", "working_tree_diff", "unstaged_file_diff", "stage_hunks", "clean_untracked", "list_tree", "file_at_revision", "export_revision", "create_patch", "save_patch", "apply_patch", "commit_activity", "diff_revisions", "reference_groups", "create_branch_at", "reset_to_commit", "repository_remotes", "range_diff", "repository_health", "draft_commit_message"]) {
  must("server/index.ts", `${route}:`, `server exposes ${route}`);
}

console.log(`\n${checks} UI contract checks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;

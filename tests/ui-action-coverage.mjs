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

for (const route of ["undo_state", "undo_action", "redo_action", "last_commit_message", "discard_paths", "branch_action", "tag_action", "remote_action", "stash_files", "explorer_list", "explorer_action", "explorer_properties", "explorer_diff_files", "explorer_diff_previous", "explorer_patch", "explorer_open", "diff_commit_files", "commit_offset"]) {
  must("server/index.ts", `${route}:`, `server exposes ${route}`);
}
for (const control of ["onUndo", "onRedo", "onPull", "onPush", "onBranch", "onStash", "onPop", "onTerminal", "onExplorer"]) {
  must("src/components/gk/GkToolbar.tsx", control, `GitKraken toolbar binds ${control}`);
}
for (const control of ["LOCAL", "REMOTE", "WORKTREES", "STASHES", "TAGS", "SUBMODULES", "PULL REQUESTS", "onDrop", "merge_into_current", "rebase_current_onto", "fast_forward", "delete_remote"]) {
  must("src/components/gk/GkLeftPanel.tsx", control, `GitKraken left panel binds ${control}`);
}
for (const control of ["Stage all changes", "Unstage all changes", "Amend previous commit", "api.discard", "api.commit"]) {
  must("src/components/gk/GkWipPanel.tsx", control, `WIP panel binds ${control}`);
}
for (const control of ["Git Sync…", "Git Commit ->", "Diff with previous version", "Show log", "Show Reflog", "Check for modifications", "Blame", "Resolve…", "Revert…", "Clean up…", "Switch/Checkout…", "Merge…", "Create Branch…", "Create Tag…", "Export…", "Stash Save", "Stash Pop", "Add…", "Add to ignore list", "Delete (keep local)", "Rename…", "Revert to revision…", "Assume unchanged", "Skip worktree", "LFS", "Submodule Update…", "Create Patch…", "Apply Patch…", "Properties"]) {
  must("src/components/explorer/FileExplorer.tsx", control, `TortoiseGit menu has ${control}`);
}

for (const route of ["commit_signatures", "signing_config", "set_signing_config", "perf_status", "perf_apply", "search_advanced", "hooks_list", "hook_set_enabled", "commit_with_hooks", "autolinks_get", "autolinks_set", "commit_templates", "commit_templates_save", "fork_point", "predict_conflicts", "cleanup_candidates", "cleanup_branches", "archived_branches", "restore_archived", "stack_parents", "stack_set_parent", "stack_create", "stack_restack", "profiles_list", "profile_save", "profile_delete", "profile_apply", "profile_detach", "custom_commands", "custom_commands_save", "custom_command_run", "file_blob", "remote_host", "pr_template", "pr_create", "ci_checks", "ci_rerun", "agent_worktree_create", "agent_worktree_remove", "gitflow_config", "gitflow_init", "gitflow_start", "gitflow_finish", "ai_explain", "sparse_status", "sparse_action", "notes_get", "notes_set", "stream_read", "repo_treemap", "resolve_shell_paths", "file_diff_side", "apply_lines"]) {
  must("server/index.ts", `${route}:`, `server exposes ${route}`);
}
for (const tab of ["IdentityTab", "PerformanceTab", "HooksTab", "LinksTab", "TemplatesTab", "CommandsTab", "GitflowTab", "SparseTab", "ArchiveTab", "DisplayTab"]) {
  must("src/components/settings/RepoSettings.tsx", tab, `settings renders ${tab}`);
}
for (const control of ["SignatureBadge", "searchAdvanced", "forkPoint", "CommitExtras", "Linkified", "onRestoreFile"]) {
  must("src/components/CommitGraph.tsx", control, `graph binds ${control}`);
}
for (const control of ["commitWithHooks", "--no-verify", "applyTemplate", "Co-authored-by", "api.explain"]) {
  must("src/components/gk/GkWipPanel.tsx", control, `WIP panel binds ${control}`);
}
for (const control of ["predictConflicts", "createStackedBranch", "api.restack", "PullRequestDialog", "CleanupDialog", "gitflowStart", "gitflowFinish"]) {
  must("src/components/gk/GkLeftPanel.tsx", control, `left panel binds ${control}`);
}

for (const control of ["withLiveOutput", "LiveOutputHost"]) {
  must("src/App.tsx", control, `app binds ${control}`);
}
must("src/components/GitIntelligencePanel.tsx", "RepoTreemap", "intelligence renders the treemap");
for (const action of ["commit", "log", "diff", "diffprev", "blame", "revert", "add", "resolve", "cleanup", "modifications", "properties", "sync", "stash", "patch"]) {
  must("src/components/explorer/FileExplorer.tsx", `case "${action}":`, `shell action ${action} handled by the explorer`);
}
must("src/App.tsx", "shellAction", "app handles shell actions");
for (const control of ["Stage lines", "Unstage lines", "Discard lines", "Stage hunk", "Unstage hunk", "Discard hunk", "api.applyLines", "api.fileDiffSide"]) {
  must("src/components/gk/LineStagingDiff.tsx", control, `line staging binds ${control}`);
}
must("src/App.tsx", "LineStagingDiff", "WIP diff uses line staging");
must("electron/main.cjs", "argvToDeepLink", "desktop shell maps --tgit arguments");

console.log(`\n${checks} UI contract checks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;

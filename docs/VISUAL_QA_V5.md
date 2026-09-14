# GitAhead Next UI/UX v5 — Visual QA

## Reviewed states

Two 1440×900 desktop proxies were rendered from the v5 design language and inspected manually:

1. `visual/rebase-planner-workspace.png`
2. `visual/git-intelligence-workspace.png`

## Interactive rebase planner

The planner keeps the rewrite list and selected-commit inspector visible at the same time. Action, SHA/subject, author, change statistics, and order controls remain scannable without horizontal hunting. Drag reorder has explicit Up/Down alternatives for keyboard/pointer users. The footer separates plan status from the destructive Start Rebase action and now exposes **Update related branches** without making it the default.

The history-rewrite confirmation is intentionally stronger than a normal modal: it explains commit-ID changes, mentions related branch movement when enabled, supports Escape, traps Tab focus, and restores focus to the invoking control on cancellation.

## Git Intelligence workbench

Search is the default tab because it is the broadest entry point. Search syntax is visible directly below the input instead of hidden in documentation. Compare, File & line history, Blame, and Contributors are peer tools in a stable tab strip. Results use compact rows consistent with the History view rather than card-heavy dashboard styling.

The layout preserves an engineering-tool density: controls are grouped by task, large empty decorative regions are avoided, and status output remains persistent at the bottom. The clean-room label is low-emphasis and does not compete with repository state.

## Findings corrected during QA

- Fixed stale Git Intelligence state when switching repositories or current-branch context.
- Fixed generic completion text overwriting useful result counts.
- Hardened pinned-search local-storage parsing against malformed/non-array data.
- Added accessible Escape/Tab/focus behavior to the rebase confirmation.
- Added `--update-refs` visibility to the planner footer.
- Preserved the selected worktree/repository context model instead of adding GitLens-specific VS Code chrome.

## Remaining visual work

The largest remaining UI limitation is the simplified commit-lane renderer. A real DAG renderer plus branch focus/solo/hide should be implemented before adding more graph ornaments. A reusable diff surface is the other major missing workbench primitive.

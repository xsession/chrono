# Chrono Next UI/UX v5 — Implementation Notes

## Scope completed

### Interactive rebase

- Added `src-tauri/src/rebase_planner.rs`.
- Added plan models and Tauri commands.
- Resolves target, HEAD and merge base.
- Requires clean working tree and no existing repository operation.
- Refuses merge-containing replay ranges in this first slice.
- Loads author/date/diffstat metadata for each planned commit.
- Supports `pick`, `reword`, `edit`, `squash`, `fixup`, and `drop`.
- Reorder by HTML drag/drop or explicit Up/Down controls.
- Reword is executed non-interactively as a rebase `exec git commit --amend -m ...` step.
- Interactive todo is injected through a temporary `GIT_SEQUENCE_EDITOR` helper inside the Git directory.
- Rebase result hands off to the existing operation-state controller and Conflict Center.
- Added optional **Update related branches** (`--update-refs`) with Git-version capability detection and explicit preservation of update-ref positions in the custom todo.
- Rebase confirmation now traps keyboard focus, closes with Escape, restores focus on cancel, and explains when related refs will move.
- Plan rejects stale base, duplicate/missing commits, invalid first squash/fixup, empty reword messages, and all-drop plans.

### Git Intelligence clean-room wave

Added `src-tauri/src/insights.rs` and a new `GitIntelligencePanel`.

Implemented:

- rich commit search (`message:`, `author:`, `file:`, `change:`, `ref:`, `commit:`, `@me`);
- quoted token parser;
- common-base reference comparison;
- unique commits on both sides;
- file deltas from merge base to each side;
- file history with rename following and all-ref option;
- line-range history using `git log -L`;
- blame using machine-oriented `--line-porcelain`;
- ignore-whitespace blame option;
- contributors aggregation;
- structured worktree WIP summaries;
- batch history change statistics;
- on-demand commit details/file numstat.

### History workbench changes

- Added multi-worktree WIP strip.
- Added user-toggleable Changes column.
- Change statistics are loaded with one batch history command, not one process per commit.
- Selected commit inspector now loads real changed-file details rather than placeholder text.
- History directs advanced file/patch/range searches to Git Intelligence.

## Clean-room boundary

GitLens public documentation, release notes and product behavior were researched. No GitLens implementation code was copied. This is intentional because the GitLens repository mixes MIT-licensed source with separately licensed `plus` directories.

## Safety decisions

- No interactive rebase is allowed on a dirty working tree in this slice.
- Existing operation must be finished/aborted before planning another rebase.
- Merge-containing replay ranges are blocked instead of flattened.
- Submitted plan must contain exactly the commits from the latest prepared plan.
- Revision/range inputs that begin with `-` are rejected by intelligence endpoints.
- Git commands use argument arrays, not constructed shell command strings.
- The only shell-oriented content is Git's own rebase todo `exec` step for reword; messages are single-quote escaped.
- Worktree WIP actions are read-only in History. Destructive operations remain in the dedicated Worktree workflow and are still guarded.

## Known limitations

- Rust compiler/tooling is unavailable in the execution container, so `cargo check` and `rustfmt` could not be run here.
- Interactive rebase with preserved merge topology (`--rebase-merges`) is intentionally not implemented yet.
- Git Intelligence is desktop-only in this slice; Android functions return an explicit Unsupported error.
- Blame currently caps returned lines for UI performance; a future virtualized file viewer should page/stream very large files.
- Search pins are local UI state, not repository/workspace configuration.
- Git Intelligence resets repository-scoped results when the active repository/branch context changes, avoiding stale contributor/search/compare data.
- The current graph lane renderer is still simplified; v5 improves data density but does not yet implement a full DAG lane engine.
- No embedded diff viewer yet; comparison and commit details expose file-level statistics.

## Recommended next slice

1. reusable text/binary diff viewer;
2. true DAG lane renderer with branch focus/solo/hide;
3. revision previous/next navigation;
4. structured tags/remotes rail;
5. provider-aware autolinks and open-on-remote actions;
6. PR association/Launchpad-style triage using the existing provider normalization layer;
7. safe copy-patch-to-worktree workflow.

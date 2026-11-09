# Chrono next-feature research

This clean-room comparison was used to select the next Chrono implementation slice.

## Findings

### SourceGit

SourceGit's current feature list treats visual history, branch/revision diffs, interactive rebase, worktrees, stashes, submodules, blame, Git LFS, bisect, issue links, workspaces, custom actions, conventional commits, and AI commit writing as practical daily-driver features.

Source: <https://github.com/sourcegit-scm/sourcegit/blob/master/README.md>

### Git Cola

Git Cola exposes a compact workflow around DAG history, commit search, file finding, grep, stash, remote management, patch application, and an interactive rebase sequence editor.

Source: <https://github.com/git-cola/git-cola/blob/main/README.md>

### GitKraken

GitKraken's current product surface emphasizes readable commit graphs, file history and blame, worktree-isolated parallel sessions, conflict prevention, AI commit composition, and pull-request triage.

Source: <https://gitkraken.com/git-client>

### Native Git capability

`git range-diff` directly compares two versions of a patch series and is especially valuable after rebasing, amending, or incorporating review feedback.

Source: <https://git-scm.com/docs/git-range-diff/2.48.0>

## Chrono implementation decision

Chrono already contains the graph/history, ref visibility, context actions, bounded paging, local AI commit writing, file history, blame, branch comparison, worktrees, stashes, submodules, recovery, and PR triage foundations. The highest-value uncovered workflow was therefore selected as:

1. **Range review** — compare a common base with the before/after versions of a branch and show preserved, changed, added, or removed patches.
2. **Repository health** — show working-tree conflicts, worktree state, submodules, object packing, reflog recovery points, maintenance configuration, Git LFS availability, and an optional full `git fsck` scan.

Both additions are read-only by default. The object scan is explicit because it can be expensive on large repositories.

## Follow-up implementation slice

The next high-value gaps were implemented after the initial range-review and
health pass:

3. **Commit conventions and issue references** — the local commit composer now
   supports explicit Conventional Commit or plain imperative style and accepts
   only bounded `#123` or `PROJECT-123` references, adding them as a `Refs:`
   body trailer without sending data to a hosted service.
4. **Worktree session monitoring** — the Worktrees view now uses the structured
   worktree summaries endpoint to show dirty-file and conflict counts per
   linked checkout and can open a selected checkout directly.
5. **Granular staging** — the Changes diff can load the unstaged index diff,
   select individual text hunks, and stage only those hunks through a generated
   Git patch; binary files remain file-level operations.
6. **Commit quality feedback** — the commit editor shows live subject-length,
   Conventional Commit, and issue-reference checks without blocking a manual
   commit.
7. **Large-history viewport** — the bounded history window now keeps its full
   DAG layout and graph paging semantics while virtualizing the mounted row
   slice with overscan. This reduces DOM pressure for repositories with
   thousands of visible commits without hiding the graph's branch context.

The monitor is read-only; create/remove/prune actions retain their existing
confirmation and operation-lock safeguards.

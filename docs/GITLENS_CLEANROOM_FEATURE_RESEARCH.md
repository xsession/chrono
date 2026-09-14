# Chrono Next — GitLens Functionality Deep Research and Clean-Room Feature Plan

## Executive summary

GitLens has evolved beyond an annotation extension into a Git workbench. The most important product lesson for Chrono Next is not any individual VS Code command; it is the consolidation of repository context into one place. GitLens 19 places the Commit Graph at the center of the experience, mixes current working state with history, makes worktrees visible as parallel contexts, and opens comparisons/details in-place rather than forcing users through a sequence of disconnected dialogs.[1][2]

That direction aligns well with Chrono Next, but the implementation should remain a native desktop Git client rather than imitate VS Code. The highest-value transferable capabilities are therefore repository-centric: rich commit search, merge-base-aware branch comparison, real commit diff statistics, multi-worktree WIP visibility, file and line history, blame, contributors, revision inspection, guided interactive rebase, and provider-neutral autolink/remote actions. These are useful offline and can be built directly on Git data.

The v5 implementation delivers the first major wave:

- interactive rebase planner with Pick, Reword, Edit, Squash, Fixup, Drop and reordering;
- merge-topology safety checks and explicit history-rewrite confirmation;
- rich search prefixes: `message:`, `author:`, `file:`, `change:`, `ref:`, `commit:` and `@me`;
- Search & Compare with common-base analysis, unique commits and file deltas;
- file history with rename following and optional all-ref scope;
- line-range history using Git's `-L` history traversal;
- full-file blame with author, commit, date, message and optional whitespace ignoring;
- contributor activity aggregation;
- change statistics in the history graph;
- real commit file-change details in the inspector;
- working-change summaries across linked worktrees in the History workbench.

The implementation is clean-room. Feature behavior and interaction patterns were studied from GitLens public documentation and release notes. GitLens source code was not copied. This matters because the repository contains both MIT-licensed source and a separately licensed `plus` tree; Chrono Next should not create an accidental dependency on proprietary implementation details.[3]

## 1. Current GitLens product direction

### 1.1 Commit Graph as the home/workbench

GitLens 19.0, released August 12, 2026, rebuilt the Commit Graph and made it the leading GitLens view. The release emphasizes large-repository performance, complete keyboard navigation, richer row state, branch/tag detail sheets, reference search, lane folding, a changes column, and visibility of work in progress.[2]

The current product documentation describes the Graph as the place where branch, HEAD, upstream, merge target, incoming/outgoing work, working changes across worktrees, branches, commits and agent activity can be understood together.[4] This is a stronger design than a classic Git client's pattern of separate History, Status, Branch Manager and Worktree dialogs with no shared context.

**Chrono implication:** History should be a workbench, not a read-only log. The graph/list should surface current WIP, change magnitude, worktree context and a details inspector. Specialized screens remain appropriate for complex tasks, but they should link back into the same repository context.

### 1.2 Work-in-progress rows and multi-worktree awareness

GitLens 18 introduced secondary-worktree WIP rows and an integrated details panel. GitLens 18.3 added more precise worktree and WIP actions, per-file added/removed counts and cleaner WIP navigation. GitLens 19.1 expanded live agent/worktree integration and lets users start tasks in worktrees without switching the main window.[1][5]

The generalizable idea is independent of coding agents: a worktree is not just an administrative Git record. It is an active development context with branch, HEAD, dirty/conflict state and potentially pending work.

**Chrono implication:** show dirty secondary worktrees near history, and enrich the Worktrees screen with status before enabling destructive removal. The v5 History view now exposes WIP cards for any linked worktree that has uncommitted changes or conflicts.

### 1.3 Rich history search

GitLens exposes commit search by message, author, file and code/patch changes. Current documentation also describes reference/range search, `@me`, SHA matching and more advanced graph filters.[6][7]

The important UX quality is that search is expressed in Git concepts rather than forcing separate forms for every query type. A developer can narrow history with a compact grammar and still use guided hints.

**Chrono implication:** provide a query grammar but keep it understandable and deterministic. The v5 parser supports:

| Prefix | Meaning | Git basis |
|---|---|---|
| `message:` | commit message text | `git log --grep` |
| `author:` | author identity | `git log --author` |
| `file:` | repository path/pathspec | `git log -- <path>` |
| `change:` | patch content regex | `git log -G` |
| `ref:` | branch/tag/range scope | log revision argument |
| `commit:` | exact revision/SHA | `--no-walk` |
| `@me` | configured user identity | `user.name` / `user.email` |

Unlike terminal command construction, all arguments are passed as process arguments rather than interpolated into a shell command.

### 1.4 Search & Compare

GitLens' Search & Compare view can persist searches and comparisons. Comparisons expose commits unique to each side and changed files, and GitLens has specific common-base comparison actions intended to show what a branch would contribute when merged.[7][8]

**Chrono implication:** branch comparison should be based on graph topology rather than only a two-tip diff. The v5 comparison endpoint computes:

- resolved left/right commits;
- merge base;
- left-only and right-only commit counts;
- bounded lists of unique commits;
- file deltas from the common base to each side.

This supports both "what do I have that main does not?" and "what would this branch introduce?" without conflating those questions.

### 1.5 File history, line history and revision navigation

GitLens File History supports rename following, all-branch scope and line-history switching. Line History tracks a selected line range. Revision navigation can move between file revisions and compare a revision with previous/next/working versions.[6][9]

**Chrono implication:** file evolution should be available even though Chrono is not a source-code editor. The first implementation provides file history and `git log -L` line-range history in Git Intelligence. A later revision viewer should add previous/next navigation and a proper two-revision diff viewer.

### 1.6 Blame and authorship

Blame remains one of GitLens' core differentiators. It presents commit, author and age at line level, optionally with a heatmap, and its CodeLens layer summarizes recent change and authorship at file/block level.[6]

**Chrono implication:** do not fake editor decorations in a standalone Git client. Instead, expose blame as a high-density table with line number, commit, author, time, summary and source line. The v5 blame API uses `git blame --line-porcelain`, which is stable machine-oriented output, and supports whitespace-ignore mode.

A future Chrono file viewer can reuse this API to add gutter authorship or an age heatmap without coupling the Git backend to a particular editor widget.

### 1.7 Contributors as navigation, not vanity metrics

GitLens maintains a Contributors view. The useful part is not merely a commit leaderboard; contributors help answer "who knows this history?" and act as author filters for history searches.[9]

**Chrono implication:** contributor data should be actionable. v5 aggregates name, email, commit count, first observed commit and most recent activity. Future integration should let clicking a contributor open `author:` search and filter file-history ownership.

### 1.8 Interactive rebase

GitLens includes an Interactive Rebase Editor with reorder, edit, squash and drop, and newer releases integrate conflicted files directly into the rebase workflow.[6][10] GitKraken Desktop similarly treats interactive rebase as a visual history-shaping operation with restrictions around merge topology.[11]

Chrono Next already had persistent operation state and the v4 Conflict Center. The natural next step was therefore not another generic workflow command, but a plan editor that hands conflicts into the existing resolver.

The v5 planner uses a native Git interactive-rebase session. It builds and validates a todo plan, injects it through a temporary `GIT_SEQUENCE_EDITOR`, and lets Git remain the state machine. This preserves standard `git rebase --continue`, `--skip` and `--abort` semantics, so the existing v3 operation controller and v4 Conflict Center work without a second custom rebase engine.

### 1.9 Changes column and lazy cost

GitLens 19 added a Changes column with several visualizations and deliberately made it optional because computing history statistics can be expensive on large repositories.[2]

**Chrono implication:** compute stats in a batch and make the column user-toggleable. v5 adds a single `git log --numstat` batch endpoint for loaded history rather than issuing one Git process per visible commit. The preference is stored locally and can be disabled.

### 1.10 Keyboard-first operation

GitLens 19 specifically emphasizes keyboard navigability in the graph. Search result navigation, reference jump and row actions are first-class keyboard workflows.[2][6]

**Chrono implication:** every mouse affordance needs a non-drag alternative. The rebase planner supports drag reorder but also provides explicit Up/Down buttons, which are more discoverable and usable with keyboard/assistive technology.

## 2. Clean-room feature matrix

| GitLens capability | Value to Chrono | v5 status | Notes |
|---|---:|---|---|
| Commit Graph workbench | Very high | **Expanded** | WIP cards, changes column, real commit details |
| Rich commit search | Very high | **Implemented** | Offline, provider-neutral |
| Search & Compare | Very high | **Implemented** | Merge-base-aware |
| File history | High | **Implemented** | Follow renames/all refs |
| Line history | High | **Implemented** | Git `-L` range history |
| File blame | High | **Implemented** | Standalone table, not editor overlay |
| Contributors | Medium-high | **Implemented** | Activity + counts |
| Interactive rebase | Very high | **Implemented** | Integrates existing conflict workflow; optional `--update-refs` |
| Multi-worktree WIP | Very high | **Implemented first slice** | Dirty/conflict cards in History |
| Changes/diffstat column | High | **Implemented** | Batch load + toggle |
| Commit details file list | High | **Implemented** | On-demand |
| Pinned searches | Medium | **Implemented locally** | Stored in browser local storage |
| Branch focus/solo/hide | High | Planned | Best next graph-density feature |
| Tags/remotes side graph rail | Medium-high | Planned | Needs structured refs API |
| Revision prev/next diff | High | Planned | Needs file revision viewer |
| Autolinks | Medium-high | Planned | Provider/custom patterns |
| Remote URL actions | High | Planned | GitHub/GitLab/Gitea/Forgejo already fit project direction |
| PR Launchpad | Medium-high | Partial foundation | Existing normalized PR API; needs triage UI |
| WIP copy patch / move to worktree | High | Planned | Requires patch generation/apply safety layer |
| Co-author picker | Medium | Planned | Contributor data now provides source |
| Multi-diff review | High | Planned | Needs reusable diff viewer |
| File heatmap/visual history | Medium | Planned | Useful, but after textual history tools |
| AI compose/review/conflict resolution | Optional | Deferred | External model/service concern; core app should work fully offline |
| Agent session tracking | Optional | Deferred | Separate integration architecture, not core Git semantics |
| Cloud patches/workspaces | Optional | Deferred | Server/service feature, conflicts with offline-first default |

## 3. Interactive rebase architecture

### 3.1 Plan preparation

The backend resolves the requested target, current HEAD and merge base. The replay range is the commits from merge base to HEAD. Merge commits are detected separately.

The first planner intentionally blocks histories containing merge commits. Git can preserve merges with `--rebase-merges`, but exposing that safely requires representing labels, reset points and merge todo instructions. Silently flattening merge topology would be an unacceptable UX default.

Each plan row contains:

- commit SHA;
- subject;
- author identity;
- timestamp;
- added/deleted line counts;
- file count.

### 3.2 Supported actions

- **Pick** — replay unchanged.
- **Reword** — replay, then amend the message through a non-interactive `exec` instruction.
- **Edit** — pause after replay so the user can amend manually.
- **Squash** — combine with the previous surviving commit, keeping combined message material.
- **Fixup** — combine with the previous surviving commit while discarding this commit's message.
- **Drop** — omit the commit.

The plan validates that Squash/Fixup cannot occur before a surviving commit, Reword has a message, every original commit appears exactly once, and the plan does not drop every commit.

Chrono also exposes Git's `--update-refs` behavior when the installed Git is new enough. Because Chrono supplies its own reordered todo, it explicitly preserves the relationship between each original commit and any local branch refs that Git would update, while excluding branches checked out in another worktree. This matters when commits are reordered, reworded, squashed, fixed up, or dropped.

### 3.3 Execution and recovery

Chrono writes a temporary rebase todo and a tiny sequence-editor helper in the repository Git directory, starts `git rebase --interactive --onto <target> <base>`, then removes the helper files once Git has consumed them.

If Git pauses, on-disk Git state remains authoritative. The existing operation-state controller detects the rebase, the operation banner appears, and conflicts flow directly into Conflict Center. This avoids duplicated app-level rebase state.

Current GitLens 19 follows the same broad safety direction: paused merge/rebase/cherry-pick/revert states are surfaced in one place, and its rebase confirmation exposes an Update Branches toggle backed by `--update-refs`.[1] Chrono adopts the Git behavior without copying GitLens implementation code.

## 4. Git Intelligence backend design

### 4.1 Process isolation and safety

All Git operations are executed as an argument array with `git -C <path> ...`. User query text is never concatenated into a shell command. Revision strings beginning with `-` are rejected for endpoints that treat input as a revision to avoid option confusion.

The one deliberate shell-facing path is Git's own interactive-rebase todo `exec` action for Reword. Commit messages are single-quote escaped before being placed in that todo line. Real Git smoke tests include Reword execution.

### 4.2 Performance rules

The research highlights an important failure mode in feature-rich Git clients: background Git work can saturate repositories with many worktrees or large histories.[5] Chrono should adopt explicit cost classes:

- **cheap / refresh path** — status, summary, branch refs;
- **visible-lazy** — selected commit details, blame, file history;
- **batch optional** — history change statistics;
- **explicit expensive** — all-ref search, contributors, fsck.

v5 follows this model. Worktree WIP summaries load in the History view because they are visible; contributor scans happen only when the Contributors tab is opened; diffstats can be disabled.

## 5. UX recommendations for the next iteration

### P0 — finish workbench integration

1. **Branch focus / solo / hide.** Large histories need a way to reduce reference noise. GitLens' Solo/Hide and focused graph scope are strong patterns.[10]
2. **Graph-quality DAG.** Chrono's current history lane is still intentionally minimal. A true parent-lane renderer should precede more graph ornaments.
3. **Reusable diff viewer.** Search, comparison, file history, commit details and PR review all need one efficient text/binary diff surface.
4. **Revision navigation.** Previous/next revision controls become straightforward once the diff viewer exists.

### P1 — provider-aware context

1. **Remote URL model** for GitHub, GitLab, Gitea, Forgejo, Bitbucket and Azure DevOps.
2. **Autolink rules** for issue IDs in commit messages. GitLens supports both provider integration and custom pattern rules.[12]
3. **PR association** in branch/commit details using Chrono's existing normalized pull-request API.
4. **Launchpad-style triage** only after provider authentication/settings are robust.

### P1 — worktree precision

1. dirty/conflict status in Worktrees manager (backend now exposes this);
2. open terminal/reveal folder actions;
3. safe removal with dirty/locked/main-worktree guardrails;
4. copy selected working changes as patch to another worktree;
5. per-worktree commit-message drafts.

GitLens' recent release notes are particularly useful here because they document subtle bugs when an action is invoked from one worktree but accidentally runs against another.[5] Chrono should require every worktree action to carry an explicit worktree path to the backend.

### P2 — visual analytics

Visual History, churn maps and heatmaps are valuable for discovery but lower priority than accurate history/compare/blame flows. When added, they should be derived from the same backend data rather than maintain a second history engine.

## 6. Features intentionally not cloned

### AI as a required workflow

GitLens increasingly includes AI compose, review, explanation and conflict resolution. These can be useful, but Chrono Next is explicitly positioned as an offline-capable standalone client. Core operations must not require an account or hosted AI service. Any future AI layer should consume exported Git/diff context through a plugin interface and remain optional.

### Agent session UI in the core navigation

GitLens 19.1 shows Codex, Copilot CLI, OpenCode and Claude Code sessions in graph/worktree context.[1] That makes sense in an IDE extension. For Chrono, agent session tracking should be an optional integration because the application cannot assume which agent/runtime owns a worktree.

### Cloud-only patch/workspace state

Cloud Patches and Cloud Workspaces solve collaboration problems, but they would introduce account/server semantics into an otherwise local Git data model. A provider-neutral patch export/import feature is a better first step.

## 7. Validation requirements

The new functionality should be considered production-ready only when all of the following pass on Linux, Windows and macOS:

- TypeScript typecheck and production Vite build;
- Rust `cargo check` and `cargo test`;
- rebase-plan test for Pick/Reword/Edit/Squash/Fixup/Drop;
- rebase conflict → Conflict Center → Continue;
- malformed/outdated plan rejection;
- search qualifiers and quoted values;
- rename-follow file history;
- line history on moved/edited ranges;
- blame on text, binary rejection behavior and large-file limits;
- worktree status with spaces/unicode paths, detached HEAD, locked and prunable worktrees;
- comparison when refs are equal, diverged, unrelated or deleted;
- performance test on at least a 100k-commit repository and 20+ linked worktrees.

The current container lacks Rust tooling, so v5 includes real Git smoke tests and TypeScript semantic checks but still requires `cargo check` on a development machine.

## 8. Sources

1. GitKraken, **GitLens Release Notes — Version 19.1 / 19.0**, September/August 2026. https://help.gitkraken.com/gitlens/gitlens-release-notes-current/
2. GitKraken, **GitLens Release Notes — Version 19.0 Commit Graph redesign**, August 12, 2026. https://help.gitkraken.com/gitlens/gitlens-release-notes-current/
3. GitKraken, **vscode-gitlens LICENSE** — MIT outside directories named `plus`; separate license for `plus`. https://github.com/gitkraken/vscode-gitlens/blob/main/LICENSE
4. GitKraken, **Commit Graph is Home**, updated August 2026. https://help.gitkraken.com/gitlens/home-view/
5. GitKraken, **GitLens current release notes — worktree/WIP improvements and performance fixes**, 2026. https://help.gitkraken.com/gitlens/gitlens-release-notes-current/
6. GitKraken, **GitLens Core Features** — revision navigation, blame, CodeLens, rich search, interactive rebase. https://help.gitkraken.com/gitlens/gitlens-features/
7. GitKraken, **GitLens Side Bar Views** — Search & Compare, File History, Line History, branches, contributors. https://help.gitkraken.com/gitlens/side-bar/
8. GitKraken, **GitLens older release notes — Compare with Common Base**, GitLens 14.9. https://help.gitkraken.com/gitlens/gl-test/
9. GitKraken, **GitLens Side Bar — File History, Line History and Contributors**, 2026 documentation. https://help.gitkraken.com/gitlens/side-bar/
10. GitKraken, **GitLens Release Notes — Version 17.12**, April 15, 2026: graph sidebar, interactive rebase conflicted-files panel and search enhancements. https://help.gitkraken.com/gitlens/gl-release-v17-x/
11. GitKraken, **GitKraken Desktop Interactive Rebase**, updated March 2026. https://help.gitkraken.com/gitkraken-desktop/interactive-rebase/
12. GitKraken, **GitLens Integrations / Autolinks**, provider capabilities and custom remote context. https://help.gitkraken.com/gitlens/gl-integrations/
13. GitKraken, **GitLens README**, current product scope including graph, worktrees, file/line history and search. https://github.com/gitkraken/vscode-gitlens/blob/main/README.md

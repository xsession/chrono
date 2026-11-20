# Fork, Tower, Sublime Merge, SmartGit: Distinctive Features (as of Nov 2026)

## Tower (git-tower.com): Undo, drag and drop, stacked branches, workflows, AI, merge detection

### Takeaway
From 2023 to 2026 Tower built a branch-relationship layer on top of Git: branch parents and dependencies, stacked branches with restack, Graphite integration, custom workflows (git-flow, GitHub/GitLab Flow, git-flow-next), fork-point display, merged/stale branch detection with archiving, and PR-based merge detection. It also has global Cmd/Ctrl+Z undo, AI commit messages (Claude Code/Codex), commit templates, full worktree support, and a rewritten CLI for reviewing AI agents' work. It runs on macOS and Windows only; there is no Linux build.

### Cited Findings
**Platforms**
- Tower is offered for macOS and Windows (x64 and ARM). No Linux build is mentioned — [Tower Undo page](https://www.git-tower.com/features/undo); [Tower features](https://www.git-tower.com/features)

**Undo (Cmd+Z / Ctrl+Z)**
- Cmd+Z (Mac) or Ctrl+Z (Win) undoes an action; Shift+Cmd/Ctrl+Z redoes it. Undo covers deleting a file, staging/unstaging, discarding a chunk or file, and committing (undoing a commit returns its changes to the working copy). It also covers creating, checking out, and deleting branches; merges and rebases, including interactive rebase; publishing a branch; and saving, deleting, or applying a stash — [Tower Undo](https://www.git-tower.com/features/undo)
- The features page sums it up as "Undo anything": restore old revisions, revert commits, recover deleted commits, undo branch deletions, "Just press Cmd+Z" — [Tower features](https://www.git-tower.com/features)

**Drag and drop**
- Many advanced Git operations are done by dragging items in the UI — [Tower features](https://www.git-tower.com/features)
- 12.5.1 (Feb 20 2025): drag a branch onto "Worktrees" to create a worktree. Drag-and-drop action badges show what a drop will do — [Tower 12 release notes](https://www.git-tower.com/release-notes?os=mac&version=12)
- 16.0 (May 5 2026): drag files from the Working Copy onto a stash entry to make a partial stash, including untracked files — [Tower 16 release notes](https://www.git-tower.com/release-notes?os=mac&version=16)

**Branch dependencies, stacked branches, restack (Tower 12, Sep 4 2024)**
- Tower 12 added Branch Dependencies and Stacked Branches. Restacking is done via rebase. Tower calls this "the beginning of our ambitious Tower Workflows project." 12.0 also added a new launch window — [Tower 12 release notes](https://www.git-tower.com/release-notes?os=mac&version=12)
- 12.5 (Feb 5 2025): full Git worktree support and a "Pin Branch" option in Create Branch — [Tower 12 release notes](https://www.git-tower.com/release-notes?os=mac&version=12)

**Graphite and stacked PRs (Tower 13, Jun 24 2025)**
- A Graphite workflow can be selected from the "Workflow" toolbar button. It gives quick access to Graphite commands and opens the Graphite dashboard. Right-click any branch to create a stacked branch, then rename, merge, squash, or delete it from the same menu — [Tower 13 release notes](https://www.git-tower.com/release-notes?os=mac&version=13)
- 13.0 also made commit loading faster when signature verification is on and disabled automatic GPG key fetching. Tower verifies commit signatures but shows no dedicated signing UI in these notes — [Tower 13 release notes](https://www.git-tower.com/release-notes?os=mac&version=13)

**Custom Workflows (Tower 14, Aug 19 2025)**
- You define a branching strategy with parent-child branch relationships, automated updates, and merge settings. A Workflow dialog offers presets (git-flow, GitHub/GitLab Flow) or a workflow built from scratch. The configuration screen sets trunk, base, and topic branches plus upstream and downstream merge strategies. Stacked Branches work with any custom workflow. Git Flow is enabled automatically when a configuration is detected (14.1). A warning badge appears when a workflow is missing configuration (14.2). 14.5 (Sep 18 2025) added git-flow-next — [Tower 14 release notes](https://www.git-tower.com/release-notes?os=mac&version=14)

**Automatic branch management and fork point (Tower 15, Nov 25 2025)**
- A footer notification count opens a dialog where you can multi-select branches to archive, or let Tower auto-archive fully merged and stale branches. Archived branches go to an "Archived Branches" sidebar section. Sidebar badges mark branches as "Merged" or "Stale" (with last-update time) — [Tower 15 release notes](https://www.git-tower.com/release-notes?os=mac&version=15)
- Fork Point in History: Tower marks the commit where a branch diverged from its parent and grays out earlier commits, so the branch's own commits stand out — [Tower 15 release notes](https://www.git-tower.com/release-notes?os=mac&version=15)

**AI commit messages (Tower 16, May 5 2026)**
- Stage changes, then click "Generate" in the Working Copy. A commit-area dropdown chooses a writing-style preset, and you can add custom prompts. The provider is Claude Code or Codex, chosen in a new "AI" settings tab. 16.0 also added a toggle to keep the commit body always visible — [Tower 16 release notes](https://www.git-tower.com/release-notes?os=mac&version=16)

**Merged PR detection (Tower 17, Jul 16 2026)**
- Tower matches local branches to merged PRs on GitHub, GitLab, and other hosts, including squash and rebase merges. A redesigned "Fully Merged" hint shows which checks matched and links to the merge commit or PR. Extra checks include git's own merge detection, merge-commit analysis, and deleted remote-tracking branches. Branch cleanup hints can archive branches — [Tower 17 release notes](https://www.git-tower.com/release-notes?os=mac&version=17)
- 17.1 (Jul 29 2026): these features moved from "Preview" into Tower Pro: Graphite, Stacked Branches, Advanced Custom Workflows, Automatic Branch Management, PR merge detection, and self-hosted service accounts — [Tower 17 release notes](https://www.git-tower.com/release-notes?os=mac&version=17)

**CLI and AI-agent review (Tower 18, Oct 6 2026)**
- The `gittower` CLI was rewritten. It opens History for a branch, tag, or file, jumps to a commit, and opens Blame, Stashes, PRs, and a filtered Branches Review. `gittower working-copy` / `gittower status` opens a diff of uncommitted changes, positioned for reviewing AI agent work. `gittower branch` reads or sets a branch's parent and stacking status. The CLI is installed as a link, so it updates with the app. Blame now follows HEAD by default — [Tower release notes (Mac, v18)](https://www.git-tower.com/release-notes/mac)
- Tower 18.5 for Mac (beta) adds Gitea, Forgejo, and Codeberg support. Tower 15 for Windows adds syntax highlighting — [Tower features](https://www.git-tower.com/features); [Tower 17 notes page banner](https://www.git-tower.com/release-notes?os=mac&version=17)

**Earlier 2023–2024 items**
- Tower 10 (Jun 28 2023): syntax coloring for nearly 200 languages in diff and raw views, a Text settings dialog (tab width, invisibles), customizable themes, and a "What's New" window — [Tower 10 release notes](https://www.git-tower.com/release-notes?os=mac&version=10)
- Tower 11 (May 7 2024): Commit Templates, managed in a Settings "Templates" tab. Typing `t:` at the start of the subject opens the template picker — [Tower 11 release notes](https://www.git-tower.com/release-notes?os=mac&version=11)
- 12.6 (Apr 2025): VS Code as diff/merge tool, plus Ghostty and Prompt terminal integration. 12.2 added bundled ksdiff (Kaleidoscope). 13.1 and 12.4 added WezTerm and Warp terminal integration — [Tower 12](https://www.git-tower.com/release-notes?os=mac&version=12); [Tower 13](https://www.git-tower.com/release-notes?os=mac&version=13)
- Visual merge conflict solving, unsynced-commit visibility, and built-in authentication handling (no manual SSH keys or tokens) — [Tower features](https://www.git-tower.com/features)

### Inferences
- Tower's main differentiator against a GitKraken-like client is a persistent branch parent/child model. It drives restack, the fork-point graying in History, workflow start/finish, merged/stale detection, and auto-archiving. A client lacking this has no notion of which branch a branch belongs to.
- Undo is broad: staging, discard, commit, branch operations, rebase, and stash, all on one Cmd/Ctrl+Z stack with redo.
- In 2026 Tower is positioning around AI agents: AI commit messages with Claude Code/Codex as provider, and a CLI command that opens a working-copy review of agent changes.

### Gaps
- I found no official source for a feature named "Quick Actions" in Tower 10–18 notes, nor for "snapshots" as a feature. The Undo page lists restore and revert capabilities but no snapshot mechanism.
- Details of the Merge Conflict Wizard UI, PR management UI (create, review, merge in-app), file history, and commit-signing settings were not covered on the fetched pages.
- The Windows release cadence and feature parity were not verified beyond "Tower 15 for Windows adds syntax highlighting."

## Fork (git-fork.com): interactive rebase, repository manager, custom commands, worktrees, AI review

### Takeaway
Fork is a fast, native Mac/Windows client ($59.99) with a visual interactive rebase, an image diff (swipe, onion-skin, exact pixel diff), a built-in merge resolver, blame and file history, git-flow, LFS (including locks), and GPG signing. From 2023 to 2026 it added Workspaces (nested, per-window), UI custom commands with dialogs, full worktree management, Repository Treemap and Benchmark, drag-and-drop reorder/squash, conflict prediction for rebase, cherry-pick, and revert, `--update-refs`, range File History, vertical tabs, and Claude/Codex/Cursor AI code review and commit messages. There is no Linux build.

### Cited Findings
**Platforms and price**
- macOS 10.11+ and Windows 7+, priced $59.99 with a free evaluation — [Fork homepage](https://git-fork.com/)

**Core features (homepage)**
- Interactive rebase with a visual interface for editing, reordering, and squashing. A conflict helper plus built-in merge resolver. Side-by-side image diffs, an advanced diff viewer, file/directory History, and Blame. A Repository Manager showing summary and statistics. Line-by-line staging, recent commit messages, a file tree browser at any commit, reflog recovery, and stashes shown in the commit list. Git-flow, Git LFS, GPG signing of commits and tags, and GitHub notifications — [Fork homepage](https://git-fork.com/)

**Mac changelog 2023–2026**
- 2.25 (Jan 2023): Repository Benchmark. 2.26 (Feb 2023): Workspaces for organizing many repos, a timeline in file history, and BBDiff integration. 2.27: swipe and onion-skin views for LFS images, nested workspaces, and workspaces in Quick Launch — [Fork Mac release notes](https://git-fork.com/releasenotes)
- 2.28/2.29 (Apr–May 2023): new custom-command variable syntax. UI custom commands open simple dialogs with text fields, branch dropdowns, and file selectors. 2.51 added checkboxes. 2.46 (Sep 2024) made custom commands available in the History window — [Fork Mac release notes](https://git-fork.com/releasenotes)
- Worktrees: shown in the sidebar (2.31, Jul 2023), nested (2.32), created and deleted (2.41, Mar 2024). A Create Worktree dialog and an option to remove a branch's worktree on delete (2.63, Feb 2026). Check out a remote branch as a worktree (2.68). Worktrees share repo settings and issue tracker rules (2.71) — [Fork Mac release notes](https://git-fork.com/releasenotes)
- Quick Launch: pinned branches (2.31) and workspaces (2.27) — [Fork Mac release notes](https://git-fork.com/releasenotes)
- LFS: unlock multiple files and filter the LFS Locks dialog (2.34). An LFS status dialog and total progress for multi-file push (2.37) — [Fork Mac release notes](https://git-fork.com/releasenotes)
- Image diff: exact pixel diff (2.42, Apr 2024), WebP (2.45), TGA and SVG (2.51) — [Fork Mac release notes](https://git-fork.com/releasenotes)
- Activity Manager sections keep automatic fetches out of the log (2.48) — [Fork Mac release notes](https://git-fork.com/releasenotes)
- Repository Treemap visualizes repository activity over time (2.52, Apr 2025) — [Fork Mac release notes](https://git-fork.com/releasenotes)
- Merger scrollbar shows conflict markers (2.53). Diffs are shown for conflicted files resolved in external mergers (2.58) — [Fork Mac release notes](https://git-fork.com/releasenotes)
- Drag-and-drop reorder and squash of commits in the active branch, and a rebase dialog warning for likely conflicts (2.55, Aug 2025). A check for whether a cherry-pick or revert will conflict (2.66, Apr 2026) — [Fork Mac release notes](https://git-fork.com/releasenotes)
- Bisect: skip option (2.50), color-coded good and bad commits (2.56), UI improvements (2.67) — [Fork Mac release notes](https://git-fork.com/releasenotes)
- AI: File History for a selected code range plus Claude-powered branch review and commit messages (2.59, Nov 2025). Claude Code Review for branches (2.60). AI review of commit ranges (2.61). Editable default agent requests and Codex support (2.64). Cursor as an AI agent (2.70, Sep 2026) — [Fork Mac release notes](https://git-fork.com/releasenotes)
- 2.61/2.63 (2026): `--update-refs` in the rebase dialog and in Interactive Rebase (keeps stacked branches in sync), and avatars in interactive rebase. 2.62: ahead/behind counts on Pull/Push toolbar buttons — [Fork Mac release notes](https://git-fork.com/releasenotes)
- 2.64: apply a patch from the clipboard. 2.65: .gitignore template picker. 2.66: collapsible commit details. 2.67: commit details popup and a restore-closed-tab shortcut. 2.68: tab rename, color, and terminal. 2.69: stash "Save as Patch". 2.70: vertical tabs. 2.71: per-window workspaces. 2.72 (Nov 20 2026): filterable branch dropdowns — [Fork Mac release notes](https://git-fork.com/releasenotes)

**Windows changelog notes**
- 1.82 (Feb 2023): 64-bit app and history timeline. 2.1 (Sep 2024): syntax highlighting. 2.8 (May 2025): Repository Treemap. 2.14 (Nov 2025): Claude Code integration, which needs `claude.exe` at `%userprofile%\.local\bin`. 2.17: Create Worktree from Quick Launch. 2.20: Spacebar commit details popup. 2.22 (Aug 2026): vertical tabs. 2.23: view settings stored per worktree — [Fork Windows release notes](https://git-fork.com/releasenoteswin)
- The Statistics view dates from 2020 (Windows 1.53). It has no 2023–2026 changelog entries — [Fork Windows release notes](https://git-fork.com/releasenoteswin)
- No new git-flow features appear in the 2023–2026 Mac entries — [Fork Mac release notes](https://git-fork.com/releasenotes)

### Inferences
- Fork's distinctive ideas are: UI custom commands (user scripts with generated parameter dialogs, available in the sidebar and History); conflict prediction before rebase, cherry-pick, or revert; Repository Treemap and Benchmark; range-based file history; Workspaces as named repo groups in Quick Launch; and multi-agent AI review (Claude, Codex, Cursor) that calls the locally installed CLI agent rather than a hosted model.
- Fork's reputation for speed is not documented in changelogs. Treat "performance reputation" as community perception unless separately sourced.

### Gaps
- Fork has no official performance benchmark versus competitors. The "Repository Benchmark" feature measures a user's own repository.
- The current Statistics view UI was not described in sources fetched.

## Sublime Merge (sublimemerge.com): speed, search syntax, line staging, transparency

### Takeaway
Sublime Merge's selling points are raw performance (a custom Git-reading library, repeatedly sped up in 2024–2026 builds), find-as-you-type search with field operators, hunk- and line-level staging, a built-in 3-way merge tool, a command palette, and showing the exact git commands it runs. It runs on Windows, Mac, and Linux (x64 and ARM64), 64-bit only. Changes from 2023 to 2026 were incremental: an index editor, SHA-256 and reftable support, worktree management, and LFS locks.

### Cited Findings
- Search: instant, find-as-you-type across the repo, filterable by commit message, author, path, or contents. Staging: whole files, hunks, or selected lines (selecting lines splits a hunk). Built-in merge-conflict tool. Command palette. Git transparency: the app shows the exact git commands it runs. An adaptable layout and theming system (Dark/Light). Blame and file history. Speed comes from a custom cross-platform UI toolkit, a syntax-highlighting engine, and a "custom high-performance Git reading library." Code review shows side-by-side diffs, syntax highlighting, and character diffs, and you can drag a hunk edge to show more context. Git Flow integration and submodule management — [Sublime Merge homepage](https://www.sublimemerge.com/)
- Search operators (community-sourced): `path:` (glob patterns, e.g. `path:**/File.java`), `contents:` (added in dev build 1080), `commit:`. `min-parents: 0` includes merge commits, which `path:` and `contents:` ignore by default. An empty search shows query-syntax help — [Sublime Forum search results](https://forum.sublimetext.com/t/find-inside-a-commit/52999); [Sublime Forum](https://forum.sublimetext.com/t/can-i-see-file-history-include-merge-commit/61632)
- Platforms: macOS, Windows (including a portable build), and Linux (.deb/.rpm/.pkg.tar.xz/.tar.xz, x64 plus ARM64 .deb/.tar.xz). 64-bit only — [Sublime Merge download/changelog](https://www.sublimemerge.com/download)
- Build 2083 (Feb 2023): `auto_fetch`, multi-select in the Files tab, and a re-run button for failed commands — [changelog](https://www.sublimemerge.com/download)
- Build 2091 (Aug 2023): edit staged files in an index editor, a `diff_algorithm` preference, WebP image diff, partial clone support, and Change Theme in the command palette — [changelog](https://www.sublimemerge.com/download)
- Build 2096 (Apr 2024): improved character diffing, HDR image diff, and a "Switch Repository" command — [changelog](https://www.sublimemerge.com/download)
- Build 2102 (Oct 2024): significantly faster repository scanning and diffs, Create Branch from Tag, up to 1000 file tabs, Locations filter keywords, and Wayland kinetic scrolling — [changelog](https://www.sublimemerge.com/download)
- Build 2110 (Jul 2025): significantly faster repository load and refresh. Build 2121 (Dec 2025): significantly faster repo loading and blame, SHA-256 repositories, split-index mode, and Open in Terminal — [changelog](https://www.sublimemerge.com/download)
- Build 2125 (Apr 2026): Git LFS lock and unlock. Build 2130 (Sep 2026): reftable support, worktree management in the locations bar, and skipping empty commits when cherry-picking several. Build 2132: keep local changes on reset. Build 2136 (Nov 9 2026): faster diffs and bundled Git 2.56.0 — [changelog](https://www.sublimemerge.com/download)

### Inferences
- The ideas a GitKraken-like client can borrow from Sublime Merge are: a typed, operator-based commit search (author:/path:/contents:/commit:/min-parents:); a visible git-command log with a re-run button for failed commands; drag-to-expand diff context; editing the staged (index) version of a file directly; and a command palette for every action.
- Sublime Merge has repeatedly invested in performance on large repositories (2024–2026 builds) and supports newer Git formats such as SHA-256 and reftable.

### Gaps
- The official search docs URL (sublimemerge.com/docs/search) returned 404. The complete operator list (e.g. exact `author:` syntax) was not confirmed from an official page, though the homepage says search filters by author.
- Pricing was not shown on the fetched pages.

## SmartGit (smartgit.dev / syntevo): window styles, distributed reviews, SVN, hosting, AI agents

### Takeaway
SmartGit is cross-platform (Windows/macOS/Linux) and offers three window styles: Standard (streamlined, Feature-Flow oriented), Log, and Working Tree. It has a three-way Conflict Solver, Git-flow, GitHub Flow, and Feature Flow, deep GitHub/GitLab/Bitbucket/Gerrit/JIRA integration, the Distributed Reviews add-on (review metadata stored in the repo itself), SVN bridging, and DeepGit/"Investigate" for blame-like history tracing. 2025–2026 releases added AI commit messages and rewording, a Git Notes UI, worktree management, SHA-256/reftable, "Commit Overlap", and (26.2 RC) running Codex or Claude agents in isolated branches or worktrees with session management.

### Cited Findings
- Three window styles: Standard, Log, and Working Tree. The Standard window is a streamlined UI that hides advanced options, with guided Feature Flow and simplified commit and push — [SmartGit features](https://www.smartgit.dev/features/)
- The Standard window has two views. "Local Files" covers changes, staging, committing, and conflicts. "History" shows the visual log, branches, stashes, tags, and commit details. It also has "My History" (local branches with ahead/behind state, related PRs, and CI results), "All Branches + Tags" with search, Stashes, and Reflog — [SmartGit Standard Window](https://www.smartgit.dev/features/standard-window/)
- The Standard window targets teams with a uniform approach such as Feature-Flow — [SmartGit 25.1 manual: Standard Window](https://docs.syntevo.com/SmartGit/25.1/Manual/GUI/Standard-Window)
- Conflict Solver: a side-by-side three-way layout with one-click resolutions and optional external tools. Graph view filters by author and path and shows pushed or pending commits. Commits can be split, squashed, or reordered. Feature Flow, Git Flow, and GitHub Flow are supported. Integrations cover GitHub (and Enterprise), GitLab (and self-hosted), Bitbucket, Gerrit, and JIRA. Also a Journal view, Git LFS, commit-message spell check, external tools, stash-on-demand, and an on-prem license server — [SmartGit features](https://www.smartgit.dev/features/)
- Distributed Reviews add-on: create PRs between branches and comment on PRs or commits. Metadata is stored in the repository under `refs/meta/smartgit/reviews`, so it works offline with no server component — [Distributed Reviews docs](https://docs.syntevo.com/SmartGit/Latest/Distributed-Reviews-add-on-.html); [Distributed Reviews page](https://www.syntevo.com/smartgit/review)
- Investigate / DeepGit: DeepGit is a combined Blame/Log tool for tracing a code's history, invoked via Query|Investigate. It runs on macOS, Windows, and Linux — [syntevo.com](https://syntevo.com/); [SmartGit 23.1 changelog](https://syntevo.com/smartgit/changelog-23.1.txt)
- SVN integration: SmartGit can work with SVN repositories as an SVN client. It maps svn:ignore to .gitignore and translates EOL and externals in normal mode (documented in 7.1/8.0-era docs) — [SmartGit SVN Integration docs](https://docs.syntevo.com/SmartGit/8.0/SVN-Integration)
- 23.1: smarter branch history, improved GitHub identity handling, extended syntax handling — [SmartGit What's New](https://www.smartgit.dev/whats-new/)
- 24.1: easier submodule handling and file-case fixes, smarter .gitignore editing, a GitHub issue picker in the commit dialog, one-click "Open at Hosting Provider", and a whitespace-ignore option in diffs — [SmartGit What's New](https://www.smartgit.dev/whats-new/)
- 25.1: AI commit message generation and rewording, automatic stash descriptions, full Git Notes UI with selectable namespaces, branch-aware worktree checkout and management, and explicit display of LFS pointer/unexpanded states with faster LFS refresh — [SmartGit What's New](https://www.smartgit.dev/whats-new/)
- 26.1: UI refresh, Git 3.0 support (SHA-256 repos and reftable), GitLab support in the Standard window (MRs, CI, browsing, issue-based commit messages), better worktree visibility in the Graph, "Commit Overlap", custom "Ask AI" prompts, AI for merge commits, and clearer Pull behavior with multiple remotes — [SmartGit What's New](https://www.smartgit.dev/whats-new/)
- 26.2 RC: in-file move detection and word wrap in the Changes view. Codex or Claude can run Git tasks or development work in isolated branches or worktrees, and agent sessions are managed alongside history, branches, worktrees, and reviews. Also drag-and-drop branch navigation in the Standard window and "SmartLinks" that share a commit's context in one link — [SmartGit What's New](https://www.smartgit.dev/whats-new/)

### Inferences
- SmartGit's unusual ideas are: several window styles for different skill levels; serverless distributed code review stored as git refs; SVN bridging; in-file move detection in diffs; and treating AI agent sessions as tracked objects tied to branches and worktrees.
- Its "My History" view (branches plus PR plus CI status in one list) is a compact PR/CI dashboard that GitKraken-like clients could emulate.

### Gaps
- The What's New page shows no release dates, so dates for 23.1–26.2 are unconfirmed (version numbers imply years).
- Not confirmed from current official docs: syntax-aware diff/merge specifics, hooks UI, branch protection, file-level log details, and large-file handling beyond LFS. The SVN docs found are from older versions (7.1/8.0), so current SVN support status in 26.x is unverified.
- The fetched pages did not describe the Log and Working Tree windows in detail.

## Cross-client unique ideas relevant to a GitKraken-like client

### Takeaway
The recurring ideas across these clients are: branch parent/stack tracking with restack and `--update-refs`; fork-point dimming in history; merged/stale detection that understands squash and rebase PR merges; conflict prediction before an operation; operator-based search; user-defined commands with parameter dialogs; repo workspaces and worktree-first UIs; visible git-command transparency; global undo; and local AI agents (Claude Code/Codex/Cursor) for commit messages and branch review.

### Cited Findings
- Fork-point graying in history — [Tower 15](https://www.git-tower.com/release-notes?os=mac&version=15)
- PR-aware merged detection (squash and rebase) and auto-archiving of branches — [Tower 17](https://www.git-tower.com/release-notes?os=mac&version=17); [Tower 15](https://www.git-tower.com/release-notes?os=mac&version=15)
- Conflict prediction warnings for rebase, cherry-pick, and revert — [Fork Mac notes 2.55/2.66](https://git-fork.com/releasenotes)
- UI custom commands with generated dialogs — [Fork Mac notes 2.29/2.51](https://git-fork.com/releasenotes)
- Workspaces of repos (nested, per-window, in Quick Launch) — [Fork Mac notes 2.26/2.27/2.71](https://git-fork.com/releasenotes)
- Repository Treemap of activity over time — [Fork Mac notes 2.52](https://git-fork.com/releasenotes)
- Avatars in interactive rebase — [Fork Mac notes 2.61](https://git-fork.com/releasenotes)
- Operator search and the git command log — [Sublime Merge](https://www.sublimemerge.com/)
- Review metadata stored in the repo — [SmartGit Distributed Reviews](https://docs.syntevo.com/SmartGit/Latest/Distributed-Reviews-add-on-.html)
- AI agent sessions per worktree — [SmartGit 26.2 RC](https://www.smartgit.dev/whats-new/)
- CLI to open an agent-work review diff — [Tower 18](https://www.git-tower.com/release-notes/mac)
- Global undo/redo — [Tower Undo](https://www.git-tower.com/features/undo)

### Inferences
- All four vendors added AI features calling external CLI agents (Claude Code, Codex, Cursor) in late 2025–2026, rather than bundling a hosted model. Fork, Tower, and SmartGit all do this. Sublime Merge shows no AI features in its changelog through Nov 2026.
- Worktree support is now standard in all four: Tower 12.5, Fork 2.41+, SmartGit 25.1, and Sublime Merge build 2130.

### Gaps
- No source found for a "first-parent" graph mode toggle in any of the four clients from fetched pages.
- No source found for emoji-shortcode rendering in commit messages in these four clients.

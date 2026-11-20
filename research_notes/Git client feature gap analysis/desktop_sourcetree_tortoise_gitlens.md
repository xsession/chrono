# Distinctive features of GitHub Desktop, SourceTree, TortoiseGit and GitLens (as of Nov 2026)

Research date: 2026-11-20. Primary sources: GitHub Desktop `changelog.json` (development branch), GitHub changelog blog, docs.github.com; sourcetreeapp.com and Atlassian release notes; tortoisegit.org release notes and manual; GitLens CHANGELOG.md (main branch) and help.gitkraken.com GitLens docs.

## GitHub Desktop: standout features and 2023–2026 additions

### Takeaway
GitHub Desktop is narrow in scope but closely tied to GitHub. Its distinctive features are PR checkout, PR preview, check runs with re-run, OS notifications for failed checks and reviews, repository-rules awareness, secret-scanning push-protection handling, and drag-and-drop history editing. Since 2025 it has also added Copilot features (commit messages, conflict resolution, model picker/BYOK), worktrees (3.6, June 2026) and multiple accounts per host (3.7, Nov 2026). A GitKraken-style client is most likely to lack the GitHub "platform-state" features: rules, checks, push protection and Copilot instructions.

### Cited Findings
**Version status**
- The newest stable tag is `release-3.7.0`, with betas 3.6.11-beta1 and 3.6.12-beta1/beta2 dated Nov 2026. — [desktop/desktop releases](https://github.com/desktop/desktop/releases); [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)

**Co-authors**
- 1.0.13 added "Commit together with co-authors". 3.5.6 added "Support adding Copilot as a co author and show avatars for mentionable users". — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)
- How it works: you choose co-authors in the commit box, and Desktop writes `Co-authored-by:` trailers. Choosing which lines to commit and adding a co-author need no syntax knowledge. — [About GitHub Desktop](https://docs.github.com/en/desktop/overview/about-github-desktop)

**Checking out a pull request**
- You can open a PR's head branch from Current Branch > Pull Requests, or from GitHub.com via Code > Local > "Checkout with GitHub Desktop". Once it is checked out, select the base branch in History and open the "Ahead" tab to see the contributor's commits. — [Viewing a PR in GitHub Desktop](https://docs.github.com/en/desktop/working-with-your-remote-repository-on-github-or-github-enterprise/viewing-a-pull-request-in-github-desktop)
- You cannot comment on or review a PR in Desktop. "View Pull Request on GitHub" opens the browser instead. — [same page](https://docs.github.com/en/desktop/working-with-your-remote-repository-on-github-or-github-enterprise/viewing-a-pull-request-in-github-desktop)
- 2.5.6 started marking draft PRs differently from regular PRs. — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)

**PR preview**
- 3.2.0: "Preview your pull request - view a diff of changes in your current branch" before creating it. 3.5.4 added line-change counts to the PR Preview dialog. 3.7.0 fixed fork previews so they compare against the parent repository's default branch. — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)

**Check runs and re-running checks**
- 2.9.6: "View and re-run the check runs for the checked out pull request". Desktop shows check status on the PR, and a re-run checks dialog has per-run status icons (fixed in 3.5.4). — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json); [Viewing a PR docs](https://docs.github.com/en/desktop/working-with-your-remote-repository-on-github-or-github-enterprise/viewing-a-pull-request-in-github-desktop)

**Notifications**
- 2.9.10 added "Initial support for system notifications when checks fail". 3.0.0 added "Get notified when your pull requests are reviewed". — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)

**Branch protection and repository rules**
- 2.2.4 added "Warn when committing to a protected branch". 3.3.0 added "Initial support for repository rules". 3.5.7 made the rename-branch dialog validate names against repository rulesets. 3.6.5 kept branch-protection info when API calls fail. — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)
- 3.4.21 handles GitHub Secret Scanning push-protection errors in "a friendly dialog with the ability to bypass blocked non-approval requiring secrets". — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)

**Drag-and-drop history editing**
- 2.7.1 added cherry-picking by drag-and-drop or context menu, and 2.7.2 added creating a branch during a cherry-pick. — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)
- 2.9.0 added reordering commits by drag-and-drop in History, squashing by drag-and-drop or context menu, and a "Squash and merge" option for branch merges. — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)
- The docs list undo, reset to a commit, amend, revert, cherry-pick, reorder, squash, tags and checking out a commit. — [Managing commits](https://docs.github.com/en/desktop/managing-commits)

**Multi-commit diff and diff features**
- 3.1.0: "You can diff a consecutive range of commits". 2.6.0 added split/unified diff toggle, and 2.8.0 added expanding diffs for more context. — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)

**Copilot**
- Commit message generation launched in public preview in April 2025 and became GA in Desktop 3.5 (June 2025). You click a button in the commit box, Copilot fills in the summary and description, and you edit before committing. It is available on Copilot Free and paid plans, under an org policy. — [GitHub changelog 2025-04-16](https://github.blog/changelog/2025-04-16-copilot-commit-message-generation-now-in-public-preview-on-github-desktop); [GitHub changelog 3.5 GA](https://github.blog/changelog/2025-06-24-github-desktop-3-5-github-copilot-commit-message-generation-now-generally-available)
- The docs say English is the only supported language for generated commit messages. This comes from a translated docs page. — [Responsible use of Copilot in GitHub Desktop (zh)](https://docs.github.com/zh/enterprise-cloud@latest/copilot/responsible-use-of-github-copilot-features/responsible-use-of-github-copilot-in-github-desktop)
- 3.5.12-beta1 started using repo rules to guide commit message generation and added a model picker. 3.6.0 added resolving merge conflicts with Copilot and stopping an in-flight generation. — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)
- 3.6 (2026-06-26) moved Copilot onto the Copilot SDK and added a model picker plus BYOK, including local models. Commit messages now read `.github/copilot-instructions.md` and `AGENTS.md` and honor ruleset commit-metadata rules. For conflicts, Desktop explains the conflicting changes and suggests a resolution for you to review or edit. — [GitHub changelog 3.6](https://github.blog/changelog/2026-06-26-github-desktop-3-6-worktrees-and-deeper-copilot-integration/)
- 3.7.0 added "Open repositories in the GitHub Copilot app" from the Repository menu. — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)

**Worktrees, accounts, hooks and push**
- 3.6 added a "Current Worktree" toolbar menu alongside Current Repository and Current Branch. It lists the main and linked worktrees and has a "New Worktree" button, and the release pitches it for parallel coding-agent sessions. 3.6.7 added an "Always show worktree list" setting. — [GitHub changelog 3.6](https://github.blog/changelog/2026-06-26-github-desktop-3-6-worktrees-and-deeper-copilot-integration/); [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)
- 3.4.19 added multiple Enterprise accounts. 3.7.0 added personal and work accounts side by side on the same host, with per-repo account selection that leaves the Git author identity unchanged. — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json); [releases](https://github.com/desktop/desktop/releases)
- 3.5.5 added "running hooks in user's shell environment and allow bypassing commit hooks". 3.7.0 added "Automatically push after a commit". — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)
- 2.8.0 added repository aliases in the repo list. — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json)

**Accessibility**
- 3.3.4 added `h2` dialog titles. 3.3.6 made commit reordering keyboard-accessible and improved keyboard and screen-reader support for banners. 3.4.0 underlines links by default. 3.4.4 added visual input labels to the squash dialog. 3.6.8 keeps keyboard focus visible in dropdowns under high-contrast themes. — [changelog.json](https://raw.githubusercontent.com/desktop/desktop/development/changelog.json); [releases](https://github.com/desktop/desktop/releases)

### Inferences
- The gap a GitKraken-style client could close is "platform awareness": ruleset validation of branch names and commit messages, push-protection bypass flows, check-run view and re-run, and OS notifications for failed checks and reviews.
- Desktop follows the same trend as GitLens and GitKraken: worktrees surfaced in primary navigation, framed around AI agents working in parallel.

### Gaps
- I did not find a stable 3.7.0 release date in the sources I read. Only the tag exists, and the betas are dated early to mid Nov 2026.
- There is no dedicated docs page on the re-run checks flow, for example whether you can re-run only failed checks or individual runs. The changelog says only "view and re-run the check runs".
- No single dated summary of Desktop's broader screen-reader audit was found.

## SourceTree: standout features and 2023–2026 status

### Takeaway
SourceTree (Mac 4.2.x, Windows 3.4.x) is in maintenance mode. Releases from 2023 to 2026 are mostly security fixes, authentication changes and small quality-of-life features. Its long-standing differentiators are built-in Git-flow, Mercurial support (still advertised), Custom Actions, a remote repository browser, hunk/line staging, LFS, and a GUI interactive rebase. No AI features appear in any release notes found.

### Cited Findings
**Latest versions**
- Mac 4.2.20 (built 2026-11-01) and Windows 3.4.33 (built 2026-10-31). Releases have shipped every 1–4 months since 2023. — [Sourcetree download archives](https://www.sourcetreeapp.com/download-archives)

**Advertised features**
- "Smart branching with Sourcetree and Git-flow", Git LFS support, submodules, "interactive rebase tool", local commit search, a remote repository manager for searching and cloning remotes, "Stage and discard changes by the file, hunk or line", "Works with Git and Mercurial", stashing, cherry-pick, and enterprise deployment on Windows. — [sourcetreeapp.com](https://www.sourcetreeapp.com/)

**Windows 2023–2026 feature additions**
- 3.4.12 (Mar 2023): PAT authentication for GitHub/GHE, replacing Basic. — [3.4.33 notes](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.15 (Sep 2023): stash creation dates and including untracked files in a stash. Bitbucket now requires App Passwords. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.18 (Apr 2024): name filtering for branches, tags, remotes, submodules and subtrees, a commit size indicator, and file counts. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.19 (Jul 2024): search log by author. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.20 (Sep 2024): Git commit template support. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.21 (Nov 2024): option to set `safe.bareRepository`. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.22 (Feb 2025): customizable file double-click and an "Open in Sourcetree" shell context menu. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.23 (Mar 2025): "Ignore Whitespace" in diff, numeric tag sorting, and Ctrl+D to launch the external merge tool. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.24 (Jul 2025): stash only selected or staged files, and API token authentication. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.25 (Sep 2025): bundled Git 2.51.0 and Git LFS 3.7.0. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.27 (Dec 2025): keyboard shortcuts for Custom Actions, branch filtering in Log/History, and an interactive-rebase fix for child commits. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.29 (Feb 2026): breaking change that replaces deprecated Bitbucket cross-workspace APIs. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.31 (Jun 2026): force-fetch tags, and browsing GitLab repositories by group. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.32 (Aug 2026): OAuth refresh-token rotation, an option to disable AutoStartSSHAgent, and a fix to the `$BRANCH` custom-action parameter. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- 3.4.33 (Oct 2026): security fixes covering a Mercurial trust-check bypass, untrusted `.git/config` diff settings, `sourcetree://` NTLM exposure, and command execution through Git-flow branch names. — [same](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)

**Mercurial history and other notes**
- Mercurial is still bundled and patched on Windows: 3.4.25 fixed repeated Mercurial.zip extraction, and 3.4.33 patched the Mercurial trust-check bypass. — [3.4.33 notes](https://product-downloads.atlassian.com/software/sourcetree/windows/ga/ReleaseNotes_3.4.33.html)
- On Mac, macOS 12.3 removed python2, which broke bundled Mercurial (`hg log ... posix_spawn error 2`). The issue was filed in Mar 2022 and closed as Fixed in Sep 2022 with no fix version listed. — [SRCTREE-7836](https://jira.atlassian.com/browse/SRCTREE-7836)
- A community thread reports Custom Actions breaking. It is a single report and not confirmed as a removal. — [Atlassian Community](https://community.atlassian.com/forums/discussion/1219284/custom-actions-no-longer-working)
- Mac 4.2.3 (May 2023) fixed a `sourcetree://` URL handler vulnerability and removed GitHub Basic authentication. This is a secondary aggregator source. — [Softpedia Mac changelog](https://mac.softpedia.com/progChangelog/SourceTree-Changelog-87863.html)

### Inferences
- The SourceTree features worth copying are Custom Actions (user-defined external commands with `$REPO`, `$BRANCH`, `$SHA`-style parameters, now bindable to shortcuts), first-class Git-flow, Mercurial and commit templates. Everything else is common to modern clients.
- SourceTree's repeated `sourcetree://` URL-handler and Git-flow-name command-injection CVEs are a warning for any client that registers URL schemes or shells out with branch names.

### Gaps
- The Mac 4.2.x release notes page (product-downloads.atlassian.com/.../Sourcetree_4.2.html) returned HTTP 403, so Mac-specific feature additions from 2023–2026 are unverified.
- I found no official Atlassian statement on deprecating Mercurial or on a SourceTree roadmap or AI plans.
- The Custom Actions parameter list and the "bookmarks"/repository browser window are not described in sources I read. They are long-standing features known from older docs, not re-verified here.

## TortoiseGit: features beyond the shell context menu

### Takeaway
TortoiseGit is a full suite: Log dialog, Revision Graph, TortoiseGitBlame, TortoiseGitMerge, Rebase, Sync, Daemon, Bisect, Submodules, client-side hooks configured in the UI, bug-tracker integration (bugtraq properties plus the COM `IBugTraqProvider` plugin interface), patch serials sent by mail, git-svn, LFS locking, and worktrees. Changes from 2023 to 2026 are incremental: worktrees (2.14), ARM64 and the Windows 11 context menu, multi-commit blame, relative worktrees (2.19). The latest release is 2.19.2.0 (2026-11-18).

### Cited Findings
**Releases 2023–2026**
- 2.14.0.0 (2023-02-05): worktree support (add, remove, lock, unlock, prune, list), initial ARM64 builds, and highlighting of "error", "fatal" and "warning" in Git output. — [TortoiseGit release notes](https://tortoisegit.org/docs/releasenotes/)
- 2.15.0.0 (2023-10-03): registering the Windows 11 top-level context menu for the current user, SVG in the image diff tool, and selecting multiple commits in TortoiseGitBlame. — [release notes](https://tortoisegit.org/docs/releasenotes/)
- 2.16.0.0 (2024-04-30): `GIT_TEMPLATE_DIR` support, an ignore-line-endings button in TortoiseGitMerge, and `--force` for removing worktrees. — [release notes](https://tortoisegit.org/docs/releasenotes/)
- 2.17.0.0 (2024-10-30): Browse References can sort branches by commit date and shows committer columns. The log can sort by author date. — [release notes](https://tortoisegit.org/docs/releasenotes/)
- 2.18.0.0 (2025-10-31): bundled HTML help opens in the browser, and the Windows 11 menu registers for all users at login. — [release notes](https://tortoisegit.org/docs/releasenotes/)
- 2.19.0.0 (2026-06-20): relative worktrees and a `/*` wildcard in `safe.directory`. — [release notes](https://tortoisegit.org/docs/releasenotes/)
- 2.19.2.0 (2026-11-18): library updates and support for Git for Windows 2.56+. — [release notes](https://tortoisegit.org/docs/releasenotes/)

**Manual sections showing distinct subsystems**
- Log Dialog — [tgit-dug-showlog](https://tortoisegit.org/docs/tortoisegit/tgit-dug-showlog.html)
- Revision Graphs — [tgit-dug-revgraph](https://tortoisegit.org/docs/tortoisegit/tgit-dug-revgraph.html)
- "Who Changed Which Line?" (TortoiseGitBlame) — [tgit-dug-blame](https://tortoisegit.org/docs/tortoisegit/tgit-dug-blame.html)
- Rebase — [tgit-dug-rebase](https://tortoisegit.org/docs/tortoisegit/tgit-dug-rebase.html)
- Sync — [tgit-dug-sync](https://tortoisegit.org/docs/tortoisegit/tgit-dug-sync.html)
- Daemon — [tgit-dug-daemon](https://tortoisegit.org/docs/tortoisegit/tgit-dug-daemon.html)
- Bisect — [tgit-dug-bisect](https://tortoisegit.org/docs/tortoisegit/tgit-dug-bisect.html)
- Submodules — [tgit-dug-submodules](https://tortoisegit.org/docs/tortoisegit/tgit-dug-submodules.html)
- Worktrees — [tgit-dug-worktrees](https://tortoisegit.org/docs/tortoisegit/tgit-dug-worktrees.html)
- Git LFS Locking — [tgit-dug-lfslocking](https://tortoisegit.org/docs/tortoisegit/tgit-dug-lfslocking.html)
- Client-side hook scripts are configured in Settings (separate from `.git/hooks`). — [Settings: hooks](https://tortoisegit.org/docs/tortoisegit/tgit-dug-settings.html#tgit-dug-settings-hooks)
- Bug tracker integration through bugtraq/issue-tracker properties — [tgit-dug-bugtracker](https://tortoisegit.org/docs/tortoisegit/tgit-dug-bugtracker.html). The COM plugin interface is documented in appendix B — [IBugTraqProvider](https://tortoisegit.org/docs/tortoisegit/tgit-ibugtraqprovider.html)
- Creating and applying patches, including "Sending patches by mail" (patch serial / format-patch workflow) — [tgit-dug-patch](https://tortoisegit.org/docs/tortoisegit/tgit-dug-patch.html#tgit-dug-patch-sendpatches)
- Icon overlays — [wcstatus](https://tortoisegit.org/docs/tortoisegit/tgit-dug-wcstatus.html#tgit-dug-wcstatus-1). Overlay settings — [settings-overlay](https://tortoisegit.org/docs/tortoisegit/tgit-dug-settings.html#tgit-dug-settings-overlay)
- SVN bridge: "git svn dcommit" — [tgit-dug-svn-dcommit](https://tortoisegit.org/docs/tortoisegit/tgit-dug-svn-dcommit.html)
- External diff/merge tools (TortoiseGitMerge is the bundled default) — [tgit-dug-diff](https://tortoisegit.org/docs/tortoisegit/tgit-dug-diff.html#tgit-dug-diff-tools)

### Inferences
- TortoiseGit features a GitKraken-style client typically lacks:
  - per-repo issue-tracker integration through committed bugtraq properties (issue-ID input box, regex-linkified IDs in the log) and pluggable providers that can fetch an issue list into the commit dialog;
  - UI-configured client hooks scoped by path;
  - a `git daemon` launcher for ad-hoc LAN sharing;
  - a guided Bisect;
  - a format-patch plus send-mail workflow;
  - a git-svn bridge;
  - LFS lock management;
  - a Sync dialog that combines pull, fetch, push, send patch and submodule update in one window.
- How Daemon, Sync, Bisect and the bugtraq properties work is based on general knowledge of the manual. The specific pages are cited, but I did not re-read their contents in this session. Verify the details before quoting step-by-step behavior.

### Gaps
- I did not fetch the individual manual pages, so exact option names were not checked. That covers the Log dialog filter fields, Revision Graph options, the "show changes as unified diff" command, TGitCache modes (Default, Shell, None) and the bugtraq property names (`bugtraq:url`, `bugtraq:logregex`, etc.).
- The TGitCache settings page has no separate TOC entry. Its anchor is unconfirmed.
- I did not check whether TortoiseGitMerge has its own separate manual.

## GitLens: Commit Graph, Launchpad, Visual History, Worktrees, Cloud Patches, Code Suggest, AI (as of 19.6, Nov 2026)

### Takeaway
GitLens changed sharply in 2026. In 18.0 (May 2026) the Commit Graph was rebuilt with Compare, Compose and AI Code Review modes. In 19.0 (Aug 2026) the Graph became the main side bar view, and 19.2 removed the Home view in its favor. Additions in 2026 centre on AI agents (Kepler, Codex/Copilot CLI/OpenCode session tracking, auto-rebase with AI conflict resolution), stacked PRs, merge queues, review sessions and repository health. Editor-level blame, CodeLens and hovers remain the free core. Code Suggest was retired from Launchpad in 18.3, although the docs still describe it.

### Cited Findings
**Editor annotations (free)**
- Current-line blame appears at the end of the line. File blame comes with an age heatmap, and the file heatmap counts lines as cold after 90 days. Git CodeLens shows the most recent change and author above files and blocks. Status bar blame is included. Hovers show commit details, quick actions and inline diffs. — [GitLens features](https://help.gitkraken.com/gitlens/gitlens-features/)

**Commit Graph**
- The Graph is free on public and local repos. Private repos need Pro, and signed-out users get a 3-day preview on private repos. — [GitLens features](https://help.gitkraken.com/gitlens/gitlens-features/)
- Minimap (experimental), search with `author:`/`file:` prefixes (natural-language search is Pro), branch filter modes (All, Current, Smart, Agent, Favorited), toggles for remotes, tags and stashes, scroll markers for HEAD, selection and matches, PR icons on branches, worktree scoping, compact layout, and Pro Compare and Compose modes. — [GitLens features](https://help.gitkraken.com/gitlens/gitlens-features/)
- History of Graph features:
  - 15.2.0 (2024-07-10): PR markers on the scroll bar and minimap, plus rich PR/issue hovers.
  - 16.0.0 (2024-11-14): "Filter Commits" toolbar button and a reimagined Home view.
  - 17.12.0 (2026-04-14): Graph sidebar.
  - 18.0.0 (2026-05-27): new Graph with an embedded details panel, AI Compose, AI Code Review, Compare mode with AI changelog, inline stash apply/drop, a rebuilt minimap, and `type:wip` and column filters.

  — [GitLens CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md)
- 18.1.0 (2026-06-09): working-changes bar, squash/drop/reword from the Graph, back/forward navigation and a shortcuts reference. 18.2.0 (2026-06-15): AI conflict resolution (Preview). 18.3.0 (2026-07-09): standalone Commit Composer editor retired and Code Suggest retired from Launchpad. — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md)
- 19.0.0 (2026-08-12): the Commit Graph becomes the main GitLens side bar view. — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md)
- 19.1.0 (2026-09-01):
  - multiple ref pills per row;
  - natural-language search plus `committer:`, `type:merge` and `-message:` operators;
  - "Start Auto-Rebase" in the interactive rebase editor, which hands conflicts to AI;
  - fixup and squash-fixups actions;
  - live status for Codex, Copilot CLI and OpenCode agent sessions;
  - automatic daily safe maintenance, a Repository Health visualization and a health banner;
  - Push Tag.

  — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md)
- 19.2.0 (2026-09-16): scope the Graph to a worktree, save a default layout, customizable shortcuts, a "Run Default Task" button on working-changes rows, Generate Changelog for multi-selected commits, resuming past agent sessions, force push for diverged branches, and experimental Spanish and Chinese UI. The Home view was removed in favor of the Graph. — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md)
- 19.3.0 (2026-10-01): start tasks and PR reviews in Kepler (GitKraken's agent tool), and Rebase Stack / Auto-Rebase Stack that cascade through stacked PR chains. — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md)
- 19.4.0 (2026-10-15): Publish Repository, Start Work with configurable branch-name formats, and Jira Data Center. 19.5.0 (2026-10-27): Add Remote checks URL reachability. — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md)
- 19.6.0 (2026-11-10):
  - Review sessions in Review Changes mode: viewed-file checklist, step-through controls, and comment threads on AI findings that survive amend and rebase.
  - GitHub merge queue support in Launchpad and the Graph.
  - Branch cleanup for branches whose work has already landed.
  - A notifications bell.
  - Azure DevOps PRs in the Graph, Asana issues, and Jira DC autolinks.

  — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md)

**Launchpad**
- Launchpad preview arrived in 15.0.0 (2024-05-14) and a Launchpad side bar view in 15.3.0 (2024-08-15). — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md)
- It is Pro. It groups your PRs by status (ready to merge, blocked, needs review, …), and you can merge, rebase stacks, switch branches, pin or snooze. It needs a connected provider. — [GitLens features](https://help.gitkraken.com/gitlens/gitlens-features/)

**Visual File History / Visual History**
- It charts the history of a file, folder, repo or branch by author, with bubble size showing change size. The Community tier covers public and local repos only. — [GitLens features](https://help.gitkraken.com/gitlens/gitlens-features/)
- It was overhauled in 16.2.0 (2025-01-17) and rebuilt as "Visual History" in 18.0.0. — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md)

**Interactive rebase editor**
- A GUI for reordering, editing, squashing and dropping commits, with drag-and-drop and conflict detection. It is free. AI Auto-Rebase is Pro. — [GitLens features](https://help.gitkraken.com/gitlens/gitlens-features/)

**Cloud Patches and Code Suggest**
- Cloud Patches preview arrived in 14.5.0 (2023-11-13). It shares uncommitted work through GitKraken cloud storage, with access by link, org or collaborator, and supports self-hosting on S3. It is enabled with `gitlens.cloudPatches.enabled`. — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md); [GitLens features](https://help.gitkraken.com/gitlens/gitlens-features/)
- Code Suggest preview arrived in 15.0.0 (2024-05-14). It lets reviewers propose edits to any file in a PR, including lines the PR did not change, and works on github.com only. — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md); [GitLens features](https://help.gitkraken.com/gitlens/gitlens-features/)
- Conflict: the 18.3.0 changelog says Code Suggest was retired from Launchpad, but the docs page still describes it. — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md) vs [GitLens features](https://help.gitkraken.com/gitlens/gitlens-features/)

**AI (GitKraken AI)**
- "Generate Commit Message (Experimental)" arrived in 14.5.0 (2023-11-13). — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md)
- Current tiers: commit messages are free. Explanations of commits, branches, working changes and stashes are Preview. Stash messages, changelogs, composition (Commit Composer) and Auto-Rebase are Pro. — [GitLens features](https://help.gitkraken.com/gitlens/gitlens-features/)
- GitKraken MCP tools (including Launchpad, Start Work and Start Review) arrived in 17.10.0 (2026-02-11), with Cursor bundling in 17.11.1. — [CHANGELOG](https://raw.githubusercontent.com/gitkraken/vscode-gitlens/main/CHANGELOG.md)

**Start Work**
- Start Work is Pro. It creates a branch from an issue in a connected integration, with the branch-name format set by `gitlens.startWork.branchNameFormat`. — [GitLens features](https://help.gitkraken.com/gitlens/gitlens-features/)

### Inferences
- In late 2026 GitLens differentiates on four fronts:
  - AI-driven history editing: Compose, Auto-Rebase with AI conflict resolution, AI review sessions that persist across rebases.
  - Agent orchestration: agent session status, worktree-per-agent, Kepler handoff.
  - Stacked-PR and merge-queue workflows.
  - Repository health and maintenance.
- In-editor blame, heatmap and CodeLens are still unique to an IDE extension. A standalone desktop client can approximate them only through a blame view with an age heatmap and per-line hovers.

### Gaps
- The changelog sections fetched did not show exact "Added" versions for the Worktrees view (it predates 14.2), the original minimap, or AI Explain Commit (referenced by 14.5.1). The changelog is about 715 KB and I did not read it in full.
- Free/Pro tiers are as of the current docs page and may differ by plan. I did not check pricing.
- I did not read the dedicated docs subpages (`/gitlens/gl-commit-graph/`, `/gitlens/gl-launchpad/`, `/gitlens/gl-cloud-patches/`, `/gitlens/gl-gk-ai/`) individually.

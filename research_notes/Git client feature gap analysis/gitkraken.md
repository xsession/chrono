# GitKraken Desktop and the GitKraken Platform: Feature Inventory (as of Nov 2026)

Research date: 2026-11-20. Latest Desktop release found: **12.7.0 (Nov 17, 2026)**. Primary sources: help.gitkraken.com release notes (12.x current, 11.x, 10.x archives), help.gitkraken.com feature docs (many pages marked "Last verified: 2026-03/04"), gitkraken.com pricing/feature pages. Much of the feature-doc detail comes from the help center's full-text dump https://help.gitkraken.com/llms-full.txt; each claim below cites the specific help page URL named inside that dump.

Abbreviations: RN12 = https://help.gitkraken.com/gitkraken-desktop/current/ ; RN11 = https://help.gitkraken.com/gitkraken-desktop/11x/ ; RN10 = https://help.gitkraken.com/gitkraken-desktop/10x/ ; PRICING = https://www.gitkraken.com/pricing

---

## Q0. Tiers and what is gated where (context for every feature below)

### Takeaway
Five tiers: Community (free; local and public repos only), Pro (max 2 seats), Advanced (max 10), Business (max 100), Enterprise (20+, custom). Private repos, Launchpad, Cloud Workspaces, Profiles, Conflict Prevention, Cloud Patches and all AI need Pro or higher. Team View, Team Launchpad and self-hosted integrations need Advanced. Insights and admin controls are Business-level, though sources disagree. Prices were not visible on the fetched pricing page; it showed "$" placeholders and a "60-70% OFF Pro" promo.

### Cited Findings
- Community: Desktop, CLI, GitLens for OSS, Kepler (limited tasks) and GitKraken.dev. Local repos and public remotes only. Includes a 14-day Advanced trial. — [PRICING](https://www.gitkraken.com/pricing)
- Pro: private repos, Jira Cloud and Trello, Conflict Detection, Launchpad, Shared Cloud Workspaces, GitKraken MCP, 1M AI credits per user per week, bring-your-own-key AI, GitKraken Code Review, and the Agent Sessions view for private repos. Max 2 seats. — [PRICING](https://www.gitkraken.com/pricing)
- Advanced: self-hosted and enterprise integrations (GHES, GitLab Self-Managed, Azure DevOps Server, Jira DC, Bitbucket DC), single-domain SSO, Team Launchpad, Automations (preview), 2M credits per week (20% pooled to the org), AI security controls and private AI model providers. Max 10 seats. — [PRICING](https://www.gitkraken.com/pricing)
- Business: multi-domain SSO, internal software directory, Insights (access limits may apply), admin Conflict Prevention control, org-level bring-your-own-key, enforceable org AI controls, and 3M credits per week. Max 100 seats. — [PRICING](https://www.gitkraken.com/pricing)
- Enterprise: custom terms, security audit logs, an SLA, and 4M credits per week. GitKraken Desktop On-Premise (Serverless or Self-Hosted Server) needs at least 10 users. — [PRICING](https://www.gitkraken.com/pricing); LDAP support for self-hosted is listed at [git-client page](https://www.gitkraken.com/git-client)
- Profiles are a Pro feature. — [git-client page](https://www.gitkraken.com/git-client); [Profiles help](https://help.gitkraken.com/gitkraken-desktop/profiles/)
- Pro accounts are limited to 1 Team; Advanced and Business allow multiple Teams. — [Teams help (in llms-full)](https://help.gitkraken.com/llms-full.txt)
- **Conflict: Insights tier.** The pricing page puts Insights under Business ("access limits may apply"), — [PRICING](https://www.gitkraken.com/pricing); the Insights page says "Advanced, Business, and Enterprise" and also offers a standalone $25 per contributor per month plan. — [Insights](https://www.gitkraken.com/insights)
- **Conflict: GitLab Self-Managed tier.** The integrations help says it is "available on Pro and up", while GHES and Bitbucket DC require Advanced. — [Integrations help](https://help.gitkraken.com/gitkraken-desktop/integrations/); the pricing page lists GitLab Self-Managed under Advanced. — [PRICING](https://www.gitkraken.com/pricing)

### Inferences
- The free tier is functionally complete for local and public work; the paywall is "private remote + cloud/team + AI".

### Gaps
- Dollar prices could not be extracted; the page rendered "$" with no amounts.

---

## Q1. Release timeline 2024–2026: what was added or changed (feature-relevant items only)

### Takeaway
The product moved through three phases. 10.x (2024) brought Launchpad, Cloud Patches, Code Suggest, worktrees and conflict detection. 11.x (2025 to Mar 2026) brought GitKraken AI and a migration to the Git CLI executable with large performance gains. 12.x (Apr to Nov 2026) is agent-centric: an Agent Sessions view, parallel coding-agent worktrees and a multi-tab terminal, while PR review moved to the web (GitKraken Code Review).

### Cited Findings — 12.x (2026) [RN12](https://help.gitkraken.com/gitkraken-desktop/current/)
- 12.0.0 (Apr 14, 2026):
  - **Agent Sessions View** in the Left Panel shows worktree cards with branch, changes, ahead/behind, PRs and Claude Code status.
  - "New Agent Session" creates a worktree, runs setup commands (Preferences > Agents) and launches an agent: Claude Code, Codex CLI, OpenCode, Copilot CLI or Gemini CLI.
  - Embedded terminal: multiple sessions per worktree, drag-and-drop, xterm.js upgraded to v6 (ligatures, emoji).
  - Shallow-clone options when adding a remote; "Open in…" IDE commands in the Command Palette; open a worktree in a new tab.
- 12.1.0 (May 5): worktrees inherit view settings (hidden or soloed refs); "Remove worktree and delete branch"; `gitkraken <path>` CLI launch; "Review on GitKraken.dev" button; zoom up to 200%; Electron 41.
- 12.1.2 / 12.2.1: merged-PR "pills" for GitHub and GitLab in the Toolbar, Commit Details and worktree cards. 12.2.0: OpenCode live status; "Rebase onto this commit" for commits without branches.
- 12.3.0 (Jul 7):
  - Browser-based sign-in at gitkraken.dev; integrations managed via gitkraken.dev.
  - **Multiple WIP nodes in the Commit Graph** (one per worktree; toggle in Preferences > Agents).
  - **PR review moved to GitKraken Code Review (gitkraken.dev/review)** from Launchpad, the Left Panel and the Graph.
  - Zoom up to 300%; AI org credit-pool usage view.
- 12.3.1: pin icon in the Graph column header jumps to the pinned branch; bundled Git 2.54.0.
- 12.4.0 (Aug 5): "Start an Agent Session" from issues (Launchpad ACTION column, Left Panel); Claude permission allow/deny prompts with a command preview.
- 12.4.1 (Sep 2): worktree tab grouping; Codex live status and permission prompts; "View changes in PR"; Left Panel search matches `origin/master` or `origin:master`.
- 12.5.0 (Sep 15): Copilot CLI live status and permissions; Cursor CLI agent; faster Commit Composer.
- 12.6.0:
  - Multiple terminal tabs per repo or worktree.
  - **Stacked pull requests on GitHub.com** in the Create PR panel.
  - Combined diffs for consecutive commit selections.
  - AI model list updated (Claude Sonnet 5, GPT-5.6 family, Gemini 3.x Flash).
- 12.6.1 (Oct 20): terminal tab shortcuts; worktree folder shown in the Left Panel; multiple agents per worktree; Jira loads up to 10,000 projects; SSH keygen now 4096-bit.
- 12.6.2 (Nov 4): GitFlow feature finish signs with SSH keys; non-rebase finish uses the 3-way merge editor and git merge drivers; Bitbucket `ssh.bitbucket.org` handling; Monaco 0.57.0.
- 12.7.0 (Nov 17): **Git operations now use a Git executable instead of a built-in library**. The experimental "Use Git Executable" toggle was removed; Preferences > General > Git Executable picks the install. Bundled Git 2.56.1.

### Cited Findings — 11.x (Mar 2025 – Mar 2026) [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/)
- 11.0.0 (Mar 31, 2025): **GitKraken AI** GA: commit message generation, Explain Commits, and Preferences > GitKraken AI with custom instructions and BYO OpenAI or Anthropic keys with a per-feature model.
- 11.1.0 (May 2025): AI PR title and description (template-aware), AI stash message, AI amend-message regeneration; BYO Azure OpenAI (Advanced tier), Gemini and custom OpenAI-compatible endpoints; Left Panel Hide All / Show All; GitHub avatars in the graph.
- 11.2.0 (Jun 2025): **AI conflict resolution (preview)** ("Auto-resolve with AI", with a per-hunk confidence and explanation); revert individual hunks; provider avatars; MCP via GitKraken CLI.
- 11.2.1: New Tab experience with recent and favorite repos and search.
- 11.3.0 (Aug 2025): **AI Commit Composer (preview)**; Team Launchpad leaves preview (Advanced+).
- 11.4.0: dedicated **Ollama** option for local models.
- 11.5.0 (Oct 2025): performance release (details in Q7); usage gauge; GPT-5; Git Executable gains reset, undo checkout and submodules.
- 11.6.0 (Nov 2025): "Explain Working Changes"; custom endpoint URLs for OpenAI, Anthropic and Gemini; preset custom instructions; shallow repo support; org-level GitHub PR templates; checkout of a tag's commit.
- 11.7.0 (Dec 2025): Markdown preview in the file viewer; **undo/redo for interactive rebase, multi-cherry-pick, drop/reword and Commit Composer**; "Explain Branch Changes". Custom themes deprecation announced.
- 11.8.0 (Jan 2026): native ARM builds for Linux and Windows; shallow clones in the clone dialog; **custom themes disabled** (light, dark and high-contrast remain).
- 11.9.0 (Feb 2026): shallow clone settings from Launchpad and Repo Management; squash-on-merge setting; word-wrap toggle in diff, file view, history and merge panels.
- 11.10.0 (Mar 2026):
  - **Pin branch to left** of the graph and **Smart Branch Filtering** (focus on the current branch plus its target/upstream).
  - Restore files from any commit; **sparse checkout** support.
  - Gemini becomes the default AI.
  - **GitHub Actions removed from the Left Panel** (deprecated).

### Cited Findings — 10.x (May 2024 – Mar 2025) [RN10](https://help.gitkraken.com/gitkraken-desktop/10x/)
- 10.0.0 (May 14, 2024): Focus View renamed to **Launchpad**; **Code Suggestions** via Cloud Patches; Launchpad Team view; Jira Server renamed to Jira Data Center.
- 10.1.0 (Jul 2024): Launchpad status-bar summary; Repository Management groups, colors and recent group; Launchpad checkout or clone actions; UTF-8 commit search.
- 10.2.0 (Aug 2024): new tabbed Commit Panel (Commit, Stash, Cloud Patch, Code Suggestion) with stashing of specific files or hunks; Team Launchpad preview.
- 10.3.0: Launchpad label filter and user filter; click a selected commit to deselect it.
- 10.4.0 (Oct 2024): Jira fix-version and sprint filters, GitHub and GitLab milestone filters; **Insights moved to GitKraken.dev**; "Perform Repo Maintenance" command (`git maintenance run`); multi-line stash descriptions.
- 10.4.1: GitLab reviewers; amend or reword with SSH signing.
- 10.5.0 (Nov 2024): **Worktree support**; saved Launchpad views synced via GitKraken.dev; Bitbucket reviewers; auto fast-forward on remote checkout; "don't ask again" on force-push; GPG/SSH signing auto-populates from git config ("Commit Signing" section).
- 10.6.0 (Dec 2024):
  - **Automatic Conflict Detection (preview)**.
  - **Custom external editors** with arguments.
  - Worktree icons and status; checkout of PRs into new worktrees.
  - **Old Terminal tab and `gkc` commands removed** (a new embedded terminal arrived in 12.x).
  - Removed the option to pin the Commit Detail panel to the bottom.
- 10.7.0: toolbar breadcrumb search of repos and branches.
- 10.8.0 (Mar 2025): **Conflict Prevention (preview)** against org members' unmerged work; target-branch status indicator; **multi-commit cherry-pick** with an interactive reorder/squash/reword/drop tool.

### Inferences
- The long-running "Git Executable (experimental)" migration from the NodeGit/libgit2-style built-in library to the system or bundled git CLI finished in 12.7.0. Many 10.x/11.x features (SSH signing, shallow, sparse, Cloud Patches) were tied to it.

### Gaps
- No entries before May 2024 were reviewed; the 9.x archive is at https://help.gitkraken.com/gitkraken-desktop/9x/.

---

## Q2. Launchpad and in-app PR workflows (view, create, review, check out, merge)

### Takeaway
Launchpad is a unified inbox of PRs, issues and local WIPs across workspaces. It has Personal and Team modes, filters, pin/snooze, saved views and quick actions (checkout, worktree, start agent session). PRs can be created, viewed and merged in-app for all four major hosts. Since 12.3, *reviewing* PRs happens in the browser-based GitKraken Code Review on gitkraken.dev, not in Desktop.

### Cited Findings
- Opened from the Launchpad tab in the top-left; tabs are Pull Requests, Issues, WIPs, All and Snoozed. — [Launchpad help](https://help.gitkraken.com/gitkraken-desktop/gitkraken-launchpad/)
- Providers:
  - PRs: GitHub, GitLab, Bitbucket and Azure DevOps (cloud); On-Prem adds GHES, GitLab Self-Managed, Bitbucket Server and Azure DevOps Server.
  - Issues: Jira, GitHub Issues, Azure DevOps and Trello (Jira DC on-prem).
  - WIPs: repos in the selected workspace with uncommitted changes.
  — [Launchpad help](https://help.gitkraken.com/gitkraken-desktop/gitkraken-launchpad/)
- PRs are grouped by status (Open, Draft, At Risk, etc.) with review and build state. A status-bar summary links into the matching group. — [Launchpad help](https://help.gitkraken.com/gitkraken-desktop/gitkraken-launchpad/); [RN10 10.1.0](https://help.gitkraken.com/gitkraken-desktop/10x/)
- Filters: workspace, source, project, labels, fix versions, sprints, milestones, creator, assignee, mentions, and contributor (Team view). — [Launchpad help](https://help.gitkraken.com/gitkraken-desktop/gitkraken-launchpad/)
- Item actions:
  - Pin.
  - Snooze for 1h, 4h or until tomorrow; needs a paid plan.
  - Open in browser, view repo, open code suggestions, review PR, check out the PR branch, close PR, check out in a new worktree.
  - "Start an Agent Session" from an issue (sets repo, branch name, base branch and agent; sends the issue context).
  — [Launchpad help](https://help.gitkraken.com/gitkraken-desktop/gitkraken-launchpad/); [RN12 12.4.0](https://help.gitkraken.com/gitkraken-desktop/current/)
- Personal view covers items you created, are assigned to, are reviewing or are mentioned in. Team view covers others' items across workspace repos and needs Advanced plus Cloud Workspaces. — [Launchpad help](https://help.gitkraken.com/gitkraken-desktop/gitkraken-launchpad/)
- Saved views (the "+" icon) are per mode and synced via GitKraken.dev; not available on-prem. — [Launchpad help](https://help.gitkraken.com/gitkraken-desktop/gitkraken-launchpad/); [RN10 10.5.0](https://help.gitkraken.com/gitkraken-desktop/10x/)
- Launchpad needs Pro; Team Launchpad needs Advanced. — [PRICING](https://www.gitkraken.com/pricing)
- PR creation works on GitHub, GitLab, Bitbucket and Azure DevOps. Three entry points:
  - drag a branch onto another and choose "Start a pull request";
  - right-click the target branch;
  - "+" in the Left Panel PULL REQUESTS section.
  Templates are supported for GitHub, GitLab and Azure DevOps. Merge in app works for all four. — [PR help](https://help.gitkraken.com/gitkraken-desktop/pull-requests/)
- GitHub-only features: GitHub Pull Request View, merge-strategy choice (merge, squash, rebase), stacked PRs on GitHub.com ("Start a pull request stack" or "Add to an existing stack"), and code suggestions. "View changes in #N" shows PR changes in the graph. — [PR help](https://help.gitkraken.com/gitkraken-desktop/pull-requests/); [RN12 12.6.0](https://help.gitkraken.com/gitkraken-desktop/current/)
- Review: "Review on GitKraken.dev" opens GitHub, GitLab or Azure DevOps PRs in GitKraken Code Review in the browser; not on-prem. — [PR help](https://help.gitkraken.com/gitkraken-desktop/pull-requests/); [RN12 12.3.0](https://help.gitkraken.com/gitkraken-desktop/current/)
- The Left Panel PR list has predefined filters (e.g., "My Pull Requests"), custom filters with a filter syntax, and icons showing CI and review state. — [PR help](https://help.gitkraken.com/gitkraken-desktop/pull-requests/); [PR filter syntax](https://help.gitkraken.com/gitkraken-desktop/pull-requests-filter-syntax/)
- Reviewers can be added on GitLab (10.4.1) and Bitbucket (10.5.0); AI generates the PR title and description (11.1.0); org-level GitHub PR templates are supported (11.6.0). — [RN10](https://help.gitkraken.com/gitkraken-desktop/10x/); [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/)

### Inferences
- In-app line-comment review has effectively been outsourced to a web product. A competing client that does inline review in-app would differ here.

### Gaps
- Whether the in-app GitHub PR View still supports inline comments after 12.3 is unclear.

---

## Q3. Workspaces, Cloud Patches, Code Suggest, Team View, Conflict Prevention, multi-repo actions

### Takeaway
- **Workspaces** group repos. Local workspaces are free; Cloud workspaces are shared and need Pro. They support bulk fetch, pull, clone and open.
- **Cloud Patches** share staged changes or commits via a link stored on GitKraken servers or your own S3. They are still "experimental/preview".
- **Code Suggest** uses Cloud Patches to propose whole-repo edits on a PR.
- **Conflict Prevention** (Pro, preview) and **Team View** (Advanced) give pre-merge overlap warnings based on teammates' unmerged and uncommitted work.

### Cited Findings
- Local Workspaces stay on the machine and need no integration; they accept repos, a folder, or a `.code-workspace` file, with "Sync with local directory". Cloud Workspaces live in the account, can be shared, and need a hosting integration. Local workspaces can be converted to Cloud. — [Workspaces help](https://help.gitkraken.com/gitkraken-desktop/workspaces/)
- Multi-repo actions (checkbox selection in Repository Management): Fetch all, Pull all (customizable), Clone all (HTTPS unless SSH configured), Open in GitKraken or an external editor, Locate (Cloud), Remove. — [Workspaces help](https://help.gitkraken.com/gitkraken-desktop/workspaces/)
- Repository Management: groups with drag-to-reorder, group colors, a recently-opened group, hide/unhide, resizable columns. — [RN10 10.1.0/10.2.0](https://help.gitkraken.com/gitkraken-desktop/10x/); [RN12 12.0.0](https://help.gitkraken.com/gitkraken-desktop/current/)
- Cloud Workspaces, Workspace Insights and Launchpad Team View are unsupported on On-Prem Serverless and Self-Hosted Server. — [Workspaces help](https://help.gitkraken.com/gitkraken-desktop/workspaces/)
- Shared Workspaces need Pro. — [PRICING](https://www.gitkraken.com/pricing); [Teams help (llms-full)](https://help.gitkraken.com/llms-full.txt)
- The CLI's `gk workspace` commands are deprecated as of CLI 3.1.76. — [CLI help](https://help.gitkraken.com/cli/cli-home/)
- Cloud Patches:
  - Create one from staged files with the Cloud Patch icon in the Commit Panel, or right-click a commit and choose "Share commit as Cloud Patch".
  - Access: anyone with the link, org members, or only collaborators.
  - Storage: GitKraken servers or your own AWS S3.
  - Listed as the only experimental feature (Preferences > Experimental); hidden on self-hosted and standalone.
  — [Experimental features help](https://help.gitkraken.com/gitkraken-desktop/experimental-features/); [Cloud Patches feature page](https://www.gitkraken.com/features/cloud-patches)
- Cloud Patches are marked "preview" under Team Collaboration on the pricing page and listed as Pro on the git-client page. — [PRICING](https://www.gitkraken.com/pricing); [git-client](https://www.gitkraken.com/git-client)
- Code Suggest: proposes edits anywhere in the codebase, not only on changed lines. The PR gets a comment with links, and accepting one adds a commit to the remote branch. In Desktop, suggestions appear under Code Suggestions in the PR View, where you apply or reject them. Introduced in 10.0.0. — [Cloud Patches feature page](https://www.gitkraken.com/features/cloud-patches); [RN10](https://help.gitkraken.com/gitkraken-desktop/10x/); [PR help](https://help.gitkraken.com/gitkraken-desktop/pull-requests/) (code suggestions listed as GitHub-only)
- Conflict Prevention (Pro, status "preview"):
  - Detects overlapping edits between your work and org members' committed but unmerged changes, and checks your branch against the target branch.
  - Surfaced as an alert icon or avatar in the toolbar. Actions: share as Cloud Patch, push, copy summary, merge or rebase, invite a collaborator.
  - Base branches are configured per repo in Preferences > Conflict Prevention, with `**` wildcards and `!` excludes. Target-branch conflicts take priority.
  - Org-member detection is unavailable on-prem.
  — [Conflict Prevention help](https://help.gitkraken.com/gitkraken-desktop/conflict-prevention/); [RN10 10.6.0/10.8.0](https://help.gitkraken.com/gitkraken-desktop/10x/)
- Preference "Enable proactive conflict detection with target branch". — [Preferences help](https://help.gitkraken.com/gitkraken-desktop/preferences/)
- Team View (Advanced):
  - Shows each teammate's checked-out branch, files with uncommitted changes (added and removed lines in green and red), and Active/Away status.
  - Highlights overlapping local changes with an orange warning icon.
  - Opt out via "Share work-in-progress status with my team". Team selection is in Preferences > Team.
  — [Team View help](https://help.gitkraken.com/gitkraken-desktop/team-view/)

### Inferences
- Conflict Prevention works from pushed but unmerged commits; Team View additionally shares *uncommitted* WIP through GitKraken's cloud. Both need a GitKraken org account and cloud connectivity.

### Gaps
- No technical detail was found on how overlap is computed (file-level vs. hunk-level).

---

## Q4. GitKraken AI: features, invocation and configuration

### Takeaway
GitKraken AI (paid plans only) covers:
- commit messages, amend-message regeneration, stash messages, and PR titles and descriptions;
- explanations of commits, branch changes and working changes;
- AI conflict resolution (preview) and Commit Composer (preview), which splits or recomposes commits.

It uses GitKraken-hosted models (default Gemini) metered by weekly credits, or BYO keys (OpenAI, Azure, Anthropic, Gemini), or a Custom URL for local or private models (Ollama, LM Studio, OpenRouter). Changelog generation exists only in GitLens, not Desktop.

### Cited Findings
- Feature list and entry points:
  - AI Commit Message (GA): AI button by the commit message box.
  - AI Commit Composer (preview): "Compose commits with AI" for staged changes, or "Recompose n commits with AI" on a contiguous range; Create Commits, Cancel or Reset.
  - Explain commit(s) (GA): Commit Panel.
  - Explain Branch Changes (GA): right-click a branch or HEAD.
  - AI Amend Message (GA).
  - AI Stash Message (GA): stash icon next to the Commit tab.
  - AI PR Title and Description (GA): "Generate title and description", optionally template-based.
  - AI Conflict Resolution (preview): "Auto-resolve with AI", with a per-hunk explanation and confidence.
  — [GitKraken AI help](https://help.gitkraken.com/gitkraken-desktop/gkd-gitkraken-ai/)
- "Explain Working Changes" was added in 11.6.0, and AI conflict resolution syncs to exact code lines. — [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/)
- AI compose and recompose can be undone from the toolbar Undo. — [GitKraken AI help](https://help.gitkraken.com/gitkraken-desktop/gkd-gitkraken-ai/); [Undo help](https://help.gitkraken.com/gitkraken-desktop/undo-and-redo/)
- Configuration in Preferences > GitKraken AI:
  - Default provider is GitKraken-hosted Gemini (no key; usage counted in credits).
  - Model is selectable per feature. Hosted models show a credit multiplier (e.g., 0.8x Gemini 2.5 Flash, 4.5x Claude Sonnet 4.5).
  - BYO key: OpenAI, Azure, Anthropic, Google Gemini, Custom URL, with a Test Connection button.
  - Custom URL examples: Ollama, Hugging Face, OpenRouter, LM Studio. GitKraken does not troubleshoot third-party endpoints.
  - On-Prem: Custom URL is the only option.
  — [GitKraken AI help](https://help.gitkraken.com/gitkraken-desktop/gkd-gitkraken-ai/)
- Custom instructions: Global, Commit Message, Explain, Stash, PR, Conflict Resolution and Commit Composer; preset instruction choices since 11.6. — [GitKraken AI help](https://help.gitkraken.com/gitkraken-desktop/gkd-gitkraken-ai/); [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/)
- Org controls (via gitkraken.dev): disable AI, restrict models, set org-wide keys or URLs; the user's key field is hidden when an admin key is set. There is a per-user "Enable GitKraken AI" toggle, and a one-time keep-or-disable prompt after 14 days without use. — [GitKraken AI help](https://help.gitkraken.com/gitkraken-desktop/gkd-gitkraken-ai/)
- Provider history:
  - 11.0: BYO OpenAI and Anthropic.
  - 11.1: Azure (Advanced tier), Gemini, OpenAI-compatible endpoints.
  - 11.4: dedicated Ollama option.
  - 11.5: GPT-5 and a usage gauge.
  - 11.6: custom endpoint URLs.
  - 11.10: Gemini becomes the default.
  - 12.0: Claude 4.6 models.
  - 12.6: Claude Sonnet 5, GPT-5.6, Gemini 3.x.
  — [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/); [RN12](https://help.gitkraken.com/gitkraken-desktop/current/)
- Credits: 1M, 2M, 3M or 4M per user per week by tier; on reaching the limit, a "Weekly Limit Reached" dialog appears and admins can buy more credits. — [PRICING](https://www.gitkraken.com/pricing); [GitKraken AI help](https://help.gitkraken.com/gitkraken-desktop/gkd-gitkraken-ai/)
- AI Changelog is a GitLens feature (Advanced). — [PRICING](https://www.gitkraken.com/pricing)
- The commit-graph marketing page claims AI natural-language commit search. — [Commit Graph feature page](https://gitkraken.com/features/commit-graph)
- Coding agents (12.x), which are separate from GitKraken AI:
  - Run Claude Code, Codex CLI, Copilot CLI, Cursor CLI, Gemini CLI or OpenCode, each in its own branch and worktree, with an Agents view of cards.
  - Live status and permission allow/deny prompts come from hooks or plugins installed via `gk`. Cursor CLI does not report live status.
  — [Agents help](https://help.gitkraken.com/gitkraken-desktop/agents/); [CLI help](https://help.gitkraken.com/cli/cli-home/)

### Inferences
- Natural-language graph search may be a GitLens or GitKraken.dev capability; the Desktop Search help only documents message, SHA and author search.

### Gaps
- No Desktop changelog-generation feature was found. The Desktop help docs do not document natural-language search.

---

## Q5. Core Git client features (identities, signing, hooks, LFS, Gitflow, submodules, worktrees, rebase, merge/diff tools, history/blame, search, graph, themes, shortcuts)

### Takeaway
GitKraken covers essentially all mainstream Git GUI features:
- profiles, GPG and SSH signing, hooks with custom paths and skip, LFS UI, Gitflow (not AVH-specific);
- submodules (no subtree), worktrees, interactive rebase, multi-commit cherry-pick;
- a built-in 3-way merge editor plus external tools, line and hunk staging, file history and blame;
- a column-configurable graph with solo, hide, pin and smart filter;
- broad undo/redo, a Command Palette and keyboard shortcuts.

There is no minimap. Custom themes have been disabled since 11.8.

### Cited Findings
- **Profiles (Pro for multiple)**:
  - Each profile has its own General, Integrations and UI prefs, open tabs and avatar.
  - Optionally syncs name and email to the global `.gitconfig`.
  - Switch from the top-right profile icon; can be tied to different GitHub accounts.
  — [Profiles help](https://help.gitkraken.com/gitkraken-desktop/profiles/)
- **Commit signing (all tiers)**:
  - GPG or SSH for commits and tags; set in Preferences > Commit Signing (signing key, "Generate new GPG Key", GPG program path).
  - SSH needs a `.pub` key and an `allowed_signers` file.
  - Signed commits show a badge with details on hover. GitHub and GitLab verify SSH signatures; Bitbucket does not.
  — [Signing help](https://help.gitkraken.com/gitkraken-desktop/commit-signing-with-gpg/)
  - Settings auto-populate from git config (10.5.0). — [RN10](https://help.gitkraken.com/gitkraken-desktop/10x/)
  - Gitflow finish signs with SSH (12.6.2). — [RN12](https://help.gitkraken.com/gitkraken-desktop/current/)
- **Git hooks**: runs standard hooks from `.git/hooks` (non-zero exit blocks the action); per-repo custom hooks path in Preferences > Git Hooks; respects global `core.hooksPath`; a "skip hooks" option in the Commit Panel. — [Hooks help](https://help.gitkraken.com/gitkraken-desktop/githooks/)
- **LFS**:
  - Requires Git LFS 3.0+. Initialize via Preferences > LFS or "Initialize with LFS" when creating a repo.
  - Track patterns in Preferences or by right-clicking a WIP file > "LFS > Track file pattern".
  - LFS files are tagged in the Commit Panel; the toolbar LFS menu has pull and prune (shown only when LFS is enabled).
  - LFS pull runs automatically after clone or submodule init; diffs show pointer metadata.
  — [LFS help (llms-full)](https://help.gitkraken.com/llms-full.txt); [Interface help](https://help.gitkraken.com/gitkraken-desktop/interface/)
- **Gitflow (all tiers, GA)**:
  - Initialize in Preferences > Gitflow; creates `develop`; configurable branch names and tag prefix.
  - Left Panel GITFLOW section with Start Feature/Release/Hotfix and right-click Finish (with a delete-branch option).
  - Releases and hotfixes merge to main and develop and are tagged.
  — [Gitflow help](https://help.gitkraken.com/gitkraken-desktop/git-flow/)
  - Gitflow finish improved in 12.6.2 (3-way merge editor, merge drivers, rebase finish). — [RN12](https://help.gitkraken.com/gitkraken-desktop/current/)
- **Submodules**: Submodules pane (enabled from the Left Panel header menu); add by URL and path; prompt to init on clone; update, or change the tracked commit; auto-update globally or per repo. **Git subtree is not supported**. — [Submodules help](https://help.gitkraken.com/gitkraken-desktop/submodules/)
- **Worktrees**:
  - Added 10.5.0: create from a branch, commit or PR; double-click to switch.
  - 12.x additions: open in a tab; tab grouping; multiple WIP nodes; remove the active worktree; remove worktree and delete branch; setup commands.
  — [RN10](https://help.gitkraken.com/gitkraken-desktop/10x/); [RN12](https://help.gitkraken.com/gitkraken-desktop/current/); [Worktrees help](https://help.gitkraken.com/gitkraken-desktop/worktrees/)
- **Shallow clone and sparse checkout**: shallow clone in the clone dialog (11.8/11.9) and when adding a remote (12.0); sparse checkout at clone time or per repo (11.10). — [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/); [RN12](https://help.gitkraken.com/gitkraken-desktop/current/)
- **Interactive rebase**:
  - Start by dragging a branch onto a target ("Interactive Rebase"), right-clicking a branch, or right-clicking a parent commit.
  - Actions Pick, Reword, Squash, Drop (keys P, S, R, D); Reset.
  - Not available with merge commits on the source branch, nor when the initial commit is involved; must be completed in-app.
  — [Interactive rebase help](https://help.gitkraken.com/gitkraken-desktop/interactive-rebase/)
  - Multi-commit cherry-pick with reorder, squash, reword and drop (10.8). — [RN10](https://help.gitkraken.com/gitkraken-desktop/10x/)
- **Merge/conflict editor**: the built-in Merge Tool opens on clicking a conflicted file and lets you pick lines from each side, edit the output, and search with Cmd/Ctrl+F. A doc covers agent-branch conflicts. — [Branching & merging help (llms-full)](https://help.gitkraken.com/llms-full.txt)
  - 3-way merge editor; Monaco editor (12.6.2). — [RN12](https://help.gitkraken.com/gitkraken-desktop/current/)
  - Delete `.orig` files after merging. — [Preferences help](https://help.gitkraken.com/gitkraken-desktop/preferences/)
- **External tools** (Preferences > External Tools):
  - Merge tools: Beyond Compare, KDiff, P4Merge and others.
  - Diff tools: Beyond Compare, FileMerge, Kaleidoscope, KDiff, Araxis, P4Merge, or "Git Config Default" to use `.gitconfig`.
  - Custom external editors with arguments (10.6).
  - External terminal and coding agent commands. "Open in External Diff/Merge Tool" is Cmd/Ctrl+D.
  — [Diff help (llms-full)](https://help.gitkraken.com/llms-full.txt); [RN10](https://help.gitkraken.com/gitkraken-desktop/10x/); [Preferences help](https://help.gitkraken.com/gitkraken-desktop/preferences/)
- **Diff, staging, history and blame**:
  - Stage, unstage or discard selected lines or hunks; compare 2 commits with Shift+click; combined diff for consecutive commits (12.6).
  - File history and blame via right-click on a file, or Cmd/Ctrl+Shift+H to search a file.
  - Patches can be created and applied ("preliminary").
  - Word wrap (11.9); Markdown preview (11.7); revert a single hunk (11.2); restore files from any commit (11.10).
  — [Diff help (llms-full)](https://help.gitkraken.com/llms-full.txt); [Staging help (llms-full)](https://help.gitkraken.com/llms-full.txt); [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/); [RN12](https://help.gitkraken.com/gitkraken-desktop/current/)
- **Undo/redo**:
  - Toolbar or Cmd/Ctrl+Z and Cmd/Ctrl+Y (or Shift+Z).
  - Covers checkout, commit, discard, delete branch, remove remote, reset branch, interactive rebase, multi-cherry-pick, drop/reword and AI Compose.
  - Only the most recent action can be undone.
  — [Undo help](https://help.gitkraken.com/gitkraken-desktop/undo-and-redo/)
- **Search**:
  - The top-right search bar finds commits by message, SHA or author, live, and highlights matches in the graph. Also reachable from the Command Palette.
  - Results are limited to loaded commits (default 2,000; configurable; or "Show All Commits").
  — [Search help](https://help.gitkraken.com/gitkraken-desktop/search/)
  - Marketing lists further operators (my changes, file, change, type:stash, before/after dates). — [Commit Graph feature page](https://gitkraken.com/features/commit-graph)
  - UTF-8 and multilingual search (10.1). — [RN10](https://help.gitkraken.com/gitkraken-desktop/10x/)
  - The Left Panel filter (Cmd/Ctrl+Opt/Alt+F) also matches remote branches. — [Interface help](https://help.gitkraken.com/gitkraken-desktop/interface/)
- **Graph columns and customization**:
  - Default columns: Branch/Tag, Graph, Commit Message. Optional: Author, Date/Time, Sha.
  - Toggle columns via header right-click or the gear icon; drag to reorder; resize. Settings persist per repo.
  - The Author column filter supports authors and teams.
  — [Interface help](https://help.gitkraken.com/gitkraken-desktop/interface/)
  - Marketing also lists a "Changes" column (file count plus added/removed bar), compact vs full view, avatars or initials, and dimming merge commits. — [Commit Graph feature page](https://gitkraken.com/features/commit-graph)
- **Graph behaviors**:
  - Ghost branches: hovering a commit shows its nearest containing branch.
  - Hovering a branch highlights related rows (can be disabled).
  - Stash nodes, WIP node(s), annotated tag tooltips, provider avatars.
  — [Interface help](https://help.gitkraken.com/gitkraken-desktop/interface/); [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/)
- **Solo/hide/pin/filter**:
  - Hide branches, tags, remotes or stashes from the Left Panel (gray icon). Solo a branch by right-click (orange icon; other refs hidden).
  - Hide All / Show All per section (11.1).
  - Pin branch to the left of the graph and Smart Branch Filtering (11.10); pin icon in the column header (12.3.1).
  — [Hide/Solo help](https://help.gitkraken.com/gitkraken-desktop/hiding-and-soloing/); [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/); [RN12](https://help.gitkraken.com/gitkraken-desktop/current/)
- **Minimap / activity graph**: no evidence of a commit-graph minimap or activity heatmap in Desktop docs or feature pages. — [Interface help](https://help.gitkraken.com/gitkraken-desktop/interface/); [Commit Graph feature page](https://gitkraken.com/features/commit-graph) (neither mentions one). The Activity Log is a separate log of Git operations ("extended logging" option). — [Preferences help](https://help.gitkraken.com/gitkraken-desktop/preferences/)
- **Themes**:
  - Built-in light, dark and high-contrast themes, plus sync with the system theme.
  - Switch in Preferences > UI Customization or with "switch theme" in the Command Palette.
  - **Custom JSONC themes (`~/.gitkraken/themes/`) disabled since 11.8.0** ("UI modernization").
  — [Themes help](https://help.gitkraken.com/gitkraken-desktop/themes/); [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/)
- **Keyboard shortcuts and navigation**:
  - Shortcut list opens with Cmd/Ctrl+/. Command Palette is Cmd/Ctrl+P.
  - Tabs: Cmd/Ctrl+1–9, Cmd/Ctrl+T, Cmd/Ctrl+W. Toggle the Left Panel with Cmd/Ctrl+J. Zoom 80–300%.
  - Terminal tab shortcuts (12.6.1); Cmd/Ctrl+O opens a repo; Cmd/Ctrl+Alt+O opens Repo Management.
  — [Shortcuts help](https://help.gitkraken.com/gitkraken-desktop/keyboard-shortcuts/); [Interface help](https://help.gitkraken.com/gitkraken-desktop/interface/); [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/); [RN12](https://help.gitkraken.com/gitkraken-desktop/current/)
- **Tabs**: one per repo; aliases; per-profile tab sets; worktree tab groups. — [Interface help](https://help.gitkraken.com/gitkraken-desktop/interface/)
- **Toolbar pull variants**: Fetch All, Pull (ff if possible), ff-only, and rebase, with a default setting; auto-fetch interval 0–60 min; auto-prune. — [Interface help](https://help.gitkraken.com/gitkraken-desktop/interface/); [Preferences help](https://help.gitkraken.com/gitkraken-desktop/preferences/)
- **Embedded terminal** (12.x): multi-tab, per worktree, xterm.js v6. The older Terminal tab and `gkc` commands were removed in 10.6. — [RN12](https://help.gitkraken.com/gitkraken-desktop/current/); [RN10](https://help.gitkraken.com/gitkraken-desktop/10x/)
- **Tags**: create annotated tags or annotate existing tags; annotation shows on hover. — [Tags help (llms-full)](https://help.gitkraken.com/llms-full.txt)

### Inferences
- "Gitflow" is GitKraken's own implementation configured in-app. No documentation mentions git-flow AVH compatibility specifically.

### Gaps
- No confirmation of git-flow AVH support (only generic Gitflow).
- No Desktop doc for natural-language search.
- No minimap found. Treat as absent, but this is not explicitly confirmed.

---

## Q6. Integrations (hosting, issue trackers, SSO) and platform products (CLI, Insights, GitKraken.dev)

### Takeaway
Desktop integrates with GitHub, GHES, GitLab, GitLab Self-Managed, Bitbucket, Bitbucket DC and Azure DevOps for hosting. For issues it supports Jira Cloud and DC, Trello, GitLab Issues, GitHub Issues and GHES Issues; Azure DevOps work items appear in Launchpad. Linear is supported by the CLI and Insights, but no Desktop integration was found. SSO is Advanced (single domain) or Business (multi-domain, SAML). The GitKraken CLI (`gk`) is free and adds AI, PR/issue lists and an MCP server for coding agents. Insights is a web-based engineering metrics product.

### Cited Findings
- Hosting integrations: GitHub, GitHub Enterprise Server, GitLab, GitLab Self-Managed, Bitbucket, Bitbucket Data Center, Azure DevOps. Issue integrations: Jira Cloud, Jira DC, Trello, GitLab Issues, GitLab Self-Managed Issues, GitHub Issues, GHES Issues. — [Integrations help](https://help.gitkraken.com/gitkraken-desktop/integrations/)
- On the Community plan, only public GitHub and GitLab repos are available and some issue trackers are view-only. Multiple profiles with separate integrations need Pro. — [Integrations help](https://help.gitkraken.com/gitkraken-desktop/integrations/)
- Since 12.3, cloud integrations connect through the GitKraken account, finishing in the browser at gitkraken.dev. On-premise clients still connect locally. — [Integrations help](https://help.gitkraken.com/gitkraken-desktop/integrations/); [RN12](https://help.gitkraken.com/gitkraken-desktop/current/)
- Azure DevOps issues appear in Launchpad. — [Launchpad help](https://help.gitkraken.com/gitkraken-desktop/gitkraken-launchpad/)
- A "Git Integration for Jira" (GitKraken's Jira app) page also exists. — [llms-full index](https://help.gitkraken.com/llms-full.txt) (URL https://help.gitkraken.com/gitkraken-desktop/git-integration-for-jira/)
- GitHub Actions in the Left Panel was removed in 11.10.0. — [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/)
- SSO: Advanced has single-domain SSO; Business and Enterprise have multi-domain SSO and SAML; On-Prem has LDAP. — [PRICING](https://www.gitkraken.com/pricing); [git-client](https://www.gitkraken.com/git-client)
- GitKraken CLI (`gk`):
  - Free on all plans; available via Homebrew, winget, Snap and npm.
  - Commands: `gk auth`, `gk organization`, `gk provider` (GitHub, GitLab, Bitbucket, Azure DevOps, Jira, Linear, Trello), PR and issue lists, AI commit messages, commit splitting, conflict help, JSON output.
  - Hosts the GitKraken MCP server used by Claude Code, Cursor and Copilot. Agent hooks feed live session status into Desktop, GitLens and Kepler.
  - AI features need a paid plan.
  — [CLI help](https://help.gitkraken.com/cli/cli-home/)
  - MCP via CLI was introduced alongside Desktop 11.2.0. — [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/)
- Insights:
  - DORA metrics; PR flow (pickup and cycle time, review load); code quality (churn, hotspots).
  - AI impact (adoption, cost and ROI per tool or model); repo AI-readiness scores; developer sentiment surveys.
  - Sources: GitHub, GitLab, Jira, Linear, VS Code, Cursor, Claude Code, Copilot.
  - Web-based; moved from Desktop to gitkraken.dev in 10.4.0.
  — [Insights](https://www.gitkraken.com/insights); [RN10](https://help.gitkraken.com/gitkraken-desktop/10x/)
  - Workspace Insights: PR merge history and trends for GitHub.com, Bitbucket.org, GitLab.com and Azure DevOps. — [Workspaces help](https://help.gitkraken.com/gitkraken-desktop/workspaces/)
- Platform also includes Kepler (an agent development environment with tasks) and GitLens (VS Code). — [PRICING](https://www.gitkraken.com/pricing)

### Inferences
- The "platform" direction is moving review, insights and account management to web (gitkraken.dev), with Desktop as a Git GUI plus a coding-agent orchestrator.

### Gaps
- No Desktop help page for Azure Boards as a separate issue tracker was found; Azure DevOps covers it. No Desktop Linear integration was found.

---

## Q7. Performance for large repos and techniques

### Takeaway
GitKraken relies on:
- graph windowing (an initial commit count, default 2,000, minimum 500) with lazy loading;
- a move to the native git CLI with background `git maintenance`;
- shallow and sparse checkout;
- user-side mitigations (disable auto-fetch, prune branches and LFS).

Its headline claims (from 11.5.0) are up to 480% faster large-repo open, 100x faster stash loading and 20% less RAM.

### Cited Findings
- Preferences > General: "Initial Commits in Graph" (minimum 500), "Lazy Load Commits in Graph" (loads more only as needed), and "Show All Commits in Graph" (can slow large repos). — [Preferences help](https://help.gitkraken.com/gitkraken-desktop/preferences/)
- The default graph depth is 2,000 commits; search covers only loaded commits. — [Search help](https://help.gitkraken.com/gitkraken-desktop/search/)
- 11.5.0 claims faster commits and checkouts, faster branch and tag refresh, up to 480% faster opening of large repos via background git maintenance, up to 100x faster stash loading and up to 20% less RAM. "Most performance gains require" the Git Executable. — [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/)
- "Perform Repo Maintenance" in the Command Palette runs `git maintenance run` (10.4.0); 10.4.0 also reduced data preloading after startup. — [RN10](https://help.gitkraken.com/gitkraken-desktop/10x/)
- Troubleshooting guidance: run repo maintenance, set auto-fetch to 0, lower Max Commits in Graph, delete local branches, LFS prune, re-clone. An 11.5.1 macOS note warns about Intel vs Apple Silicon build mismatch. — [Performance help](https://help.gitkraken.com/gitkraken-desktop/performance-issues/)
- Shallow clones (11.6–12.0) and sparse checkout (11.10) are positioned for large repos and monorepos. — [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/); [Clone docs (llms-full)](https://help.gitkraken.com/llms-full.txt)
- Since 12.7.0, Git operations use a Git executable instead of the built-in library. — [RN12](https://help.gitkraken.com/gitkraken-desktop/current/)
- Native ARM builds for Linux and Windows (11.8). The app is Electron (v41 as of 12.1). — [RN11](https://help.gitkraken.com/gitkraken-desktop/11x/); [RN12](https://help.gitkraken.com/gitkraken-desktop/current/)
- The marketing commit-graph page makes no quantitative large-repo claims. — [Commit Graph feature page](https://gitkraken.com/features/commit-graph)

### Inferences
- GitKraken's graph scalability rests on capping and lazily paging commits rather than virtualizing unlimited history. Search being limited to loaded commits suggests in-memory filtering of the loaded window.

### Gaps
- No public technical writeup was found on graph rendering internals (canvas vs DOM, virtualization). No independent benchmarks were found.

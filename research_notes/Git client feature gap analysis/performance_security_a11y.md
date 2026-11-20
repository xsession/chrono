# Git GUI client capabilities: large-repo performance, signing/identity, hooks/LFS/partial clone UX, accessibility (as of Nov 2026)

Scope note: this research used about 18 tool calls. Primary git-scm.com docs were fetched directly, and the git-maintenance page reports itself as last updated in Git **2.56.0**. Coverage of GUI clients is uneven. GitHub Desktop, GitKraken and VS Code have sourced findings. Fork, Sublime Merge and GitLens graph internals were **not** verified (see Gaps).

## 1. Performance: which git features a GUI should enable, and how leading clients handle huge repos

### Takeaway
A GUI backed by the git CLI gets most of its large-repo speed by making sure the repo has a **commit-graph (with generation numbers v2 and changed-path Bloom filters)** kept fresh by **`git maintenance`**, plus **builtin fsmonitor + untracked cache** for status, and **cone-mode sparse-checkout / sparse index** for monorepos. Scalar's config set is the best existing "recommended defaults" list. On the UI side, the only sourced client-side techniques are capping or lazy-loading graph commits (GitKraken) and running maintenance in the background.

### Cited Findings

**Commit-graph and generation numbers**
- The commit-graph file is a query index storing each commit's OID, root tree, date and first two parents. Octopus merges overflow into a second table. Parents are stored as row numbers, which gives constant-time parent lookup. Write it with `git commit-graph write --reachable`. `git gc --auto` and `git maintenance start` also write it, and `fetch.writeCommitGraph` enables writing on fetch — [GitHub Blog, "Git's database internals II"](https://github.blog/open-source/git/gits-database-internals-ii-commit-history-queries/)
- Generation numbers are a negative reachability index: if gen(A) < gen(B), A cannot reach B. v1 is the topological level. v2 is the "corrected commit date", which handles old commits that were merged recently. Recent Git uses v2, and `commitGraph.generationVersion` selects the version — [GitHub Blog](https://github.blog/open-source/git/gits-database-internals-ii-commit-history-queries/)
- `--topo-order` / `--graph` uses Kahn's algorithm, computed **incrementally**. An in-degree walk, ordered by generation number in a priority queue, alternates with an output walk, so Git computes only as much as it needs to emit the next N commits. Commit ranges `A..B` add a third walk — [GitHub Blog](https://github.blog/open-source/git/gits-database-internals-ii-commit-history-queries/)
- Linux kernel benchmarks, without vs. with commit-graph: `git log --graph -n 100 v5.19` 7.73s → 0.03s; `git rev-list --topo-order -n 100 v5.19` 6.88s → 0.02s; `git tag --contains v5.19~100` 7.34s → 0.04s; `git merge-base v5.0 v5.19` 2.59s → 0.24s — [GitHub Blog](https://github.blog/open-source/git/gits-database-internals-ii-commit-history-queries/)
- From the original patch series: `git rev-list --topo-order -100 HEAD` on Linux went 6.80s (no graph) → 0.77s (old graph) → 0.02s (generation-aware). Generation numbers can make `git merge-base A B` and `git log --topo-order A..B` *slower* than commit-date ordering — [lore.kernel.org patch thread](https://lore.kernel.org/git/865zxvgftq.fsf@gmail.com/T/); background in [Stolee, "Supercharging the Git commit-graph III: generations"](https://devblogs.microsoft.com/devops/supercharging-the-git-commit-graph-iii-generations/)

**git maintenance (Git 2.56 docs)**
- Tasks: `commit-graph`, `prefetch` (fetches into `refs/prefetch/` without updating remote-tracking branches), `gc`, `loose-objects`, `incremental-repack` (uses the multi-pack-index), `pack-refs`, `reflog-expire`, `rerere-gc`, `worktree-prune` — [git-maintenance](https://git-scm.com/docs/git-maintenance)
- Commands: `git maintenance register | start [--scheduler=auto|crontab|systemd-timer|launchctl|schtasks] | run [--auto] [--task=<t>] [--schedule=hourly|daily|weekly] | is-needed --auto | stop | unregister`. `register` sets `maintenance.auto=false` — [git-maintenance](https://git-scm.com/docs/git-maintenance)
- `maintenance.strategy`: `none`, `gc`, `geometric` (recommended for large repos and the default for manual maintenance, a full replacement for gc), `incremental`. The `incremental` schedule runs commit-graph and prefetch hourly, loose-objects and incremental-repack daily, and pack-refs weekly, with gc disabled — [git-maintenance](https://git-scm.com/docs/git-maintenance)
- Thresholds: `maintenance.commit-graph.auto` (100), `maintenance.loose-objects.auto` (100), `maintenance.incremental-repack.auto` (10), `maintenance.geometric-repack.auto` (6700), `maintenance.geometric-repack.splitFactor` (2), `maintenance.autoDetach`. For each `*.auto` key, 0 disables the task under `--auto` and a negative value forces it every time — [git-maintenance](https://git-scm.com/docs/git-maintenance)

**fsmonitor (builtin daemon)**
- Enable with `git config core.fsmonitor true`. Commands such as `git status` then query the daemon over IPC and auto-start it. Management commands: `git fsmonitor--daemon start|run|stop|status`. `status` exits 0 if a daemon is watching, which suits a GUI health indicator — [git-fsmonitor--daemon](https://git-scm.com/docs/git-fsmonitor--daemon)
- Linux uses inotify. The default `max_user_watches` (often 8192) can be exceeded by large repos, and the fix is `sysctl fs.inotify.max_user_watches=...`. Network mounts are refused unless `fsmonitor.allowRemote=true`, which is experimental. `fsmonitor.socketDir` sets the socket directory. The daemon is not submodule-aware — [git-fsmonitor--daemon](https://git-scm.com/docs/git-fsmonitor--daemon)

**Scalar as the "recommended config" reference**
- `scalar clone` / `scalar register` set: `index.version=4`, `index.threads=true`, `index.skipHash=true`, `core.untrackedCache=true` (false on Windows), `commitGraph.changedPaths=true` (Bloom filters for file history), `commitGraph.generationVersion=1` (for compatibility), `fetch.writeCommitGraph=false` (moved to background maintenance), `gc.auto=0`, `fetch.unpackLimit=1`, `fetch.showForcedUpdates=false`, `pack.useBitmaps=false` (client side), `pack.usePathWalk=true`, `status.aheadBehind=false`, `log.excludeDecoration=refs/prefetch/*`, `core.logAllRefUpdates=true`. `scalar reconfigure --all` reapplies them after upgrades — [scalar](https://git-scm.com/docs/scalar)
- `scalar clone` defaults to sparse-checkout (top-level files only) and fetches only commits and trees. Options: `--full-clone`, `--no-src`, `--[no-]single-branch`, `--branch`, `--[no-]tags`, `--[no-]maintenance` — [scalar](https://git-scm.com/docs/scalar)

**Sparse-checkout / sparse index**
- Cone mode, the default, takes directories and uses hash-based matching. Non-cone mode costs O(N×M), is deprecated, and is effectively incompatible with sparse index. Commands: `set` (replaces the deprecated `init`), `add`, `list`, `reapply`, `disable`, `clean` (cone mode only, `--dry-run`), `check-rules [-z]` — [git-sparse-checkout](https://git-scm.com/docs/git-sparse-checkout)
- Sparse index: `git sparse-checkout set --sparse-index` or `index.sparse=true` shrinks the index to speed up `status` and `add`. It is still marked experimental. External tools and older Git may not understand it — [git-sparse-checkout](https://git-scm.com/docs/git-sparse-checkout)

**Client behaviour**
- GitKraken: "Max/Initial Commits in Graph" (Preferences > General) limits how many commits the graph renders. Auto-Fetch Interval=0 turns off background fetch. Solo/Hide branches reduces graph complexity. "Perform Repo Maintenance" in the Command Palette runs `git maintenance run` and can take minutes. The help page also recommends LFS prune and deleting stale branches — [GitKraken help: performance issues](https://help.gitkraken.com/gitkraken-desktop/performance-issues/)
- GitKraken v8.6 lets users cap the graph at as few as 500 commits — [GitKraken blog v8.6](https://gitkraken.com/blog/gitkraken-client-v8-6). GitKraken 9.13.0 added a preference to turn off commit **lazy loading** in the graph, a secondary source — [Softpedia changelog](https://www.softpedia.com/progChangelog/GitKraken-Changelog-251357.html)
- GitKraken Desktop 11.5 claims up to 5x faster repo opening, partly from background maintenance after open — [GitKraken blog 11.5](https://www.gitkraken.com/blog/gitkraken-desktop-11-5-we-fixed-what-mattered-most), vendor claim
- A known pathology: GitKraken hangs for minutes on commits touching more than about 10k files, including at startup if such a commit is HEAD — [GitKraken feedback](https://feedback.gitkraken.com/suggestions/221522/improve-performance-for-very-large-commits)

### Inferences
- For a Node backend, a repo-health step on open should check `git config core.commitGraph`, whether `.git/objects/info/commit-graph*` exists, and `git maintenance` registration. It should offer one-click `git maintenance register` / `git maintenance start` and `git config core.fsmonitor true` / `core.untrackedCache true`. Scalar's list is a defensible preset.
- Graph loading should page with `git log --topo-order -n <page> --skip` or keyset-style `^<lastOid>`. With a commit-graph the first page is O(page) rather than O(history), per the incremental Kahn walk. Avoid `A..B` topo queries for the main graph, since they are slower with generation numbers.
- Avoid `status.aheadBehind` costs on huge repos by fetching ahead/behind separately and lazily (`git rev-list --left-right --count`). Hide `refs/prefetch/*` from decorations.
- Status refresh: the inferred pattern is to prefer fsmonitor-backed `git status --porcelain=v2 -z` over a Node file watcher plus full status, or to debounce a watcher that triggers only the fsmonitor-accelerated status.

### Gaps
- No primary source was found on **Fork, Sublime Merge, GitHub Desktop or GitLens graph rendering internals** (virtualization, canvas or WebGL). No GitLens 17.x Commit Graph technical write-up was fetched (blog: [GitLens 17.1](https://gitkraken.com/blog/gitlens-17-1-visual-history-reimagined), not read).
- **Partial clone** (`--filter=blob:none`, `--filter=tree:0`) and **bitmap indexes** were not verified from a fetched primary doc in this pass. Scalar sets `pack.useBitmaps=false` client side and fetches commits and trees only, which implies a blobless partial clone, but the Scalar page does not name the filter.
- VS Code large-repo settings (`git.autorefresh`, `git.untrackedChanges`, the "too many changes" threshold) were not found on the fetched FAQ page.
- The changes in each Git 2.5x release (2.50–2.56) were not enumerated.

## 2. Commit signing and identity management

### Takeaway
Git supports three signing backends through `gpg.format` (`openpgp` | `x509` | `ssh`). Verification status is exposed per commit through `%G?` and related pretty-format placeholders, which a GUI can parse to draw badges. "Verified" on GitHub or GitLab is a host-side status, separate from local verification. SSH verification needs `gpg.ssh.allowedSignersFile`.

### Cited Findings
- `gpg.format` defaults to `openpgp`, with alternatives `x509` and `ssh`. `gpg.<format>.program` defaults to `gpg`, `gpgsm` for x509, and `ssh-keygen` for ssh. `gpg.program` is a legacy synonym for `gpg.openpgp.program` — [Git docs config/gpg](https://raw.githubusercontent.com/git/git/master/Documentation/config/gpg.adoc)
- `gpg.minTrustLevel` levels are undefined < never < marginal < fully < ultimate. By default merges need `marginal` and other operations need `undefined` — [config/gpg](https://raw.githubusercontent.com/git/git/master/Documentation/config/gpg.adoc)
- `gpg.ssh.defaultKeyCommand` runs when `user.signingkey` is unset and must print `key::<ssh pubkey>`. This works with ssh-agent and 1Password-style setups — [config/gpg](https://raw.githubusercontent.com/git/git/master/Documentation/config/gpg.adoc)
- `gpg.ssh.allowedSignersFile` lines are `<principals> <key>`. A listed key gets trust `fully`, and an unlisted key gets `undefined`, which makes verify-commit/tag fail. `valid-after` / `valid-before` (OpenSSH ≥ 8.8) allow key rotation, though the timestamp is signer-chosen and not a security guarantee. `cert-authority` keys are accepted. `gpg.ssh.revocationFile` (a KRL or key list) forces trust `never` — [config/gpg](https://raw.githubusercontent.com/git/git/master/Documentation/config/gpg.adoc)
- Pretty-format placeholders: `%G?` returns G good, B bad, U good with unknown validity, X expired signature, Y expired key, R revoked key, E cannot check (e.g. missing key), or N none. Also `%GS` signer, `%GK` key, `%GF` fingerprint, `%GP` primary key fingerprint, `%GT` trust level, `%GG` raw message. Example: `git log --pretty=format:'%h %G? %GS %GK'` — [pretty-formats](https://git-scm.com/docs/pretty-formats)
- Per-directory, per-branch or per-remote identity via conditional includes: `[includeIf "gitdir:~/work/"]`, `gitdir/i:`, `onbranch:<glob>` (a trailing `/` implies `/**`), and `hasconfig:remote.*.url:<glob>`. Files included through `hasconfig` may not themselves contain remote URLs — [git-config](https://git-scm.com/docs/git-config)
- GitKraken: SSH signing requires the "Git Executable" mode. Preferences > Commit Signing lets the user set GPG Format to SSH, pick a `.pub` key and create an allowed_signers file. GitKraken writes these settings into `.gitconfig` and sets the SSH program to `ssh-keygen` on macOS and Linux. Signed commits show a badge next to the SHA, and hovering shows signature details — [GitKraken help: commit signing](https://help.gitkraken.com/gitkraken-desktop/commit-signing-with-gpg/)
- A user report says GitKraken rewrites repo GPG config when the user switches profiles. This is unconfirmed — [GitKraken feedback: SSH signing](https://feedback.gitkraken.com/suggestions/232866/ssh-signing)
- GitHub shows "Verified" or "Partially verified" for valid GPG, SSH or S/MIME signatures, a host-side determination — [GitHub Docs: about commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification). GitLab requires the signing SSH key to be registered with usage type "Authentication & Signing" or "Signing" — [GitLab docs](https://docs.gitlab.com/user/project/repository/signed_commits/ssh)
- Git Credential Manager supports Azure DevOps (and Server), Bitbucket, GitHub (incl. GHES) and GitLab over HTTP(S) on Windows 10+, macOS 14+ and .NET-supported Linux. It offers generic OAuth and Entra broker auth. GCM 3.x is the current major line. SSH remotes are out of scope — [git-credential-manager README](https://github.com/git-ecosystem/git-credential-manager)

### Inferences
- Badge logic: map `%G?` to UI states such as G → "Verified (local)", U → "Signed, unknown trust", B/R → error, X/Y → warning, E → "Can't verify (missing key/allowed signers)", N → none. Batch it in the log call (`--format=...%G?%x00%GS%x00%GK`). Computing `%G?` spawns gpg or ssh-keygen per signed commit, so the inferred approach is to compute it lazily for visible rows only.
- Identity profiles can be implemented as generated includeIf files, `~/.gitconfig` → `[includeIf "gitdir:..."] path=profile-X.inc`, holding `user.name`, `user.email`, `user.signingkey`, `gpg.format` and `commit.gpgSign`. This avoids GitKraken's reported problem of rewriting repo config on every profile switch.

### Gaps
- The `commit.gpgSign`, `tag.gpgSign` and `user.signingKey` entries were not quoted from a fetched page in this pass (git-config is very long), but they are standard keys.
- GCM Linux credential stores (`credential.credentialStore` = secretservice/gpg/cache/plaintext) are documented in `docs/credstores.md`, which was not fetched.
- No sourced findings on SSH-agent handling in GUIs (e.g. Windows OpenSSH agent vs Pageant), or on X.509/gpgsm UX in any client.

## 3. Hooks, LFS and partial clone UX

### Takeaway
GitHub Desktop 3.5.5 (Feb 2026) is the clearest reference design for hooks. It runs hooks as an opt-in setting, uses the user's shell environment, streams colored output in real time, and offers a bypass both before the commit and after a failure, with an explicit warning that the bypass equals `--no-verify`. Sourced material on LFS lock UIs and partial-clone UX was thin.

### Cited Findings
- GitHub Desktop 3.5.5 (2026-02-18) added Git hooks support, enabled under Settings/Options > Git > Hooks. Hooks run with environment variables from the user's shell configuration, so version-manager tools work, and output streams in real time with terminal colors — [GitHub changelog](https://github.blog/changelog/2026-02-18-github-desktop-3-5-5-adds-git-hooks-support)
- Bypass in Desktop works two ways: the gear icon next to the commit message before committing, or "proceed anyway" after a hook fails. The docs equate it to `git commit --no-verify` and warn that it overrides team quality and safety checks — [GitHub Docs: working with Git hooks in GitHub Desktop](https://docs.github.com/en/desktop/making-changes-in-a-branch/working-with-git-hooks-in-github-desktop)
- GitKraken recommends LFS prune for large-repo performance — [GitKraken help](https://help.gitkraken.com/gitkraken-desktop/performance-issues/). LFS performance is a recurring user request — [GitKraken feedback](https://feedback.gitkraken.com/suggestions/196652/comment/396848)
- `git maintenance` prefetch writes to `refs/prefetch/` without touching remote-tracking branches, and Scalar hides these refs with `log.excludeDecoration=refs/prefetch/*` — [git-maintenance](https://git-scm.com/docs/git-maintenance); [scalar](https://git-scm.com/docs/scalar)
- Sparse-checkout `reapply` is needed after merge or rebase materializes out-of-cone files. `clean` removes leftover untracked files outside the cone, and `check-rules` tells the user whether a path is in or out — [git-sparse-checkout](https://git-scm.com/docs/git-sparse-checkout)

### Inferences
- Hook UX for a Node/React client: spawn `git commit` with a login-shell-derived env, stream stdout and stderr through an ANSI-to-HTML converter into a live panel, show the failing hook name and exit code, and offer "Commit anyway (--no-verify)" with a warning. Keep the bypass per-commit, not sticky.
- Sparse UX: a "files outside sparse cone" indicator can use `git sparse-checkout check-rules -z`, and a "Reapply sparse rules" action can follow merges.

### Gaps
- No fetched source for LFS **lock/unlock/track UIs** in Fork, GitKraken, Sublime Merge or GitHub Desktop (`git lfs lock`, `git lfs locks --json`, `git lfs track`). Implementers should consult git-lfs docs directly.
- No fetched source for partial-clone UX: on-demand blob fetch during diff or blame, progress display, promisor remotes.
- Coverage of how GitKraken, Fork, VS Code or Sublime Merge surface pre-commit output was not verified, apart from VS Code's `git.allowNoVerifyCommit`, whose name was not confirmed on the fetched page.

## 4. Accessibility

### Takeaway
GitHub Desktop's ACR (updated 8 Sep 2026) claims full WCAG 2.2 A/AA support. That conflicts with earlier versions of the same report and with search snippets showing "partially supports" keyboard items, so treat the claim cautiously. VS Code's Accessible Diff Viewer (F7/Shift+F7) is the best documented screen-reader pattern for diffs. Desktop added non-color cues to diffs (checkmarks for selected lines) and underlined links in 3.4.

### Cited Findings
- GitHub Desktop ACR: WCAG 2.2 Level A and AA, last updated **September 8, 2026**. All criteria are marked "Supports" with blank remarks, including 1.4.1 Use of Color, 1.4.3 Contrast, 1.4.11 Non-text Contrast, 2.1.1 Keyboard and 4.1.2 Name, Role, Value. It was tested with keyboard-only use, JAWS and NVDA, axe, Colour Contrast Analyzer, and high contrast and zoom — [GitHub ACR for Desktop](https://accessibility.github.com/conformance/desktop-github-com)
  - Conflict: a search-result snippet of the same URL (likely an earlier revision) rated keyboard support "partially supports". It cited tooltips not reachable by keyboard and the diff search field not announcing highlighted results. The current page's blank remarks alongside a claim of "outstanding issues" suggests it may be incomplete.
- Desktop 3.4 underlined links by default and used **checkmarks** in diffs to show whether a line is selected for commit (non-color cue). Earlier releases made co-author add/remove and commit reordering keyboard accessible (3.3.14) and fixed screen reader support for warning dialogs — [GitHub changelog: accessibility label](https://github.blog/changelog/label/accessibility); [GitHub changelog: desktop label](https://github.blog/changelog/label/desktop); [Desktop release notes](https://desktop.github.com/release-notes)
- VS Code Accessible Diff Viewer: F7 / Shift+F7 in the diff editor shows a unified patch view. Up and Down move through unchanged, inserted and deleted lines, Enter jumps to the line in the modified pane, and Escape dismisses — [VS Code accessibility docs](https://code.visualstudio.com/docs/configure/accessibility/accessibility)
- VS Code also offers Accessible View (Alt+F2, Shift+Alt+F2 on Linux, ⌥F2 on macOS), Accessibility Help (Alt+F1), screen reader optimized mode (`editor.accessibilitySupport` = on|off|auto, tested with NVDA, JAWS, VoiceOver and Orca), `accessibility.signals.*` audio cues, F6/Shift+F6 to move between parts, and High Contrast themes — [VS Code accessibility docs](https://code.visualstudio.com/docs/configure/accessibility/accessibility)
- GitHub describes its component-level accessibility work in Primer — [GitHub Blog: inclusive components](https://github.blog/engineering/user-experience/how-were-building-more-inclusive-and-accessible-components-at-github/)

### Inferences
- For a React graph, the inferred approach is to render the visual graph in canvas or SVG with `aria-hidden` and pair it with a virtualized `role="grid"` or `role="treegrid"` list of commits. Each row would carry an accessible name built from text such as "merge commit, 2 parents, branch main, signed: verified". Lanes should not rely on color alone (WCAG 1.4.1): add lane glyphs or shapes, ref labels, and a colorblind-safe palette with 3:1 non-text contrast (1.4.11).
- Diff views: copy VS Code's pattern of an alternate linear "accessible diff" list announcing "inserted/deleted/unchanged line N". Use +/− glyphs and checkmarks rather than red/green only, and support forced-colors / `prefers-contrast`.
- Virtualized lists must keep focus stable across scroll and refresh. Status refresh should announce changes through `aria-live="polite"` (4.1.3 Status Messages).

### Gaps
- No source found for GitKraken, Fork or Sublime Merge accessibility conformance, or for any client's colorblind-safe graph palette.
- No VS Code documentation specific to SCM-view accessibility (beyond the general features) was found on the fetched page.
- The earlier GitHub Desktop ACR revision with "partially supports" remarks could not be retrieved, so the conflict is unresolved.

# GitLens Deep Research — Functionality Inventory & Visualization Techniques

> Research basis: GitLens public docs (help.gitkraken.com), official release
> notes for v18.0 / v19.0 (Aug 2026), GitKraken product blog, VS Code
> marketplace listing, and open-source graph-rendering prior art (gitk,
> JGit `revplot`, Bitbucket-style lane algorithms, DAG layout literature).
> Clean-room: no GitLens source was copied — GitLens contains a separately
> licensed `plus` tree. This document is the implementation blueprint for
> the next Chrono wave and is also the TortoiseGit-replacement feature map.
>
> Companion doc: `GITLENS_CLEANROOM_FEATURE_RESEARCH.md` (v5 feature matrix,
> already implemented: rebase planner, rich search, compare, file/line
> history, blame, contributors, change stats).

## 1. Executive summary

GitLens 18/19 (2026) consolidated everything around **the Commit Graph as
the home/workbench**: history, working changes (one WIP row per worktree),
branches, tags, stashes, pull requests, comparisons, AI review/compose, and
rebase — all in one view with in-place detail "sheets". Three product
lessons for Chrono:

1. **Everything is in-place and keyboard-navigable.** Selecting a ref/commit
   opens a sheet; `Esc` backs out; `/` type-aheads to any branch/tag. No
   modal dialog chains.
2. **The graph says more per row** — multiple ref pills (with `+N` overflow),
   ahead/behind + unpushed/unpulled markers, change-size column with
   multiple visualizations (numbers / squares / bar / two-sided bar), WIP
   rows carrying a branch pill.
3. **Zoom-out visualizations answer "who/what/where" questions** that a
   commit list cannot: Visual History (file/repo evolution timeline), Files
   Treemap (size by file, colored by type), Commits Treemap (churn heatmap),
   Minimap (whole-history overview with scroll markers).

What Chrono already has (v5): interactive rebase planner, rich search
(`message:` `author:` `file:` `change:` `ref:` `commit:` `@me`), Search &
Compare with merge-base analysis, file history with rename follow, line
history (`-L`), full-file blame, contributors, change stats, commit file
diffs, worktree WIP rows, **repo browser/export, tags, merge, clean,
patch, working-tree diff, revision diff, commit activity** (this wave).

## 2. GitLens feature inventory (what to emulate)

### 2.1 Commit Graph (core surface)
| GitLens feature | Notes | Chrono status |
|---|---|---|
| Graph as main view | leads sidebar; columnar or compact list layout | ✓ History view |
| Live state per row | ahead/behind, unpushed/unpulled markers, HEAD/upstream/merge-target indicators | partial: HEAD pill, ahead/behind counts in header |
| Multiple ref pills per row | `refs.maxInline` (1 / "auto"), `refs.layout` (beside / stacked) | ✓ pills (stacked) |
| WIP row per worktree | branch pill on the WIP row; click jumps to tip/upstream/merge-target | ✓ worktree WIP rows |
| Lane folding | collapse stretches of history between refs | ✗ — roadmap (elided-row separators exist) |
| Changes column visualizations | numbers, squares, bar, two-sided bar; compact as column narrows | ✓ numbers; bar/squares = roadmap |
| Column resizing | every column user-resizable | ✓ graph column (drag handle) |
| Scroll markers | checked-out branches, selected row, search matches on the scrollbar | ✗ — roadmap |
| Minimap (experimental) | hidden by default, shown while searching; left=newest; ref/HEAD/stash color markers | ✗ — roadmap (nice-to-have) |
| Type-ahead reference finder | press `/`, type, `↑↓` to step; abbreviated paths (`d/f/foo`) | ✗ — roadmap (high value, cheap) |
| Branch/tag detail sheet | tracking status, PRs/issues, sync/rebase/merge actions; tag sheet compares against previous tag | ✗ — roadmap (branch sheet is cheap: upstream + ahead/behind + compare-with-base actions) |
| Focus Branch | scope graph to one branch's history | ✓ persisted all/current/local-branch scope; full per-ref hide/solo remains roadmap |
| Graph visibility toggles | current branch only / all local / remote-only / tags / stashes / dim merges | partial: Changes toggle; ref visibility = roadmap |
| Full context menus | right-click commit/branch/tag/author: compare, branch, merge, rebase, cherry-pick, revert, stash, push | ✗ — roadmap (big UX win) |

### 2.2 Rich commit search
`Commit:`, `Message:`, `Author:`, `File:`, `Change:` (search inside diff),
`@me`, plus (v19): `Committer:`, `Type:merge`, negation `-message:`.
F3 / Shift+F3 step between matches; match-all / match-case / regex toggles;
natural-language mode ("only show …", "take me to …") with repo-aware name
resolution and counted broader alternatives on empty results.

Chrono: ✓ first six prefixes; **add `type:merge` and negation operators**
(cheap), **add `change:` diff-text search** (needs `git log -S`/`-G` —
medium), match-case toggle.

### 2.3 Compare
- Compare any two refs (branch/tag/commit/working tree) with
  **common-base** variants: "compare with common base" shows what a merge
  would bring; Ahead / Behind / All Files tabs.
- Working-tree compare against a ref.
- Pinned comparisons persisted; shareable link (editor-only).

Chrono: ✓ `compare_refs` with merge-base analysis + file deltas + unique
commits. **Add working-tree-vs-ref** (uses `git diff <ref> --stat`) and a
**two-sided bar per file** in the compare file list.

### 2.4 Blame & annotations
- Inline current-line blame, status-bar blame, rich hovers.
- File annotations: whole-file blame, recent-changes, **heatmap** rendered
  in the editor gutter.
- Revision navigation: step back/forward through a file's history.
- File history & line history with rename following.

Chrono: ✓ full-file blame + file/line history in Git Intelligence.
**Add the blame heatmap** (color each line by age: green=new → purple=old,
GitLens-style perceptual ramp) and **revision navigation buttons** (prev/
next version of file, view content at that commit) — this wave.

### 2.5 Visualizations (zoom-out)
1. **Visual History** — horizontal timeline of commits (repo or per-file):
   position = date, size = change magnitude, color = author; hover = commit
   details; click = open commit. The canonical "when did this change and
   who owns it" answer.
2. **Files Treemap (experimental)** — square-trisection treemap of the
   working tree; block area = file size; color = extension family; click
   folder to zoom in.
3. **Commits Treemap (experimental)** — same layout, area = total churn
   (additions+deletions) per path over the loaded history, optionally
   colored by top contributor → "where is all the churn / who to ask".
4. **Minimap** — one-pixel-per-commit strip, newest left, current viewport
   highlighted; colored tick rows for local/remote branches, tags, stashes;
   yellow ticks = search matches.

Chrono: **this wave ships a Visual History mini-timeline** (SVG, per-day
commit activity bars — `commit_activity` endpoint) in the History header
area and a **per-file churn heat strip** in Git Intelligence. Treemaps =
roadmap (d3-scale squarify, ~1 day).

### 2.6 Branch/tag/worktree/PR management
- Pin branches (persisted), jump-to-pinned.
- Tags: create annotated/lightweight, push tags, tag sheet with
  changelog since previous tag.
- Worktrees: create from branch/commit/PR, per-worktree WIP row, move WIP
  across worktrees, apply stash into another worktree, reveal in explorer.
- PRs (Pro): Launchpad triage list, in-graph review + merge/squash/rebase,
  stacked-PR support.

Chrono: ✓ worktree CRUD + WIP rows, stashes. **This wave: tags UI, merge
(no-ff/squash/ff-only), branch delete, clean untracked, export, patches.**
PR triage is now exposed through Git Intelligence: Chrono detects SSH/HTTPS
remotes, supports GitHub/GitLab/Gitea/Forgejo settings, filters normalized PRs
by state/query, and opens provider review pages. In-graph PR merge remains
roadmap because provider-specific mutation and permission semantics should be
explicit rather than hidden behind a generic button.

### 2.7 Rebase
Interactive editor with drag reorder, conflict pre-warning ("which commits
will conflict"), one conflict panel for all files, auto-undo. Automatic
(AI) rebase with confidence + rationale (Pro/AI).

Chrono: ✓ rebase planner with pick/reword/edit/squash/fixup/drop + reorder
+ merge-topology safety. **Add conflict pre-warning** = `git merge-tree`
dry-run per commit (medium, roadmap).

### 2.8 Repo maintenance ("Repository Health", v19 experimental)
Suggested optimizations as cards with meters: fetch depth, stale remote
refs, large files (filter-repo candidates), unreachable objects; "Run
Maintenance Now".

Chrono: **cheap partial** — Recovery & tools already covers fsck/lost
found. Roadmap: `git count-objects -v` + `git count-objects -vH` meter card.

### 2.9 Not ported (deliberately)
AI Compose/Review/Resolve, agent-session tracking, Launchpad, GitKraken MCP
— require an AI backend or Pro account; outside Chrono's clean-room scope.

## 3. Commit-graph visualization techniques (prior art)

### 3.1 The lane-allocation problem
A commit DAG rendered top-down needs each "branch" (chain of first-parents)
a horizontal lane. Classic approaches:

- **gitk** (Tcl): greedy — keep a stack of open lanes; a commit's first
  parent keeps the lane, extra parents take the next free lane; on merge,
  children's lanes may swap to reduce crossings. Simple, O(n), good enough
  for most repos; crossings occur on complex histories.
- **JGit `PlotWalk` / `PlotLane`** (`org.eclipse.jgit.revplot`): same
  greedy idea with explicit lane reuse, used by EGit's GitHistory view;
  lanes are assigned per-parent, and a merge commit claims its first
  parent's lane.
- **Bitbucket/GitHub-style** (e.g. `tclh123/commits-graph`, GitKraken's
  pre-19 renderer): precompute per-node routes `[fromX, toX, lane]` for the
  next row, draw dot + routes top-down. What Chrono's `src/graph.ts`
  already implements (per-row SVG, LANE_W=19).
- **True crossing minimization**: Sugiyama hierarchical layout (layering →
  crossing reduction by barycenter median sweeps → coordinate assignment)
  or graphviz `dot`. Overkill for a git log (already layered by commit
  order); barycenter sweeps can post-process lane order but Chrono's greedy
  lane assignment is standard and matches user expectations (gitk/GitHub).

Key correctness rules (Chrono `graph.ts` complies):
- lane for a commit = lane of its first parent, else lowest free lane;
- a merge commit draws a connector from each parent lane into its node;
- lanes are released when no future commit needs them (scan backward to
  horizon, `ROW_H` must equal the CSS row height or verticals break at row
  boundaries — see `ROW_H` note in `src/graph.ts`).

### 3.2 Continuity & overlap (lessons already applied to Chrono)
- **Row-height parity**: per-row SVG segments tile the column only when
  SVG height == rendered row height (38px in Chrono). Any mismatch creates
  gaps that read as broken lanes.
- **Column sizing**: the graph column must be sized to `13 + lanes*19`
  (or user-resized wider, SVG pinned left) or wide graphs overflow onto
  text columns.
- **Color**: GitLens v19 moved to *perceptually uniform* lane colors; keep
  ≤10 lanes distinctly hue-separated, dim merge-only lanes, and give HEAD
  lane a fixed strong color.
- **Lane folding** (GitLens v19): when a stretch of history contains no
  ref of interest and no merges, collapse it to a small "N commits" pill
  and reconnect lanes with a straight dashed vertical. Implementation: in
  `layoutGraph`, detect runs where (a) no row has a pill/HEAD, (b) each row
  has ≤1 parent, (c) lane count is constant → replace run by one elided
  row; Chrono's elided-row separators are the same mechanism, just
  filter-driven.
- **Crossing reduction cheap win**: when a commit takes a non-first parent
  lane that is *right of* its first-parent lane but a left lane would keep
  the same merge connectivity, prefer the leftmost (gitk's swap). Optional;
  measure before doing.

### 3.3 Rendering scale
Per-row inline SVG (Chrono) is fine to a few thousand rows; beyond that:
- virtualize rows (only render visible ±overscan);
- or render the whole graph column as one tall SVG with a
  `transform: translateY` per scroll (one element, GPU-friendly).
GitLens v19's "rewritten rendering engine" targeted exactly this.

### 3.4 Visual History technique
- X axis = time (linear, or sqrt to compress old clusters); Y = one band
  per author (or single band).
- Markers = circles, radius ∝ `sqrt(additions+deletitions)`, color = author
  palette; on file scope, reuse the same with `git log --follow --numstat`.
- Implement with plain SVG (no d3 needed for <2k commits). Chrono's
  `commit_activity` (per-day counts) renders as bars — same axis, zero
  per-commit cost; the per-commit dot version reuses loaded history.

### 3.5 Treemap technique (roadmap)
Squarified treemap (Bruls et al. 2000) — the d3-hierarchy `squarify`
algorithm, ~100 lines, no dependencies if reimplemented. Data source is
`git ls-tree -r` (size view) or accumulated `numstat` over loaded history
(churn view). Click-through = drill into folder (re-run squarify on
children). Color: extension → hue (e.g. code=blue, data=green, binary=gray,
docs=orange).

### 3.6 Heatmap technique (GitLens file annotation)
Line age = (now − author date of last commit touching line) from `git blame
--line-porcelain`. Map age→color with a 5-stop ramp (new #0ec251 →
old #9333ea, matching GitLens's green→purple). Render as 3px gutter
rects per line, or as row background tint in the diff/file viewer.
Performance: blame is O(file); throttle to visible viewport for >2k-line
files.

## 4. TortoiseGit parity checklist (replacement scope)

TortoiseGit = shell-integrated Git GUI. Its menu surface mapped to Chrono:

| TortoiseGit action | Chrono target | Status |
|---|---|---|
| Commit… (stage/commit dialog) | Changes view | ✓ |
| Pull / Fetch / Push | header buttons + workflow | ✓ |
| Diff (working vs index vs HEAD, file-level) | **workingTreeDiff + commit file diff** | ✓ this wave (working-tree diff in Changes view) |
| Diff with… (two revisions) | **diffRevisions** | ✓ this wave (Compare) |
| Log | History + commit inspector | ✓ |
| Show log for (file/line) | file/line history | ✓ v5 |
| Blame (annotate) | blame view | ✓ v5 |
| Repo-browser | **RepoBrowser view** | ✓ this wave |
| Export… (working tree or rev → folder) | **export_revision** | ✓ this wave |
| Merge (branch, no-ff/squash/ff) | **merge_branch** | ✓ this wave |
| Branch (create/delete/switch/force-delete) | Branches + workflow | ✓ + delete this wave |
| Tag (annotate/tag) | **list/create/delete tag** | ✓ this wave |
| Clean up (untracked/unused, dry run) | **cleanUntracked dryRun** | ✓ this wave |
| Create/Patch (apply, reverse) | **createPatch/applyPatch** | ✓ this wave |
| Stash (save/apply/drop) | Stashes | ✓ |
| Rebase (interactive) | Rebase planner | ✓ |
| Cherry-pick / Revert | workflow | ✓ |
| Resolve conflicts | Conflict Center | ✓ |
| Worktree (add/remove) | Worktrees | ✓ |
| Clone / Submodule (init/update) | Clone dialog / Submodules | ✓ |
| Repository maintenance (gc/fsck/prune) | Recovery & tools | ✓ |
| Settings (ignore patterns, aliases) | settings view | partial — ignore patterns roadmap |

Shell-integration-only features (no in-app equivalent; out of scope):
context-menu launch, diff viewer hand-off to external tools (Chrono offers
in-app diff), auto-caching of repo state.

## 5. Implementation plan (this wave → roadmap)

**This wave (implemented alongside this doc):**
1. `server/src/repo.ts`: listTags/createTag/deleteTag, mergeBranch
   (no-ff/squash/ff-only), workingTreeDiff, cleanUntracked (dry run),
   listTree + fileAtRevision (repo browser), exportRevision,
   createPatch/applyPatch, commitActivity, diffRevisions, deleteBranch.
2. UI: RepoBrowser view (tree + file content + export), Tags section in
   Branches view, Merge/Clean/Patch/Export cards in Workflow (Recovery &
   tools), working-tree diff viewer in Changes view, branch delete.
3. Git Intelligence: blame heatmap (age ramp) + revision navigation
   (prev/next file version).
4. History: commit-activity timeline strip (Visual History lite).
5. Installer: Electron + electron-builder NSIS (`release/Chrono Setup
   X.Y.Z.exe`), auto-update channel (electron-updater), dev launcher.

**Roadmap (ordered by value/cost):**
1. Context menus on commits/refs (compare, branch, merge, cherry-pick,
   revert, tag) — biggest usability gap vs TortoiseGit.
2. Type-ahead reference finder (`/`).
3. Search: `type:merge`, negation `-message:`, `change:` (git -G/-S).
4. Branch detail sheet (upstream, ahead/behind, compare-with-base, pin).
5. Changes-column visualization modes (bar / two-sided bar / squares).
6. Lane folding.
7. Rebase conflict pre-warning (`git merge-tree` dry run).
8. Files/Commits treemaps (squarify).
9. Minimap with scroll markers.
10. Working-tree-vs-ref compare; repository-health meters.

## 6. Sources

- GitLens help: gitlens-features (search prefixes, scroll markers, minimap,
  repo browser actions) — https://help.gitkraken.com/gitlens/gitlens-features/
- GitLens 19.0.0 release notes (graph rewrite, lane folding, ref pills,
  WIP rows, tag sheets, natural-language search) —
  https://github.com/gitkraken/vscode-gitlens/releases/tag/v19.0.0
- GitLens 18.0.0 release notes (embedded details panel, compare/review/
  compose modes, Visual History, treemaps, agent sessions) —
  https://github.com/gitkraken/vscode-gitlens/releases/tag/v18.0.0
- GitKraken blog: "GitLens 19: Commit Graph, AI Agents…" —
  https://www.gitkraken.com/blog/gitlens-19-the-commit-graph-reimagined-for-parallel-development
- VS Code Marketplace listing (feature matrix, Community vs Pro split) —
  https://marketplace.visualstudio.com/items?itemName=eamodio.gitlens
- GitLens Commit Graph doc (column resizing, scroll markers, minimap
  legend) — https://help.gitkraken.com/gitlens/gl-commit-graph/
- JGit `org.eclipse.jgit.revplot` (PlotWalk/PlotLane API) — lane
  allocation prior art.
- tclh123/commits-graph (per-node route arrays, top-down canvas drawing).
- gitk manual (rev-list options feeding graph views, -L line tracing).
- Bruls et al., "Squarified Treemaps" (2000); Sugiyama layered DAG layout.

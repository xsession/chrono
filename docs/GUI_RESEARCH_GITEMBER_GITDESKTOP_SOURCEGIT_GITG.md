# Git GUI Deep-Dive Research — GitEmber · GitDesktop · SourceGit · gitg

Studied from source (pulled 2026-09-16, ~25 key files read in full):

| Project | Stack | Repo | Files studied |
|---|---|---|---|
| GitEmber | Java/Swing + JGit | github.com/iazarny/gitember | `CommitGraphRenderer`, `HistoryPanel`, `ScmPlotWalk`, `ScmPlotCommit`, handlers, service layer |
| GitDesktop | Rust/Tauri + React TS | github.com/theBGuy/GitDesktop | `git/history.rs`, `git/commit.rs`, `features/history/*` |
| SourceGit | C#/.NET + Avalonia | github.com/sourcegit-scm/sourcegit | `Models/CommitGraph.cs`, `Views/CommitGraph.cs`, `Commands/QueryCommits.cs` |
| gitg | Vala + GTK/libgit2 | gitlab.gnome.org/GNOME/gitg | `Lanes`, `gitg-lane`, `CellRendererLanes`, `CommitModel`, `history.vala`, `history-refs-list`, `diff-stat` |

Everything below is a technique verified in their code, with a "→ Chrono" note where it maps onto our architecture (React + Node git-CLI backend, `src/graph.ts` lane solver, one SVG per row).

---

## 1. Commit-graph layout algorithms

### 1.1 SourceGit — single-pass path solver with color recycling (`Models/CommitGraph.cs:74-269`)

The strongest reference implementation. `CommitGraph.Generate(commits, firstParentOnly, highlighting, extraCommits)`:

- Commits arrive in topological+time order. Maintain `unsolved: PathHelper[]` — each open path has `Next` (the SHA it expects to terminate at) and `LastX`.
- Per commit row: scan `unsolved` in lane order. **The first path with `Next == commit.SHA` becomes `major`** (the row's dot); every other path calls `Pass(x,y)` (continue straight, with an offset bump `offsetX += unitWidth` to avoid crossings). Paths that dead-end call `End`.
- If no unsolved path matches → new branch head: allocate `offsetX += unitWidth`, create a new path for `parents[0]`.
- Extra parents (merges): for each `parents[j>0]`, if an unsolved path already targets it → emit a **Link** (quadratic bezier from the row dot to that path's x at row+½). Otherwise spawn a new path.
- `Pass/Goto/End` implement the classic 2-segment "step" with a half-row vertical offset so two paths crossing in one row never overlap: `if (x > LastX) { Add(LastX, y-hh); Add(x, y-hh) } else { Add(LastX, y-hh); Add(x, y) }`.

**ColorPicker (lines 271-291)** — the detail that makes lanes readable:
- 10-color palette, held in a FIFO `Queue<int>`. New paths dequeue the next color; when a path ends, `Recycle(color)` puts it back. Colors therefore stay **bounded (≤10)** and **stable per lane lifetime** — a lane keeps its color across merges.

**Per-row text offset (line 252)** — the anti-overlap technique:
```csharp
commit.LeftMargin = Math.Max(offsetX, maxOffsetOld) + halfWidth + 2;
```
Every row carries its own `LeftMargin` = the furthest any lane reaches **in or above that row** (`maxOffsetOld` is the previous row's max reach). Text starts per-row right after the graph — no global fixed graph column width, so the text column is never wider than necessary and the graph can never paint over text. *This is the principled version of what we hacked with a global `graphColWidth`.*

**Highlighting (lines 81-186, 293-297)** — 5 modes, all cheap given the walk:
- `All`, `CurrentBranchOnly` (via `commit.IsMerged`), `SelectedCommitsOnly` (a `HashSet` of extra SHAs; when a commit is in the set, it's highlighted and **its first parent is re-added to the set** → the highlight walks the first-parent ancestry of whatever you click), `CurrentBranchAndSelectedCommits`, `SelectedCommitsOnlyFirstParent` (stops at first parent, side lanes gray).
- Highlight propagates to paths via `PathHelper.Highlight()`, which splits the polyline at that point into a new highlighted sub-path (same color) — so only the ancestor chain lights up, the rest of the lane stays dim.
- Unhighlighted paths render with a single `grayedPen` (40% gray, same thickness) — dimmed, not invisible.

### 1.2 gitg — lane containers with collapse + merge stealing (`libgitg/gitg-lanes.vala`)

A different model: the walker runs in a **background thread** (`CommitModel.walk`), and `Lanes.next(commit)` is called per commit as it's produced.

- `LaneContainer { from, to: OId, lane, inactive }` — `from`/`to` are commit OIDs, not positions. Position is only computed at render time.
- **Merge-lane stealing (`prepare_lanes`, lines 240-266)**: when a merge's first parent already owns a lane at `lnpos` and our mainline lane is at `pos < lnpos`, **the mainline takes over the parent's lane** and the other container is removed. Result: the mainline never jumps lanes at a merge → far fewer lanes, visually continuous trunk. (Standard gitk/JGit do the opposite-ish thing; this is why gitg's graph looks especially compact.)
- **Inactive-lane collapsing (lines 380-500)** — the standout feature:
  - Each container counts `inactive` rows without a stop on it. When `inactive == inactive_max + inactive_gap` (defaults 30+10, user-configurable via GSettings `collapse-inactive-lanes`), the lane is **removed and remembered as `CollapsedLane {color, index, from, to}`**; the rows above get a `LaneTag.END` with `boundary_id = container.to`.
  - `expand_lanes(next)`: before processing a commit, if any collapsed lane's `to == commit.id`, the lane is **re-inserted at its old index** and re-drawn over the last `inactive_collapse` (10) rows with a `LaneTag.START` + boundary dot.
  - A sliding window `d_previous` of `collapse+gap+1` commits (lines 315-321) backs the re-draw; all merge indices are renumbered on collapse/expand (`update_merge_indices`).
  - Render shows **chevron arrows at collapsed boundaries** (`CellRendererLanes.draw_arrow`, lines 79-98) so the user sees a lane continuing off-screen.
- **Out-of-order parent retry (`miss_commits`)**: if a commit's parent lane doesn't exist yet (rare in topo sort), the commit is parked in `miss_commits` and retried in a loop after each subsequent commit instead of being dropped.
- **Permanent/reserved lanes (`reset(reserved)`)**: pins (e.g. the current branch tip) get hidden containers pre-allocated so their lane index never moves — the current branch's line stays put across filter changes.

### 1.3 GitEmber — delegate to JGit's `RevPlot` (`CommitGraphRenderer.java`)

The pragmatic choice: **don't write a lane allocator, use JGit's `RevPlot`/`PlotWalk`** (the reference algorithm, battle-tested), and subclass `AbstractPlotRenderer<PlotLane, Color>` for pixels only:
- `drawLine`: vertical/horizontal → straight; diagonal → **cubic bezier** `CubicCurve2D(x1,y1, x1±10,y1, x2,y2, x2,y2)` with round caps/joins.
- `drawCommitDot`: filled ellipse + slightly larger stroked ellipse; **tips (childCount==0) use the darker shade of the lane color** so branch ends read as "alive".
- `drawBoundaryDot`: hollow dot with panel-background fill — marks the walk boundary (unfetched history).
- `drawLabel` (lines 91-131): ref labels **painted inside the graph column** — strips `refs/heads/`, `refs/remotes/`, `refs/tags/` prefixes, bold font one size smaller, rounded-rect box (radius 6) with theme-aware fill/stroke/text chosen by checking `Table.background` brightness. Returns `boxWidth + 6` so labels advance the lane area.
- `render()` returns the graph's pixel width (captured from `drawText`'s x) — the table cell sizes itself from that.

### 1.4 SourceGit view layer — viewport culling + smart beziers (`Views/CommitGraph.cs:73-147`)

The Avalonia `Control` renders the whole graph per frame but:
- `DrawCurves` skips any link/path whose Y-range doesn't intersect `[top, bottom]` (the visible viewport, supplied by the virtualizing parent) — `continue`/`break` culling.
- Lane steps are **quadratic beziers when moving right** (`ctx.QuadraticBezierTo(new Point(cur.X, last.Y), cur)`) and **cubic beziers with ±4px control offsets when moving left** (lines 137-147) — asymmetric curves that read as "pass behind" vs "come forward".
- Dots: `DotType` Head / Merge / Default with different radii/fills.
- **`commit.Color` is painted on the commit row itself** (the text gets the lane color as an accent in SourceGit's history rows) — a cheap way to tie a row to its lane without a colored bar.

### → Chrono: graph algorithm upgrade path (ranked)

Our `src/graph.ts` is a correct per-row lane solver (`LANE_W=19`, absolute SVG per row). In priority order:

1. **Per-row `LeftMargin`** (SourceGit §1.1): emit `row.textLeft` = max lane x-reach in/above the row; render each row's text block at that offset instead of a global `graphColWidth`. Kills wasted horizontal space on narrow parts of the history and makes the "lines cross the text" class of bug structurally impossible.
2. **Stable recycled colors** (SourceGit `ColorPicker`): assign colors from a FIFO pool with recycling on lane death, instead of color-by-lane-index (lane index drifts when lanes die/spawn → colors jump today).
3. **Highlight modes** (SourceGit §1.1): "current branch only" + "selected commit's first-parent chain" (click a commit → walk its first-parents, dim the rest). We already compute branch tips and first-parent per commit; this is rendering-only. Dim non-highlighted lanes to 40% gray, keep highlighted ones full color, split paths at the highlight boundary.
4. **Merge-lane stealing** (gitg §1.2): when the first parent already has a lane left of ours at a merge, take it over. Reduces lane count on merge-heavy repos (like `mp` with 12 lanes) and keeps the trunk straight.
5. **Inline ref labels in the graph column** (GitEmber `drawLabel`, gitg `LabelRenderer`): paint branch/tag names as small rounded boxes directly on the lane at the tip commit, prefix-stripped, theme-aware. GitKraken/GitLens both do this; we currently only show them in the References list.
6. **Inactive-lane collapse** (gitg §1.2) — later, for very long histories: collapse lanes idle >N rows, boundary arrows, re-expand on use. Big win only on 10k+ commit histories; moderate complexity (index renumbering).
7. **Viewport culling** (SourceGit §1.4): we already render one SVG per row so this is ~free; nothing to do until we move to a single canvas.
8. **Asymmetric bezier steps** (SourceGit §1.4 / GitEmber §1.3): right-steps quadratic, left-steps cubic with control offsets. Pure visual polish on `graph.ts` path emission.

---

## 2. History list layout & rendering

### 2.1 GitEmber — measured graph cell in a JTable (`HistoryPanel.java`)

- 3-column `JTable`: **[graph | 800 auto][author 180][date 170]**, `ROW_HEIGHT = 24` fixed, `AUTO_RESIZE_LAST_COLUMN`.
- `GraphCellRenderer` (lines 695-758): the cell **renders the commit into a 1-px-wide `BufferedImage` probe** to measure the real graph width, then `setPreferredSize(new Dimension(max(w+4, 20), ROW_HEIGHT))` — so the graph column is exactly as wide as its content, per row, and the message text (painted as an overlay label, `drawText` in the renderer ignores it) starts right after.
- Search field with a distinct "filtering" border (green line border) while active.
- `setRowHeight(24)` everywhere + `list-row-skeleton`-style loading placeholders (React side).

### 2.2 gitg — one cell paints lanes AND labels (`CellRendererLanes.vala`)

- `lane_width = 16`, `dot_width = 10` constants.
- **Top/bottom half rendering (lines 166-193)**: each row paints `draw_top_paths` using *this* commit's lanes and `draw_bottom_paths` using **the next commit's** lanes (`next_commit` is passed in by the view). That's how lines stay continuous across rows with a plain `Gtk.TreeView` cell: row N draws the first half of every segment and row N+1 draws the second half. No full-height SVG needed.
- Lane change curves: `curve_to(x1, y2, x2, y2, x2, y3)` — bezier from previous x at the half-row to new x at the row end (line 157-158).
- **Labels inside the cell (lines 226-244)**: after the lanes, ref labels are drawn at offset `num_visible_lanes * lane_width` with full RTL mirroring (`DirectionFunc f = a => rtl ? -a : a`). `get_preferred_width` (lines 65-77) = visible lanes × 16 + label widths → the tree column auto-sizes to the widest label. `get_ref_at_pos` makes labels hit-testable (click a label → jump to that ref).
- Arrows at `LaneTag.START/END` (collapsed boundaries), dot with black outline + lane-color fill (`draw_indicator`).

### 2.3 GitDesktop — React list conventions (`features/history/*`, `list-row-skeleton`)

- Fixed-height rows + `LoadMoreRow` (infinite scroll sentinel) instead of loading everything — pairs with the paged backend (below).
- Skeleton rows while loading (stable height, no layout shift).
- `CommitContextMenu` — rich per-commit actions (cherry-pick, revert, create branch/tag, copy hash…) from a single component.

### 2.4 gitg — user-visible columns + refs list UX

- **"Visible Columns" dialog** (`history.vala:870-891`): modal dialog of checkboxes per column (`CommitModelColumns` enum, `gitg-commit-model.vala:22-101`) — user toggles Subject/Author/Committer/Date…; column model is enum-driven with `type()`/`name()`.
- **Refs list (`history-refs-list.vala`)** — the reference for our RefsBrowser:
  - `Gtk.ListBox` of `RefHeader` (per type: LOCAL/REMOTE/TAGS/STASH, sortable, with an action icon) + `RefRow` (icon, name label, ahead/behind, op icon).
  - **`RefAnimation.ANIMATE`**: rows animate in/out on add/remove (branch created/checked-out → the row slides in; remote updated → the row morphs). Add and remove happen as an **animated swap pair** on rename (`add_ref_internal(old, ANIMATE)` + `add_ref_internal(new, ANIMATE)` at lines 1076-1077).
  - **Inline rename**: `RefRow.begin_editing(RefNameEditingDone callback)` — double-click turns the label into an editable entry in place.
  - Per-type action lists (`branches_actions`, `remotes_actions`, `tags_actions`, `stash_actions`) injected via the extension API → the right-side op icon changes per section; `filter_unknown_refs` hides refs that don't map to a local/remote.
  - `compare_to(other, SortOrder)` on both headers and rows for re-sorting.
- **Filter entry history (`gitg-entry-history.vala`)**: the history filter box is a `Gtk.Entry` with **completion of previously typed filters** (up/down arrows navigate, persisted to a per-app history file, `load_history`/`save_history`).

### → Chrono: list layout adoption

1. **Ref labels in the graph column** (from §1.4 item 5) is also the single biggest list-layout win — GitKraken/GitLens/gitg all put branch/tag badges on the graph, not in a separate panel.
2. **Animated refs rows + inline rename** (gitg): our RefsBrowser is static re-render; adding a 150ms slide/fade on section row add/remove and in-place branch rename is a small CSS+state change.
3. **Filter history completion**: persist last ~10 filter strings per view (localStorage), ↑/↓ in the filter input. ~30 lines.
4. **Toggleable columns**: History's Author/Date columns behind a small "columns" menu with localStorage persistence (we hard-code them in `ux.css`).
5. **Skeleton rows** for the initial history load (we currently show an empty state) — stable 38px rows.
6. **Load-more sentinel** if we ever raise the 300-commit cap (see §3.2).

---

## 3. Backend / git-command techniques

### 3.1 Paged history (GitDesktop `history.rs:20-59`)

- `git log -n <limit> --skip <skip> --format=<NUL-FORMAT>` — **offset paging**, trivially incremental for infinite scroll.
- Guard: `rev-parse --verify --quiet HEAD` first → unborn-HEAD repos return `[]`, never an error (applied to log, file log, and blame alike).
- Blame revs are resolved via `rev-parse --verify <rev>^{commit}` before use, with leading-`-` rejection.

### 3.2 NUL-delimited format strings (GitDesktop + SourceGit)

Both use `--format` with `%x00` field separators and never parse human output:
- GitDesktop: `%H%x00%s%x00%an%x00%ae%x00%cI%x00%D%x00%P` — `%cI` = **strict ISO committer date** (parseable, TZ-safe), `%D` = decorations (tags/branches in one field → free ref labels + merge detection via `%P` parent count > 1).
- SourceGit: `%H%x00%P%x00%D%x00%aN±%aE%x00%at%x00%cN±%cE%x00%ct%x00%s` — adds **author/committer name+email split with a rare `±` separator** (names can't contain NUL but can contain spaces; `%an`/`%aN` + custom separator is the standard trick), epoch times for sorting, and **streaming line-by-line parsing** with `parts.Length != 8 → skip` validation.
- GitEmber's JGit equivalent: **drop commit bodies after the walk** (`ScmPlotWalk`/`ScmPlotCommit`) — captures `shortMessage` + `authorName` + `signed` flag then `disposeBody()`. **Measured: 26 000-commit repo, plot list costs 1 222 B/commit with bodies vs 223 B/commit without (5.5×).** The list is kept for the life of the repo, so this is permanent, not transient. Anything needing the body (detail panel, search index) re-reads that single commit on demand (`GitRepoService.adapt`). Author names are **pooled** (`Map.putIfAbsent`) since distinct authors ≪ commits.
  - → Our Node backend already only returns summaries for history (body fetched on demand in `commit_details`) — we have this for free. The pooling idea applies to our `User` dedupe: intern author names once per repo load.

### 3.3 Search modes (SourceGit `QueryCommits.cs:27-46`)

Four distinct modes, each a different git invocation:
- **ByAuthor**: `-i --author=<q>`
- **ByMessage**: split query into words → one `--grep=<word>` **each** + `--all-match -i` (AND semantics, case-insensitive) — not a single regex
- **ByPath**: `-- <quoted path>`
- **ByContent**: `-G <q>` (match in diff text)
- Plus `--branches --remotes` when not current-branch-only, `--date-order`, capped at 1000.
- **Merged-marking** (lines 85-108): after the walk, if no commit was marked `IsMerged`, run `QueryCurrentBranchCommitHashes` (rev-list of the current branch) and mark the last intersecting commit — makes "current branch only" highlighting correct even at the paging boundary.

### 3.4 Pathspec literalization (GitDesktop `pathspec::literal`)

`git log --follow -- [slug]-style-path` matches **glob siblings** — a measured bug they fixed by wrapping user paths in `:(literal)` pathspecs. Blame is the exception: it takes a literal path, never a pathspec, so `:(literal)` fails there ("do not 'fix' this the way the diff/log call sites were fixed" — their comment).
→ Our `commitFileDiff`/file-history take user paths straight into `git diff`/`git log --`; wrap them in `:(literal)` (log/diff) but not blame.

### 3.5 Incremental model delivery (gitg `CommitModel`)

- Background thread walks libgit2; the UI model advertises `d_advertized_size` and **emits `update(added)` via GLib idle batching** — the treeview gets progressive rows: initial 1.0s pause (makes small repos feel instant), then 0.2s batches.
- Array growth: 2× up to 20 000 entries, then 1.2× (`needs_resize`, lines 319-336).
- `Cancellable` + thread join on dispose — filter changes cancel the in-flight walk.
→ Chrono's 300-commit one-shot is fine for now, but if we add "load more" (GitDesktop pattern), batch the rendering (e.g. 100 rows per animation frame) so a 5000-commit dump doesn't jank.

### 3.6 Diff & stat widgets (gitg `libgitg/diff-*`)

- `gitg-diff-stat`: a single proportional **added/removed bar** (style property `bar-height`, CSS-named `gitg-diffstat`) — the compact per-file diffstat.
- Image diff modes: **composite, difference, overlay, side-by-side, slider** + a `gitg-diff-image-surface-cache` (caches rendered surfaces, only re-renders changed regions).
→ For our diff view: the added/removed bar is a 10-line addition to the file list rows; image-diff slider is a later enhancement.

---

## 4. Feature checklist diff (what we don't have yet)

Verified against our current surface (0.7.0: history+graph, refs browser, working diff, commit-file diff, repo browser, tags/merge/patches/clean, worktrees, stashes, submodules, blame):

| Feature | Source | Effort | Value |
|---|---|---|---|
| Graph highlight modes (current branch / selected first-parent chain) | SourceGit | M | High — GitLens-parity visual |
| Inline ref labels on graph (branch/tag badges) | GitEmber/gitg | M | High — GitKraken look |
| Per-row graph text offset | SourceGit | S | Med — space + correctness |
| Stable recycled lane colors | SourceGit | S | Med |
| Merge-lane stealing (compact trunk) | gitg | M | Med on merge-heavy repos |
| Commit filter: author/message/path/content modes + filter-history completion | SourceGit/gitg | S | High |
| Paged history + load-more + progressive render | GitDesktop/gitg | M | Med (only when raising the 300 cap) |
| Animated refs rows + inline branch rename | gitg | S | Med |
| Toggleable history columns | gitg | S | Low-Med |
| `:(literal)` pathspec hardening (log/diff, not blame) | GitDesktop | S | Med — bug class |
| Unborn-HEAD guards on every command | GitDesktop | S | Low-Med — robustness |
| Per-file diffstat bar (added/removed) | gitg | S | Med |
| Inactive-lane collapse with boundary arrows | gitg | L | Low for now, High for giant repos |
| Image diff slider/overlay + surface cache | gitg | M-L | Low-Med |
| Author-name interning in history payload | GitEmber | S | Low |

## 5. Source references (files + line anchors)

- SourceGit `src/Models/CommitGraph.cs` — `Generate` :74, `ColorPicker` :271, `PathHelper.Pass/Goto/End/Highlight` :327-399, `LeftMargin` :252, palettes :422-434. `src/Views/CommitGraph.cs` — `DrawCurves` :73, culling :82-106, beziers :137-147. `src/Commands/QueryCommits.cs` — formats :20, :32-46, streaming :63-83, merged-marking :85-108.
- GitEmber `src/main/java/com/az/gitember/ui/CommitGraphRenderer.java` — full file (148 lines). `ui/HistoryPanel.java` — `ROW_HEIGHT` :37, columns :84-92, `GraphCellRenderer` :695-758. `service/ScmPlotWalk.java` — full file; `data/ScmPlotCommit.java` — memory numbers in class comment.
- gitg `libgitg/gitg-lanes.vala` — `next` :158, `prepare_lanes`/lane-stealing :220-322, `collapse_lanes` :380, `expand_lane` :455, `d_previous` window :315-321. `libgitg/gitg-cell-renderer-lanes.vala` — constants :26-28, top/bottom paths :166-193, arrows :79-98, labels :226-244, preferred width :65-77, hit-test :320-338. `libgitg/gitg-commit-model.vala` — thread walk :338-500, idle batching :281-317, growth :319-336, permanent lanes :155-161. `gitg/history/gitg-history-refs-list.vala` — `RefRow` :54, animation :42-46, :1019-1132, inline edit :314, columns dialog `gitg/history/gitg-history.vala` :870-891. `libgitg/gitg-entry-history.vala` — completion :57-177.
- GitDesktop `src-tauri/src/git/history.rs` — `git_log` :20-59, `LOG_FORMAT` :64, `parse_commit_log` :66-89, `git_file_log` (literal pathspec) :102-145, `git_blame` (porcelain + cache) :152-250.

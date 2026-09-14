# Chrono Next UI/UX Deep Research and Refactor Specification

## Executive summary

Chrono Next already has the right architectural premise for a modern replacement: the Qt-free application is a sibling implementation in `next/`, built with Rust, Tauri 2, React, TypeScript and plain CSS. The problem is not the technology. The problem is that the first UI slice carries forward too much of the old desktop chrome while also layering web-style navigation on top of it.

The current `next/src/App.tsx` exposes a faux menu bar, a window strip, a legacy toolbar, a repository sidebar, and then another repository toolbar containing view tabs and actions. The result is repeated navigation, repeated refresh/action affordances, weak information hierarchy, and unnecessary vertical chrome. The refactor should instead treat **repository state as navigation**: Working Tree / Conflicts, History, Branches, Worktrees, Submodules, Stashes, and Recovery are the durable places a user moves between. Remote actions belong to a compact repository command bar. Detail surfaces belong in resizable inspectors.

The strongest pattern across GitKraken, SmartGit, TortoiseGit and native desktop HIGs is a persistent multi-pane workspace: a navigation/reference pane, a primary work surface, and a contextual detail/commit pane. GitKraken explicitly uses Left Panel + Commit Graph + Commit Panel and lets users resize/collapse the areas; its graph columns can also be reordered and their widths are saved per repository.[1] Apple’s desktop split-view guidance similarly calls out adjacent panes with draggable dividers and persistent selection.[10]

The second major conclusion is that **Git operations must be stateful UX, not fire-and-forget commands**. SmartGit leaves the repository in a conflicted merge/rebase/cherry-pick/revert state and offers resolve, continue, or abort.[4] Git itself defines rebase conflicts as a paused operation with `--continue`, `--skip`, and `--abort` paths.[14] Chrono Next should therefore grow an operation-state model and persistent operation banner before implementing a polished rebase or conflict center.

The third conclusion is that advanced repository structures must be first class. GitKraken exposes worktrees in its left panel and supports create, switch, remove, lock and unlock.[2] TortoiseGit’s Worktrees dialog lists the main and linked worktrees and makes lock/unlock/removal explicit.[7] The Qt-free Chrono backend already exposes worktree, submodule, stash, reflog, LFS and maintenance commands, but the existing UI reduces them to generic workflow buttons and terminal output. The refactor promotes these into dedicated repository destinations and parses worktree/stash output into visible state.

This implementation pass therefore replaces the stacked chrome with a compact repository-centered shell; adds first-class navigation; splits working changes into Conflicts / Staged / Unstaged; makes commit enablement state-safe; adds a keyboard-operable command palette; adds resizable desktop panes; replaces browser prompts with a clone task dialog; provides a real branch manager; and turns worktrees/stashes into structured surfaces. A full conflict solver, operation controller, true DAG renderer, on-demand diffs, and structured submodule model remain the next backend/UI slices.

---

## 1. Current Qt-free architecture

The root `NO_QT_VARIANT.md` states that the independent Qt-free replacement lives in `next/` and does not participate in the legacy Qt/CMake build.[16] `next/README.md` documents a Rust application/service layer, Tauri 2 shell, React + TypeScript UI, desktop Git through the installed `git` executable, and `git2-rs` for Android.[17]

The existing backend is already broader than the initial UI suggests. In addition to repository summary/history/status and ordinary stage/commit/fetch/pull/push operations, `next/src-tauri/src/backend/cli.rs` exposes worktree list/add/remove/prune, sparse checkout, submodule update/sync, stash list/push/pop, bisect, reflog, cherry-pick, revert, LFS, maintenance and fsck.[18]

That means the UI should not be designed like a small “Git log + status” utility. It should be designed as a scalable desktop Git workbench with progressive disclosure.

---

## 2. Senior UI/UX audit of the current interface

### 2.1 Redundant chrome and command duplication — P0

The original Qt-free `App.tsx` combines all of the following:

- faux desktop menu bar;
- repository/window strip;
- legacy icon toolbar;
- persistent repository sidebar;
- second repository toolbar;
- view tabs inside that toolbar;
- additional toolbar actions for refresh and command palette.

Several commands therefore appear in more than one place. Refresh is present in the legacy toolbar and the second toolbar; repository context is repeated in the window strip and repository toolbar; navigation is split between the sidebar and tabs.

**Refactor:** one global top bar, one repository sidebar, one repository contextual command bar, one main content surface. The command palette becomes the low-frequency command escape hatch.

### 2.2 Navigation represents screens rather than repository state — P0

“Graph / Files / Branches / Tools / Cherry” describes implementation surfaces rather than how Git users think about a repository. “Tools” is especially weak: worktrees, submodules, stashes and recovery are not equivalent miscellaneous buttons.

**Refactor information architecture:**

1. Changes / Conflicts
2. History
3. Branches
4. Worktrees
5. Submodules
6. Stashes
7. Recovery & tools
8. UI workbench (developer-only destination)

When conflicts exist, the first navigation item changes from “Changes” to “Conflicts” and gains a critical state badge. This makes repository risk visible before the user opens a secondary tool.

### 2.3 Static grids instead of desktop panes — P0

The current CSS hardcodes panel proportions. The sidebar is fixed at 234 px, the history details pane is a percentage, and the status commit surface is fixed-width. This is inconvenient on both 1080p and ultrawide screens and prevents users from optimizing the UI for long branch names, paths, commit messages or diffs.

GitKraken’s reference/graph/commit model is explicitly resizable,[1] and Apple states that macOS split-view dividers can support dragging to resize panes.[10]

**Refactor:** resizable repository sidebar plus keyboard- and pointer-operable vertical separators for the History inspector, Changes commit panel, and advanced-workflow command output.

### 2.4 Faux menubar has desktop semantics without desktop keyboard behavior — P0 accessibility

The original app uses `role="menubar"` and `role="menu"` but reveals menus through CSS hover/focus-within rather than implementing the complete interaction pattern. WAI-ARIA’s menubar pattern expects application-style keyboard navigation and focus management.[11]

ARIA roles are not a substitute for the interaction contract.

**Refactor:** remove the faux menubar from the persistent shell. Keep frequent context actions visible; put the long tail of commands in a searchable palette. If native application menus are added later, use Tauri/native menu APIs rather than recreating platform menus with divs.

### 2.5 History visually claims a DAG without rendering one — P0 trust issue

The original `CommitGraph.tsx` draws a single continuous line and colors a dot based on list index. That is not a commit DAG and can imply relationships that do not exist. The same panel displays placeholder “diff” text despite not loading patch data.

This is a product-trust issue, not just styling.

**Refactor now:** remove the false lane line. Show an honest commit node and parent-count indicator until a real DAG/lane algorithm is available. Remove fake patch content and clearly state that patch data is not loaded.

**Next slice:** return graph topology from the backend or compute lanes from commit parent data; support reference labels and WIP/worktree nodes.

### 2.6 Working changes are not modeled as Git index state — P0

The current Status panel is one mixed file list with two generic Stage/Unstage buttons. This forces the user to infer index state from two-character status codes.

GitKraken’s Commit Panel explicitly separates Unstaged Files, Staged Files and Commit Message.[1] SmartGit also models staged and unstaged state distinctly, including partially staged states.[15]

**Refactor:** separate Conflicts, Staged and Unstaged into durable groups. A partially staged file may legitimately appear in both Staged and Unstaged, so selection state must be independent in those groups. Commit becomes disabled when:

- no commit message is present;
- no files are staged;
- conflicts remain;
- another staging/commit operation is pending.

### 2.7 Conflict state is insufficiently visible — P0

A conflict is currently just a reddish file row. For merge-like operations, the repository is in a special operational state and normal commands may be unsafe.

SmartGit deliberately stops merge/rebase/cherry-pick/revert when conflicts occur and leaves the working tree conflicted so the user can resolve, continue or abort.[4] Its Conflict Solver uses left/current/right three-way panes with targeted “Take” actions.[5] TortoiseGitMerge similarly exposes a multi-pane conflict workflow with a merged output.[9]

**Refactor now:** promote conflicts to navigation, repository-header badge, critical banner, dedicated conflict group, and commit blocking.

**Next slice:** persistent operation banner plus Conflict Center with Base / Current Base / Replayed Commit terminology appropriate to the active operation.

### 2.8 Browser prompts for clone are below desktop-product quality — P1

The original clone flow calls `window.prompt()` twice. This gives no context, validation, browsing, inline help, credential explanation or correct modality.

**Refactor:** dedicated Clone Repository dialog with URL, destination, Browse, validation, busy state, Cancel and Clone. Errors remain visible in the app status channel while the dialog stays open for correction.

### 2.9 Branch manager is too thin — P1

The original Branches view is a flat list of buttons, with branch checkout bound to clicking the row. Local vs remote state is not visually structured and branch creation is elsewhere.

**Refactor:** dedicated Branches view with filter, current-branch state, local and remote sections, explicit Checkout, and branch creation.

**Backend correctness issue:** `repository_branches()` currently marks a branch as remote when `fields[0].contains('/')`. A valid local branch named `feature/ui-v2` therefore becomes “remote” in the UI.[18] The backend should use the full ref name and classify `refs/remotes/*` explicitly.

### 2.10 Worktrees are capability-rich in backend but low-fidelity in UI — P1

The existing “Worktrees” workflow only dumps `git worktree list --porcelain` output. Git’s porcelain format is intentionally stable and exposes path, HEAD, branch/detached state, locked state/reason and prunable state.[13]

**Refactor:** parse the porcelain records and render a table with Branch, Path, HEAD and State. Keep Create Worktree first-class. Do not expose destructive one-click removal until dirty-state/lock checks are modeled.

Longer term, match the safety of TortoiseGit/GitKraken: main worktree distinction, lock/unlock, full path, branch-in-use guidance, remove confirmation and optional branch deletion.[2][7]

### 2.11 Submodules need a state model, not two buttons — P1/P2

The backend has recursive update and sync but no structured submodule status endpoint. TortoiseGit exposes Add, Update/Init and Sync,[8] while SmartGit shows submodules as repositories/files and supplies context-sensitive operations.[6]

**Refactor now:** dedicated Submodules destination with explicit “Initialize & update recursively” and “Synchronize URLs.”

**Next backend slice:** path, configured URL, branch, expected gitlink commit, actual HEAD, initialized state, dirty state, nested status. Then render a status table with per-submodule operations.

### 2.12 Command palette needs real keyboard operation — P1 accessibility

The original palette only filters with substring matching and requires mouse activation.

**Refactor:** Up/Down navigation, Enter execute, Escape close, active option state, category, shortcut and keywords. `Ctrl/Cmd+Shift+P` opens it globally.

### 2.13 Status parser has a rename/copy edge case — P1 correctness

The backend parses `git status --porcelain=v1 -z` by splitting every NUL-delimited item into a new file record.[18] Git documents that rename/copy records in `-z` format contain **two pathnames separated by NUL**, with the destination followed by the original path.[12] A raw `split('\0')` therefore cannot distinguish the original path from a new status record.

This can produce incorrect file rows in the UI. The backend should either implement the porcelain v1 rename/copy grammar correctly or move to porcelain v2 and parse record types explicitly.

---

## 3. Competitive benchmark

| Product / guidance | High-value pattern | What Chrono Next should adopt | What not to copy literally |
|---|---|---|---|
| GitKraken Desktop | Left Panel + Commit Graph + Commit Panel; panes and sections are resizable; graph columns configurable and saved per repository.[1] | Stable 3-area mental model; persistent repo references/state; resizable inspector; per-repo layout persistence later | Brand-specific visual styling and proprietary collaboration surfaces |
| GitKraken Worktrees | Worktrees visible from left panel; create/switch/remove/lock/unlock; full path discoverable.[2] | First-class worktree destination, lock state, safe destructive flow | Agent-session-specific UX unless Chrono adds agents |
| GitKraken Interactive Rebase | Pick/Reword/Squash/Drop and keyboard shortcuts.[3] | Rebase planner with explicit per-commit actions and preview | Starting with drag/drop only; keyboard/buttons must remain available |
| SmartGit | Separate Working Tree / Log mental models; configurable perspectives.[19] | Strong Local Changes vs History separation; save pane layout/perspective | Multiple top-level windows as a default requirement |
| SmartGit merge/rebase | Operation pauses on conflict; resolve/continue/abort.[4][20] | Persistent operation banner/controller | Hiding operation state in transient notifications |
| SmartGit Conflict Solver | Three-way solver; base view; previous/next conflict; take left/right/both; editable working result.[5] | Conflict Center with navigation and targeted block actions | Generic “Mine/Theirs” labels during rebase without role explanation |
| TortoiseGit Worktrees | Main + linked worktree list; right-click lock/unlock/remove; folder + revision creation.[7] | Safety-oriented worktree manager | Shell-extension dependence |
| TortoiseGit Rebase | Explicit ordered plan; pick/skip/edit/squash and shortcuts.[8] | Ordered rebase plan and clear terminology | Old dialog density/layout |
| TortoiseGitMerge | Three panes plus merged output and both-order choices.[9] | Editable merged result and “both orders” actions | Fixed labels that become semantically confusing in rebase |
| W3C APG | Menubar/grid patterns require explicit keyboard/focus behavior.[11][21] | Build correct keyboard semantics or use simpler native patterns | Adding ARIA roles without implementing the behavior |
| Apple HIG | Sidebar hierarchy should stay shallow; split panes support persistent selection and resizing.[10][22] | Shallow sidebar, resizable detail panes, visible current selection | Apple-specific visual chrome on Windows/Linux |

---

## 4. Target information architecture

### Global shell

**Top bar**
- product identity;
- active repository name/path;
- Open;
- Clone;
- Command Palette.

This area should not repeat repository-state navigation.

### Repository sidebar

**Repository list**
- named workspaces;
- open/recent repository rows;
- active repository selection;
- alias + path;
- collapsible/resizeable width.

**Repository destinations**
- Changes / Conflicts;
- History;
- Branches;
- Worktrees;
- Submodules;
- Stashes;
- Recovery & tools.

This hierarchy is intentionally shallow, consistent with sidebar HIG guidance.[22]

### Repository command bar

Always show:
- current branch / Detached HEAD;
- changed-file count;
- conflict count if applicable;
- ahead / behind;
- Refresh;
- Fetch;
- Pull;
- Push.

Potential later contextual controls:
- operation-state banner directly below this bar;
- provider/PR status;
- local/remote tracking status.

### Primary work surface

The central content changes by repository destination. It owns task-specific controls, not global commands.

### Inspector / commit / output pane

A resizable right pane is used only when the current destination has a persistent detail surface:
- selected commit inspector;
- commit composer;
- command output / operation log;
- future conflict output editor.

---

## 5. Visual system

### Design objective

A professional engineering desktop application should feel dense but not cramped. The visual hierarchy should come from spacing, alignment, typography and state—not gradients, card piles or oversized headings.

### Palette

The implementation uses a neutral dark system:
- canvas: near-black neutral;
- surfaces: two to three elevation-neutral gray levels;
- border: subtle neutral separators;
- accent: single blue action/selection color;
- warning: amber;
- danger/conflict: red;
- success: green.

Color never carries the entire meaning. Conflict also has text/icon labels; selected state has geometry/background; disabled state has opacity and semantics.

### Density

- ordinary rows: about 30 px;
- repository rows: about 39 px because they carry a second line;
- compact buttons: 28–30 px;
- toolbar: ~45 px;
- top app bar: ~42 px.

This is deliberately denser than consumer SaaS UI while retaining enough target size for a pointer-driven desktop app.

### Typography

- system UI stack for normal text;
- monospaced stack for commit hashes, status codes, terminal output and shortcuts;
- 9–10 px metadata;
- 11–12 px primary rows;
- 14 px contextual headings.

### Icons

The refactor introduces dependency-free inline SVG icons for the app chrome so the UI does not depend on mismatched legacy bitmap resources. Existing product artwork can remain for brand identity where appropriate.

---

## 6. Interaction model

### Keyboard map in this pass

| Shortcut | Action |
|---|---|
| Ctrl/Cmd + Shift + P | Command palette |
| Ctrl/Cmd + B | Toggle repository sidebar |
| Ctrl/Cmd + 1 | Changes / conflicts |
| Ctrl/Cmd + 2 | History |
| Ctrl/Cmd + 3 | Branches |
| F5 | Refresh active repository |
| Arrow Up / Down in command palette | Change active command |
| Enter in command palette | Execute |
| Escape in command palette | Close |
| Left / Right on split separator | Resize adjacent detail pane |

Future shortcuts should be centralized in a command registry rather than scattered across components.

### Pane resizing

Each vertical separator is focusable and declares `role="separator"` with vertical orientation. Pointer dragging resizes continuously; Left/Right arrows adjust by a predictable step. This makes the desktop split-pane affordance available to keyboard users too.

### Context preservation

Repository refresh preserves the selected commit when that commit still exists. This prevents routine fetch/status refreshes from jerking the user back to HEAD.

### Busy state

Remote and repository actions update the global status channel and disable unsafe duplicate activation while running.

---

## 7. Working tree / commit UX

### Grouping rules

**Conflicts**
- all `FileChange.conflicted` entries;
- rendered first;
- critical styling;
- commit blocked.

**Staged**
- non-conflicted records where index status is not blank/`?`.

**Unstaged**
- non-conflicted records where worktree status is not blank, plus untracked `?` entries.

A partially staged file can appear in both Staged and Unstaged. Its two selections must therefore be independent. This refactor uses separate staged and stageable selection sets.

### Commit composer

Always shows:
- staged file count;
- message editor;
- word and character count;
- explicit “Commit staged changes” command;
- reason text when disabled.

Future improvements:
- summary + description split fields;
- configurable line length guide;
- amend;
- sign-off;
- co-authors;
- GPG/signing state;
- hooks output;
- optional stage-and-commit policy.

---

## 8. History UX

### Current implementation change

The history surface now consists of:
- filter toolbar;
- compact commit list;
- Graph, Commit, Author, Date, SHA columns;
- honest commit node / merge-parent count rather than fake graph lines;
- selected commit inspector;
- resizable inspector separator.

### Required next iteration: real DAG

The UI should receive or compute:
- lane index per commit;
- parent edges;
- active references/tags;
- HEAD/current branch marker;
- stash nodes;
- worktree/WIP nodes;
- hidden/solo reference filters.

GitKraken’s graph is valuable because the DAG is not decoration: branch lines and merge topology are primary navigation.[1]

### Required next iteration: on-demand commit details

Selecting a commit should lazily load:
- changed files;
- additions/deletions;
- patch/hunks for selected file;
- optional side-by-side/unified diff;
- binary/file-mode/submodule changes.

Do not pre-load all patches with the initial 300-commit history response.

---

## 9. Branch UX

### Refactored surface

- branch filter;
- branch creation form;
- local branch section;
- remote branch section;
- current-branch label;
- explicit Checkout action;
- SHA/upstream metadata.

### Required backend fix

Classify local/remote by full ref namespace, not `/` in the short name.

Recommended backend format:

`%(refname:short) ... %(refname)`

Then:

`remote = full_ref.starts_with("refs/remotes/")`

### Next actions

- rename branch;
- delete with merged/unmerged safety;
- set/unset upstream;
- create from selected commit;
- merge into current branch;
- rebase current branch onto selected branch;
- compare branch;
- open worktree for branch.

---

## 10. Worktree UX

Git worktree porcelain is designed for machine parsing and exposes exactly the state needed for a safe first UI.[13]

### Refactored surface

- folder;
- branch/revision;
- create;
- structured Linked Worktrees table:
  - Branch;
  - Path;
  - HEAD;
  - State (Ready / Locked / Prunable);
- prune stale metadata;
- raw output remains available in the right output pane for transparency.

### Safety policy

Do not make Remove a prominent row action until the backend returns:
- whether this is the main worktree;
- dirty state;
- current branch;
- branch checked out elsewhere;
- lock reason;
- prunable reason;
- whether submodules constrain move/remove behavior.

Then use an explicit confirmation for destructive removal and visually separate “remove worktree metadata” from “delete working directory/branch” semantics.

---

## 11. Submodule UX

### Refactored first slice

Dedicated destination with two clear operations:
- Initialize & update recursively;
- Sync URLs recursively.

### Structured model needed

Add a backend command returning an array like:

```text
SubmoduleRecord {
  name
  path
  url
  configured_branch
  expected_commit
  checked_out_commit
  initialized
  dirty
  nested_changes
  status
}
```

Then the UI can support:
- status table;
- open submodule;
- initialize selected;
- update selected;
- sync selected;
- add;
- deinit;
- change URL/branch;
- recursive scope toggle.

This matches the discoverability of TortoiseGit and SmartGit without copying their exact UI.[6][8]

---

## 12. Merge, rebase and conflict UX target

This is the highest-value next product slice.

### 12.1 Operation state must be persistent

Git explicitly pauses rebase on conflict and supports Continue, Abort, or Skip after the user resolves/stages changes.[14] SmartGit follows the same visible model.[4][20]

Add `RepositoryOperationState`, for example:

```text
idle
merge { target }
rebase { upstream, current_patch, progress }
cherry_pick { commit }
revert { commit }
bisect { good, bad, current }
```

The backend should derive this from Git state files/commands, not from transient frontend memory.

### 12.2 Operation banner

When non-idle, show a persistent bar under the repository command bar:
- `REBASE PAUSED — replaying 4 of 11`;
- unresolved conflict count;
- Continue;
- Skip where valid;
- Abort;
- Open Conflict Center.

Continue remains disabled until conflicts are resolved/staged, matching SmartGit’s behavior.[20]

### 12.3 Conflict Center

Recommended layout:

**Left: conflicted file list**
- unresolved / resolved groups;
- conflict type;
- next/previous navigation;
- submodule/gitlink conflict distinction.

**Center: source panes**
- Base (optional/toggle);
- Current Base;
- Replayed Commit / Incoming.

**Bottom or right: Merged Output**
- editable;
- conflict markers visibly tracked;
- Take Current;
- Take Incoming;
- Take Current then Incoming;
- Take Incoming then Current;
- apply line/selection;
- save;
- mark resolved / stage;
- save & next.

SmartGit supports left/right/both orders and targeted application,[5] while TortoiseGitMerge uses a merged output pane and block choices.[9]

### 12.4 Avoid ambiguous Mine/Theirs during rebase

Rebase changes the intuitive meaning of “ours” and “theirs.” SmartGit documents that the left/right roles swap because Git checks out the upstream/base and replays source commits.[20] TortoiseGit also warns about rebase conflict semantics.[8]

Use operation-specific role labels:
- **Current Base / Upstream**;
- **Replayed Commit**;
- actual branch/commit IDs in secondary text.

This is more understandable than “Mine/Theirs.”

### 12.5 Interactive rebase planner

Use an ordered list of commits with action per row:
- Pick;
- Reword;
- Edit;
- Squash;
- Fixup (later);
- Drop.

Support:
- keyboard actions;
- move up/down;
- drag reorder as enhancement, not sole mechanism;
- reset plan;
- warning for published commits;
- preview old tip -> new base;
- explicit Start Rebase.

GitKraken and TortoiseGit both make the rebase plan visible rather than hiding it behind a one-shot command.[3][8]

---

## 13. Accessibility and input

### Keyboard

The application should be fully operable without a mouse for high-frequency Git work. That includes navigation, command palette, staging, commit, branch checkout, conflict navigation and split pane resizing.

### Interactive tabular content

W3C’s Grid pattern makes clear that a true ARIA grid requires managed cell focus and directional navigation.[21] Chrono should therefore avoid casually assigning `role="grid"` to ordinary lists. Use semantic tables for read-mostly data or implement a complete grid interaction model when editing/reordering becomes necessary.

### Focus

- visible `:focus-visible` ring;
- no `outline: none` unless a replacement is provided;
- dialogs focus the first meaningful field;
- future dialogs should trap focus and restore it to the invoking control.

### Reduced motion

The design disables transitions/animations when `prefers-reduced-motion: reduce` is active.

### Text/contrast

Metadata is lower contrast than primary content but conflict/warning states always carry text/icon cues in addition to color.

---

## 14. Implementation delivered in this refactor

### Shell

- removed persistent faux menu / window strip / legacy toolbar layering;
- new compact top bar;
- repository-centered contextual bar;
- status bar retained for low-frequency operation feedback.

### Navigation

- resizable/collapsible repository sidebar;
- dedicated repository destinations;
- conflict state promoted into navigation;
- active repository context visible once, not repeated across multiple toolbars.

### Changes

- Conflicts / Staged / Unstaged groups;
- separate selection state for partially staged files;
- state-safe commit gating;
- conflict banner;
- resizable commit pane.

### History

- filter;
- honest graph placeholder;
- selected-commit inspector;
- no fake diff;
- resizable inspector.

### Branches

- new first-class BranchPanel;
- create/filter/local/remote/current/checkout UX.

### Worktrees / stashes / submodules / recovery

- dedicated destinations;
- structured worktree parsing/table;
- structured stash list;
- submodule action cards;
- reflog/fsck/maintenance/LFS cards;
- resizable command output.

### Global interaction

- command palette categories, shortcuts, keywords, arrow navigation, Enter and Escape;
- `Ctrl/Cmd+B`, `Ctrl/Cmd+1/2/3`, F5;
- dependency-free SVG UI icons;
- proper clone task dialog with destination browser;
- desktop responsive behavior and reduced-motion handling.

---

## 15. Implementation priorities after this pass

### P0 — operation safety and truthfulness

1. Backend `RepositoryOperationState`.
2. Persistent merge/rebase/cherry-pick/revert operation banner.
3. Rebase Continue / Skip / Abort.
4. Conflict list and stage-resolved workflow.
5. Three-way Conflict Center.
6. Real history DAG/lane layout.
7. On-demand changed-file + hunk diff backend.
8. Fix branch remote classification for local names containing `/`.
9. Fix porcelain `-z` rename/copy parsing.

### P1 — advanced repository parity

1. Structured worktree API, including main/dirty/lock/prunable state.
2. Worktree lock/unlock and safe remove/repair/move.
3. Structured submodule status and per-submodule controls.
4. Interactive rebase planner.
5. Branch merge/rebase/compare/context actions.
6. Stash structured model + preview/apply/drop.
7. Persist splitter/sidebar widths per repository.
8. Column visibility/order/width persistence.
9. Context menus and drag/drop where they improve expert throughput.

### P2 — power-user polish

1. Hide/solo references.
2. Saved filters/search scopes.
3. Multiple repository tabs/windows.
4. WIP/worktree nodes in DAG.
5. PR/provider context surfaced beside branch/commit rather than as a separate app mode.
6. Custom shortcut editor.
7. External diff/merge tool configuration.
8. Light/high-contrast/custom themes.
9. Zoom/density modes.

---

## 16. Visual QA acceptance criteria

### Shell

- no duplicate navigation strips;
- repository identity appears in one primary place;
- remote actions visually grouped;
- 1280×720 remains usable;
- 1920×1080 uses extra width for content, not inflated whitespace.

### Sidebar

- active repository and active destination are simultaneously obvious;
- paths truncate but remain discoverable with title/tooltip;
- conflict badge cannot be confused with normal change count;
- collapsed mode remains navigable by icon/title.

### Changes

- conflict group always precedes staged/unstaged;
- partially staged file can be selected independently in both contexts;
- commit cannot proceed with unresolved conflict;
- long file paths ellipsize without shifting status columns.

### History

- commit selection spans the full row;
- inspector does not force commit table below usable width;
- split handle remains visible but subtle;
- no visual edge implies a false parent relation.

### Worktrees

- full path available;
- branch, HEAD and state are distinct columns;
- locked/prunable state visible before destructive controls are introduced.

### Accessibility

- all primary commands reachable by keyboard;
- focus ring is visible;
- split separators respond to arrows;
- dialog titles/fields have labels;
- palette exposes one active option and supports Enter/Escape.

---

## 17. Source notes

1. GitKraken, **GitKraken Desktop Interface Guide**, updated May 2026. https://help.gitkraken.com/gitkraken-desktop/interface/
2. GitKraken, **Manage Git Worktrees in GitKraken Desktop**, updated August 2026. https://help.gitkraken.com/gitkraken-desktop/worktrees/
3. GitKraken, **Interactive Rebase with GitKraken Desktop**. https://help.gitkraken.com/gitkraken-desktop/interactive-rebase/
4. SmartGit, **Merge / Resolving Conflicts**. https://docs.syntevo.com/SmartGit/Latest/Manual/GUI/Branch/Merge
5. SmartGit, **Conflict Solver**. https://docs.syntevo.com/SmartGit/Latest/Manual/GUI/Branch/Conflict-Solver
6. SmartGit, **Submodules**. https://docs.syntevo.com/SmartGit/Latest/Manual/GUI/Repository/Submodules
7. TortoiseGit, **Working with worktrees**. https://tortoisegit.org/docs/tortoisegit/tgit-dug-worktrees.html
8. TortoiseGit, **Rebase**. https://tortoisegit.org/docs/tortoisegit/tgit-dug-rebase.html
9. TortoiseGitMerge, **Editing Conflicts**. https://tortoisegit.org/docs/tortoisegitmerge/tmerge-basics-conflicts.html
10. Apple Human Interface Guidelines, **Split views**. https://developer.apple.com/design/human-interface-guidelines/split-views
11. W3C WAI-ARIA Authoring Practices Guide, **Menu and Menubar Pattern**. https://www.w3.org/WAI/ARIA/apg/patterns/menubar/
12. Git documentation, **git-status — Porcelain Format Version 1**. https://git-scm.com/docs/git-status
13. Git documentation, **git-worktree — Porcelain Format**. https://git-scm.com/docs/git-worktree/2.52.0
14. Git documentation, **git-rebase**. https://git-scm.com/docs/git-rebase.html
15. SmartGit, **Repositories, Directories and Files** (staging states). https://docs.syntevo.com/SmartGit/Latest/Manual/GUI/Repository/Repositories-Directories-and-Files
16. Chrono repository, **NO_QT_VARIANT.md**. https://github.com/xsession/chrono/blob/master/NO_QT_VARIANT.md
17. Chrono repository, **next/README.md**. https://github.com/xsession/chrono/blob/master/next/README.md
18. Chrono repository, **next/src-tauri/src/backend/cli.rs**. https://github.com/xsession/chrono/blob/master/next/src-tauri/src/backend/cli.rs
19. SmartGit, **Main Windows**. https://docs.syntevo.com/SmartGit/Latest/Manual/GUI/Main-Windows
20. SmartGit, **Rebase**. https://docs.syntevo.com/SmartGit/Latest/Manual/GUI/Branch/Rebase
21. W3C WAI-ARIA Authoring Practices Guide, **Grid Pattern**. https://www.w3.org/WAI/ARIA/apg/patterns/grid/
22. Apple Human Interface Guidelines, **Sidebars**. https://developer.apple.com/design/human-interface-guidelines/sidebars
23. Chrono repository, **next/src/App.tsx**. https://github.com/xsession/chrono/blob/master/next/src/App.tsx
24. Chrono repository, **next/src/components/StatusPanel.tsx**. https://github.com/xsession/chrono/blob/master/next/src/components/StatusPanel.tsx
25. Chrono repository, **next/src/components/CommitGraph.tsx**. https://github.com/xsession/chrono/blob/master/next/src/components/CommitGraph.tsx

---

## 18. Implemented operation-state slice

The v3 continuation turns the earlier operation-state recommendation into an implemented cross-layer contract.

### State ownership

Repository operation state is derived from Git, not duplicated in React state machines. On desktop the backend inspects the worktree-specific Git directory (`--absolute-git-dir`) for the standard merge/rebase/cherry-pick/revert markers and counts unresolved index entries. This matters for linked worktrees because operation state belongs to a worktree, not simply the common repository directory.

### Command semantics

The UI only exposes sequencer actions documented by Git:

- Merge: Continue, Abort.
- Rebase: Continue, Skip, Abort.
- Cherry-pick: Continue, Skip, Abort.
- Revert: Continue, Skip, Abort.

Continue is unavailable while unmerged index entries remain. The Changes view remains writable because resolving and staging conflict results is the required path to Continue. Normal Commit, Pull, Push, branch switching and unrelated mutating workflow commands are suppressed until the paused operation finishes or is aborted.

### Persistent visual treatment

The operation banner is intentionally outside individual repository views. A rebase remains visible while inspecting History or Branches, avoiding the common failure mode where a user forgets that the repository is mid-operation because they navigated away from a conflict page.

The banner prioritizes:

1. operation type;
2. progress/current commit context;
3. blocking conflict count;
4. Resolve / Continue / Skip controls;
5. destructive Abort behind confirmation.

### Safe destructive control

Abort requires a dedicated alert dialog rather than a generic browser confirmation. The dialog supports keyboard focus, Escape, Tab containment, explicit consequence copy, and a non-destructive default action.

### Hidden-write correction

The Submodules screen previously called `submodule_sync` as its automatic refresh behavior. Because `git submodule sync` updates local configuration, that made navigation itself mutating. The v3 implementation removes that automatic write. Until structured submodule status exists, entering the page performs no mutation and Sync remains explicit.

### Validation result

Real Git 2.47.3 repositories were used to induce and validate:

- merge conflict -> resolve/stage -> Continue;
- rebase conflict -> Skip;
- cherry-pick conflict -> Abort;
- revert conflict -> Abort.

The state files and command paths used by the Rust controller matched Git's actual behavior in all four smoke scenarios.

### Additional sources

26. Git documentation, **git-merge** — `--continue`, `--abort`, merge conflict state. https://git-scm.com/docs/git-merge
27. Git documentation, **git-cherry-pick** — sequencer `--continue`, `--skip`, `--abort`. https://git-scm.com/docs/git-cherry-pick
28. Git documentation, **git-revert** — sequencer `--continue`, `--skip`, `--abort`. https://git-scm.com/docs/git-revert
29. Rust `git2` crate 0.21, **RepositoryState** — merge/rebase/cherry-pick/revert native state variants. https://docs.rs/git2/latest/git2/enum.RepositoryState.html

---

## 19. Implemented v4 three-way Conflict Center

The v4 slice implements the previously recommended Git-stage-aware conflict resolver.

### Git index as source of truth

Git documents unmerged paths as up to three higher-order index entries: stage 1 is the common base, stage 2 is side A/current, and stage 3 is side B/incoming. `git ls-files --unmerged -z` exposes those entries without pathname quoting, making it appropriate for a GUI backend.

Git's low-level conflict documentation explicitly describes extracting stage 1/2/3 blob objects and writing the verified merged result back to the working tree/index. The v4 design follows that model instead of attempting to infer three-way inputs from conflict-marker text.

### Safe side selection

`git checkout-index --stage=<n>` is specifically documented for copying a named unmerged stage into the working tree. Chrono uses stage 2 or 3 for regular files, binary files and symlinks, then stages the path to clear the unmerged entries.

Submodule conflicts are different: mode `160000` is a gitlink, not text. For those paths Chrono displays commit IDs and uses `git update-index --cacheinfo` to write the selected commit directly into the resolved stage-0 index entry.

### Operation-aware labels

The UI does not expose raw `ours`/`theirs` wording as the primary resolver labels because the semantic roles invert during rebase. The v4 mapping is:

- merge — Current branch / Incoming branch;
- rebase — Current base / Replayed commit;
- cherry-pick — Current branch / Cherry-picked commit;
- revert — Current branch / Revert result.

This makes the user's task role explicit even when Git's stage 2/3 mechanics remain the backend representation.

### Resolver hierarchy

The implemented workspace follows the research recommendation:

1. persistent repository operation state at the top;
2. unresolved file queue;
3. Base / Current-role / Incoming-role panes;
4. per-block resolution controls;
5. editable merged output;
6. Save, Stage & Next.

The final result is intentionally the largest editing surface. Source panes are evidence, not the primary destination.

### Marker-level acceleration

Conflict markers are treated as an acceleration layer rather than as the source of truth. The editor recognizes normal and diff3-style blocks and offers four local choices: Current, Incoming, Both Current-first, Both Incoming-first. After each block replacement the document is reparsed. The final stage action remains disabled while recognized markers remain.

### Special-object behavior

- Binary: no text decoding; side choice or external resolution + Stage working copy.
- Large blob: no large React payload; side choice or external resolution.
- Symlink: target metadata is shown; side selection preserves Git's symlink handling.
- Gitlink/submodule: commit IDs are shown; side selection resolves the index without forcing the nested working tree to another commit.

### Validation result

Real Git 2.47.3 smoke scenarios passed for text, manual merge result, add/add, modify/delete, binary, symlink and submodule gitlink conflicts. Frontend marker parsing passed normal, diff3 and multi-block unit scenarios.

### Additional sources

30. Git documentation, **git-ls-files** — unmerged stage 1/2/3 index records and `-z` pathname output. https://git-scm.com/docs/git-ls-files
31. Git documentation, **git-checkout-index** — copying a selected unmerged stage to the working tree. https://git-scm.com/docs/git-checkout-index
32. Git documentation, **git-update-index** — `--cacheinfo` direct index insertion. https://git-scm.com/docs/git-update-index
33. Git documentation, **Git User Manual — conflict resolution help** — stage blob extraction, merge result and index resolution. https://git-scm.com/docs/user-manual
34. Git documentation, **git-add** — staging the verified result into the index. https://git-scm.com/docs/git-add

---

# v5 addendum — Interactive Rebase + Git Intelligence

The v5 slice extends the repository-state architecture in two directions: history rewriting and repository intelligence. The implementation follows the clean-room findings documented in `GITLENS_CLEANROOM_FEATURE_RESEARCH.md`.

## Interactive rebase planner

The new `RebasePlanner` turns rebase into a plan-first workflow instead of a generic command form. It resolves target/HEAD/common base, blocks merge-containing histories rather than silently flattening topology, loads diffstat per replayed commit, supports Pick/Reword/Edit/Squash/Fixup/Drop, allows drag or keyboard-order changes, validates plan invariants, and requires an explicit rewrite confirmation. Execution remains a native Git interactive rebase so v3's persistent operation state and v4's Conflict Center continue to own pause/conflict/continue/skip/abort behavior.

## Git Intelligence workbench

A new repository view brings high-value GitLens-style insight workflows into Chrono without adopting IDE-only assumptions:

- rich commit query grammar;
- common-base reference comparison;
- file and line history;
- blame with commit/author/date/message data;
- contributor activity;
- pinned searches;
- batch change statistics in History;
- real selected-commit changed-file lists;
- WIP cards for dirty/conflicted linked worktrees.

The design stays offline-first. Provider/cloud/AI/agent functionality remains an optional future integration layer rather than becoming a prerequisite for core Git operations.

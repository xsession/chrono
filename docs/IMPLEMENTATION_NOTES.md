# GitAhead Next UI/UX Refactor — v4 Conflict Center

## Scope

This package continues the Qt-free `next/` GitAhead modernization. The v4 slice implements the next P0 workflow from the prior operation-state work: a real three-way Conflict Center backed by Git's unmerged index entries.

The legacy Qt application remains untouched.

## Backend conflict model

New file:

- `next/src-tauri/src/conflict_center.rs`

New Tauri commands:

- `repository_conflicts(path)`
- `conflict_detail(path, file)`
- `resolve_conflict(path, request)`

On desktop, the backend reads `git ls-files --unmerged -z`. Git records an unmerged path with up to three higher-order index entries:

- stage 1 — merge base;
- stage 2 — current side;
- stage 3 — incoming/operation side.

The UI deliberately does not call these stages Mine/Theirs during rebase. Labels are operation-aware:

| Operation | Stage 2 label | Stage 3 label |
|---|---|---|
| Merge | Current branch | Incoming branch |
| Rebase | Current base | Replayed commit |
| Cherry-pick | Current branch | Cherry-picked commit |
| Revert | Current branch | Revert result |
| No detected operation | Current version | Incoming version |

The API classifies common conflict shapes:

- both modified;
- add/add;
- current deleted / incoming modified;
- current modified / incoming deleted;
- both deleted / complex fallbacks.

## Content handling

For a selected file the backend exposes:

- base/current/incoming object IDs;
- Git mode;
- object kind: regular blob, symlink or gitlink;
- text content for reasonably sized UTF-8 blobs;
- binary / too-large state;
- current working-tree text when safe to read.

Inline text payloads are capped at 2 MiB per stage. Large files remain resolvable by selecting an index side, but the app does not load their full contents into React.

The working-tree path is validated as repository-relative before any direct file write. Direct merged-result writes also reject parent-directory symlink escapes and replace a conflicted leaf symlink instead of following it.

## Resolution strategies

### Manual merged result

For normal text files the editor writes the final content to the working tree and runs `git add -A -- <path>`. This replaces the stage 1/2/3 entries with the resolved stage-0 entry.

### Select current or incoming

For regular, binary and symlink conflicts the backend uses `git checkout-index --stage=2|3 --force -- <path>`, followed by `git add -A`.

If the selected side is absent in a modify/delete conflict, selecting that side resolves the path as a deletion.

### Submodule/gitlink conflict

Gitlinks use mode `160000`. They are not treated as text files. Selecting a side writes the chosen commit ID directly into the index with `git update-index --add --cacheinfo`.

The submodule working tree is not forcibly switched because doing so could discard independent work inside the submodule. The Conflict Center shows the commit IDs explicitly.

### External resolver support

Binary / large / special conflicts expose `Stage working copy & next`, allowing a user to resolve the item with an external editor/mergetool and then stage the result in GitAhead.

## Frontend Conflict Center

New files:

- `next/src/components/ConflictCenter.tsx`
- `next/src/conflictMarkers.ts`

The repository sidebar gains a dedicated Conflict Center destination whenever unresolved conflicts exist. The persistent operation banner's Resolve action now opens this view directly.

The workspace has four layers:

1. unresolved-file queue;
2. three read-only stage panes: Base / Current / Incoming-role;
3. block-resolution toolbar for standard Git conflict markers;
4. editable merged result with Save, Stage & Next.

After each successful resolution the backend returns the next unresolved path. The UI selects it automatically and refreshes repository/operation state.

When the final conflict disappears, repository state is refreshed and the app returns from Conflict Center to Changes. Continue then becomes available in the persistent merge/rebase/cherry-pick/revert banner.

## Block-level marker resolver

`conflictMarkers.ts` recognizes normal and diff3-style Git conflict blocks. For each unresolved block the UI offers:

- Use Current;
- Use Incoming;
- Both — Current first;
- Both — Incoming first.

Applying a block action rewrites only that marker range and reparses the remaining document. Save, Stage & Next remains disabled while marker blocks are still present.

Manual editing remains available at all times for supported text files. Ctrl/Cmd+Enter saves and stages once no recognized marker blocks remain.

## UX safety properties

- no Mine/Theirs labels during rebase;
- binary, symlink and submodule objects are not opened as editable source text;
- large blobs do not get copied into the frontend;
- destructive repository operation Abort remains outside the resolver and retains its confirmation dialog;
- Pull/Push/branch switching/normal Commit remain locked while the operation is paused;
- stage selection is path-safe and only allowed for paths currently present as unmerged index entries;
- a direct merged result cannot write through a parent symlink outside the repository.

## Validation performed

Frontend:

- 16 TS/TSX files parsed/transpiled with TypeScript 5.8.3;
- cross-file semantic TypeScript pass with local React/Tauri shims: PASS;
- CSS structure: PASS, balanced braces;
- conflict-marker parser unit test: PASS for normal markers, diff3 markers, multiple blocks and block-by-block advancement.

Real Git 2.47.3 smoke tests:

- content conflict -> select stage 2 -> staged/resolved: PASS;
- manual merged output -> stage -> resolved: PASS;
- add/add -> select stage 3 -> resolved: PASS;
- modify/delete -> accept deleted side -> resolved: PASS;
- binary conflict -> select stage 3 -> resolved: PASS;
- symlink conflict -> select stage 2 while preserving symlink mode: PASS;
- submodule gitlink conflict -> select stage-3 commit with cacheinfo -> resolved: PASS.

Rust compiler validation is still not available in this container because `cargo`, `rustc` and `rustfmt` are absent. Source received structural validation, but `cargo check` remains mandatory on the development machine.

## Known limitations

- interactive Conflict Center resolution is currently desktop-only; Android returns an explicit unsupported-operation error instead of pretending the workflow is available;
- non-UTF-8 Git path bytes are currently converted through the application's existing UTF-8 string API and therefore cannot be represented losslessly;
- true syntax-aware / AST-aware merge is not implemented; the current editor is Git-stage-aware and block-aware;
- the frontend does not yet provide an external mergetool launcher button;
- no semantic three-way diff highlighting between Base, Current and Incoming yet.

## Next slice

Recommended v5 order:

1. interactive rebase planner with Pick / Reword / Squash / Fixup / Drop and drag reorder;
2. real DAG lane renderer from parent topology;
3. on-demand commit/file diff API and hunk staging;
4. external mergetool/editor integration;
5. native Android conflict resolution parity.

# Apply and Validate Chrono Next UI/UX v5

## Apply the overlay

The `overlay/next/` directory mirrors files that belong under the repository's `next/` directory.

From a Chrono checkout:

```bash
cp -a /path/to/chrono-next-uiux-v5/overlay/next/. next/
```

Or apply `docs/v4-to-v5.patch` on top of the v4 overlay/source state.

## Frontend validation

From `next/`:

```bash
npm install
npm run typecheck
npm run build
```

The artifact was also checked with TypeScript 5.8.3 using local React/Tauri declaration shims, because the container does not include the project `node_modules` tree.

## Rust validation

Run locally where Rust is installed:

```bash
cd next/src-tauri
cargo fmt --check
cargo check
cargo test
```

Rust compiler validation could not be performed in the artifact-generation container because `cargo`, `rustc`, and `rustfmt` are absent.

## Git behavior tests included

```bash
bash tests/git-operation-state-smoke.sh
bash tests/conflict-center-smoke.sh
bash tests/rebase-planner-smoke.sh
bash tests/git-intelligence-smoke.sh
node tests/conflict-markers.test.mjs
```

`rebase-planner-smoke.sh` validates:

- reorder;
- reword;
- squash;
- drop;
- Edit pause;
- normal `git rebase --continue` completion;
- `--update-refs` moving a related local branch to the rewritten commit.

`git-intelligence-smoke.sh` validates the Git primitives behind:

- message/author/file/patch search;
- merge-base comparison and ahead/behind counts;
- file history;
- line history;
- blame porcelain;
- contributor aggregation source data;
- secondary-worktree WIP detection.

## Manual rebase QA

1. Create a clean local feature branch with 4+ commits.
2. Open **Interactive rebase**.
3. Rebase onto `main` or the feature's intended merge target.
4. Reorder two independent commits.
5. Reword one commit.
6. Squash or Fixup one commit into the preceding one.
7. Drop one commit.
8. Start the rebase and confirm the rewritten order/messages.
9. Repeat with an Edit action and verify the operation banner pauses and Continue works.
10. Repeat with a deliberate conflict and verify the operation banner opens Conflict Center, then Continue completes the rebase.

## Manual Git Intelligence QA

- Search `message:fix`.
- Search `author:<name>`.
- Search `file:src/App.tsx`.
- Search `change:someSymbol`.
- Search `ref:main..feature`.
- Compare `main` and a feature branch; verify merge base and unique commits.
- Load file history with Follow Renames on/off.
- Load a 1-based line range and compare with file history.
- Run blame at working tree and a named revision.
- Open Contributors and use commit counts/activity as sanity checks.
- Create a dirty secondary worktree and verify a WIP card appears in History.
- Toggle the Changes column and confirm the setting persists.

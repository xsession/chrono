# GitAhead Next v5

A standalone, Qt-free Git desktop client based on the GitAhead modernization work.

## Stack

- Tauri 2 / Rust backend
- React 19 + TypeScript
- Vite
- Native Git CLI on desktop
- git2-rs foundation on Android

## Major features

- repository workspace and working-tree management
- stage / unstage / commit / fetch / pull / push
- branch and worktree workflows
- persistent merge/rebase/cherry-pick/revert operation state
- three-way Conflict Center with Git index stage 1/2/3 support
- interactive rebase planner: pick/reword/edit/squash/fixup/drop/reorder
- optional rebase `--update-refs` support
- Git Intelligence workbench inspired by public GitLens workflows:
  search, compare, file history, line history, blame, contributors and WIP/worktrees
- command palette and keyboard-centric navigation
- clean-room GitLens research documentation in `docs/`

## Prerequisites

- Node.js 20+
- Rust stable + Cargo
- Git 2.38+ recommended (required for rebase `--update-refs`)
- Tauri 2 platform prerequisites for your OS

## Run

```bash
npm install
npm run typecheck
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

## Build

```bash
npm run build
npm run tauri build -- --ci
```

## Tests

```bash
npm run test:markers
npm run test:git
```

The shell smoke tests create temporary Git repositories and do not modify your own repositories.

## Notes

The desktop backend uses argument-array `git` process execution, not shell command strings.
Some advanced Android workflows intentionally report unsupported until matching native sequencer/conflict implementations are completed.

This archive is the **standalone Qt-free application repository**. It does not require the legacy Qt/C++ GitAhead source tree.

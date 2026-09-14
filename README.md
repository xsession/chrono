# Chrono Next v6

A standalone Git web client (single Node process: TypeScript API server + React UI),
rewritten from the Tauri/Rust stack to pure TypeScript.

## Stack

- Node.js 22+ (runs the TypeScript backend directly via native type-stripping — no build step for the server)
- React 19 + TypeScript
- Vite (frontend dev server + production build)
- Native Git CLI on the server host (all git logic is TypeScript wrappers over `git`)

## Architecture

```
Browser (React 19)  ──fetch /api/<command>──▶  Node HTTP server (TypeScript)
   dev: Vite :1420 proxies /api :1421            └──▶ git CLI
   prod: server :1421 serves dist/ directly
```

- `server/` — the full TypeScript backend. Every former Tauri command is now a
  `POST /api/<command>` route (see `server/index.ts` for the route table).
  - `server/src/lib/git.ts` — git CLI wrapper + log/numstat parsers
  - `server/src/backend.ts` — summary, history, status, branches, stage, commit,
    fetch/pull/push, clone, branches, workflows (worktrees, stashes, bisect, …)
  - `server/src/operationState.ts` — merge/rebase/cherry-pick/revert detection + continue/skip/abort
  - `server/src/conflictCenter.ts` — three-way Conflict Center (index stages 1/2/3)
  - `server/src/rebasePlanner.ts` — interactive rebase planner (pick/reword/edit/
    squash/fixup/drop, `--update-refs`, todo injected via GIT_SEQUENCE_EDITOR)
  - `server/src/insights.ts` — search, compare, file/line history, blame,
    contributors, worktrees
  - `server/src/provider.ts` — pull requests (GitHub/GitLab/Gitea/Forgejo)
  - `server/src/workspaces.ts` — workspace persistence (`~/.chrono-next/workspaces.json`)
- `src/` — the React UI (unchanged apart from `api.ts` now using `fetch` and
  `prompt()`-based path input where Tauri used native dialogs).

## Prerequisites

- Node.js 22+
- Git 2.38+ recommended (required for rebase `--update-refs`)

## Run

Easiest — the launchers install Node.js 22+ if it is missing, install npm
dependencies, build and start:

```bash
run.bat          # Windows: opens http://localhost:1421
./run.sh         # Linux/macOS: opens http://localhost:1421
# add --check to only install + build without starting
```

Manually:

```bash
npm install
npm run typecheck
npm run dev            # API server :1421 + Vite dev server :1420
# open http://localhost:1420
```

## Production build

```bash
npm run build          # typecheck + vite build -> dist/
npm start              # API server on :1421 also serves dist/
# open http://localhost:1421
```

Environment: `CHRONO_PORT` (default 1421), `CHRONO_HOST` (default 127.0.0.1),
`CHRONO_CONFIG_DIR` (default `~/.chrono-next`).

## Tests

```bash
npm run test:markers   # pure TS unit tests (conflict marker parsing)
npm run test:git       # shell smoke tests against real temp Git repositories
npm run test:api       # boots the API server and exercises every /api route
```

The shell smoke tests create temporary Git repositories and do not modify your own repositories.

## Notes

- The browser UI cannot pick directories natively; "Open repository" and the
  clone destination use a path prompt (the path must exist on the server host).
- Clone/fetch/push accept optional username+token in the request for HTTPS
  credentials (embedded in the clone URL); otherwise the server's git
  credential helpers are used.

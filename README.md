# Chrono Next

A Git client with a web build, an Electron desktop build, and an Android
companion, all driven by one TypeScript codebase (Node HTTP server + React UI).
Rewritten from the original Tauri/Rust stack to pure TypeScript.

## Stack

- Node.js 22+ (runs the TypeScript backend directly via native type-stripping — no build step for the server)
- React 19 + TypeScript
- Vite (frontend dev server + production build)
- Electron (optional desktop shell)
- Capacitor 7 (optional Android companion)
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
  - `server/src/insights.ts` — search, compare, range-diff review, repository
    health, file/line history, blame, contributors, worktrees
  - `server/src/commitWriter.ts` — local-first staged-diff commit drafting
    with optional loopback Ollama and deterministic offline fallback
  - `server/src/provider.ts` — pull requests (GitHub/GitLab/Gitea/Forgejo)
    with the Git Intelligence pull-request triage tab and remote auto-detection
  - `server/src/workspaces.ts` — workspace persistence (`~/.chrono-next/workspaces.json`)
- `src/` — the React UI.
  - `src/graph.ts` — commit-graph layout engine (topological depth + lane
    assignment), unit-tested in `tests/graph-layout.test.ts`.
  - `src/components/CommitGraph.tsx` — History timeline: real branch/merge
    connections, branch-name chips, HEAD marker, filtered-history gaps.
- `electron/` — desktop shell. Spawns the backend itself on a random port in
  14210-14310 (no separate server needed).
- `android/` — Capacitor companion. A client that connects to a running Chrono
  server over HTTPS (enter its address via the Backend button in the app).

## Prerequisites

- Node.js 22+
- Git 2.38+ recommended (required for rebase `--update-refs`)
- Electron desktop: nothing extra (the starter installs it)
- Android companion: JDK 17+ and the Android SDK

The Git Intelligence view includes offline history search/compare/range review,
repository-health, file history/blame/contributor/activity views plus a
provider-aware pull-request triage surface. Range review compares two patch
series versions from a common base using Git's native `range-diff`; health
metrics are read-only until an explicit object scan is requested.
It detects SSH and HTTPS remotes, supports GitHub, GitLab, Gitea and Forgejo,
and keeps entered provider tokens in memory only. File history now includes a
revision viewer with previous/next navigation, root-revision previews and
unified two-revision diffs. The Changes view also has a local commit-writing
assistant: it can use Ollama on `127.0.0.1:11434` when available and otherwise
creates a conservative offline draft from the staged index. Drafts support
Conventional Commit or plain imperative style plus safe `#123`/`PROJECT-123`
issue references. The Worktrees view reports dirty-file and conflict counts
for every linked checkout and can open a selected worktree. Changes also
supports selecting individual unstaged text hunks for the index, while commit
quality checks provide live subject/style/reference feedback without blocking
manual commits. Set
`CHRONO_LOCAL_AI_MODEL` to change the default model (`qwen2.5:3b`).

History also supports persisted graph scope (all refs, current branch, or a
local branch) and guarded reset-to-selected-commit actions for soft, mixed and
hard reset modes. The History graph also provides persisted per-reference
visibility controls for hiding or soloing local and remote branches. Large
history windows keep their complete graph layout and page navigation while
mounting only an overscanned viewport of rows, so thousands of commits remain
comfortable to browse.

## Run (web)

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

## Desktop (Electron)

The starter installs Node 22+ if missing, builds, and launches the desktop app:

```bash
starter-electron.bat                                  # build + launch (Windows)
./starter-electron.sh                                 # build + launch (Linux/macOS)
# --check    install + build only, do not launch
# --packager build installers into release/
```

The backend starts inside the app on a port in 14210-14310 — no other process
needed.

## Android (companion)

The starter installs Node 22+, JDK 17+ and the Android SDK as needed, then
builds the debug APK:

```bash
starter-android.bat            # build + APK (Windows)
./starter-android.sh           # build + APK (Linux/macOS)
# --check    install + build only, do not build the APK
# --open     open the project in Android Studio
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`. The companion is a
client: run a Chrono server (web build) over HTTPS, then enter its address in
the app's Backend dialog.

## Production build (web)

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
npm run test:graph     # commit-graph layout engine unit tests
npm run test:git       # shell smoke tests against real temp Git repositories
npm run test:api       # boots the API server and exercises every /api route
npm run test:ui-contract # verifies every visible view/control remains wired
```

The shell smoke tests create temporary Git repositories and do not modify your own repositories.

## Notes

- The browser UI cannot pick directories natively; "Open repository" and the
  clone destination use a path prompt (the path must exist on the server host).
  The Electron build adds a real native directory picker.
- Clone/fetch/push accept optional username+token in the request for HTTPS
  credentials (embedded in the clone URL); otherwise the server's git
  credential helpers are used.
- The Android companion requires the Chrono server to be reachable over HTTPS
  (Capacitor uses an https scheme and disallows mixed content).

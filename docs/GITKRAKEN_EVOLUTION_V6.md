# Chrono v6 — GitKraken-grade Evolution Plan

Source of truth for this release: the reverse-engineered GitKraken Desktop
workspace at `/media/riko/model_store/GIT_/gitkraken_clone/`
(`GITKRAKEN-RE-FINDINGS.md`, `ipc-channels-full.txt`, `c6-saga-*` artifacts,
and the clean-room reference implementation in `gitkraken-ts/src`).

Goal: port GitKraken's *architecture* (not its code) into Chrono — the saga
bridge as external-control API, deep links, executor-correlated git logging,
multi-repo tabs, terminal panel, fuzzy finder, toasts, keybindings/zoom.

## Phase map

| # | Feature | RE evidence | Status |
|---|---------|-------------|--------|
| 1 | Saga bus + REQUESTABLE registry (68 sagas / 26 namespaces) | §4, §11.2, `c6-requestable-final.txt` | TODO |
| 2 | Toast/notification system (Toast.* namespace) | §4 Toast(8) | TODO |
| 3 | Deep links `chrono://repo\|branch\|commit\|search\|workspaces\|preferences` + cold-start replay | §7 handleUri saga, URI_COMMAND_NAME | TODO |
| 4 | Git executor layer: command IDs, structured log ring buffer, `/api/git/log` | §11.3 GIT_EXECUTOR_COMMAND_ID, `c5-git-exec*.txt` | TODO |
| 5 | Multi-repo tabs (Tabs.* namespace: open/close/select/reopen) | §4 Tabs(9), RepoManagement | TODO |
| 6 | Fuzzy finder over commits/branches/tags/files (View.toggleFuzzyFinder) | §4 View(7) | TODO |
| 7 | Keybindings modal + zoom up/down/reset (View.*) | §4 View(7) | TODO |
| 8 | Terminal panel: node-pty + xterm.js, tabs (TerminalPanel.* namespace) | §4 TerminalPanel(6) | TODO |
| 9 | Window REPLICA state sync for Electron multi-window | §10 STATE/UPDATE deltas | TODO |

## Wire protocol (kept GitKraken-compatible where it matters)

- Saga invoke: `POST /api/saga/invoke { name, args }` → `{ ok, result | error }`.
  Names are the RE wire names (`Repo.openInTerminal`, `Tabs.selectNextTab`, …).
- Deep link URI scheme: `chrono://<command>?params` (GitKraken uses
  `gitkraken://`; we keep our own brand but same command vocabulary:
  repo, branch, commit, search, workspaces, preferences, login→noop).
- Git log entries: `{ id, ts, args, cwd, durationMs, exitCode, stderrTail }`.

## Verification gates (per phase)

1. `npm run typecheck` clean.
2. `npm run build` clean.
3. `npm run test:api` green (new routes covered).
4. Browser E2E against a running server on a temp repo for UI phases.

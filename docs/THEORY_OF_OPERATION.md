# Chrono: theory of operation

This document explains how Chrono works inside: which processes run, how a
click becomes a git command, where state lives, and how each subsystem does
its job. It is written for contributors and for anyone who wants to know what
Chrono does to their repositories. The [README](../README.md) lists the
features and the [tutorial](TUTORIAL.md) shows how to use them.

Contents:

1. [Design principles](#1-design-principles)
2. [Processes and front-ends](#2-processes-and-front-ends)
3. [Transport: from the UI to the server](#3-transport-from-the-ui-to-the-server)
4. [Running git](#4-running-git)
5. [Where state lives](#5-where-state-lives)
6. [Live changes](#6-live-changes)
7. [Undo and redo](#7-undo-and-redo)
8. [The commit pipeline](#8-the-commit-pipeline)
9. [Line-level staging](#9-line-level-staging)
10. [Merges, rebases and conflicts](#10-merges-rebases-and-conflicts)
11. [Submodule trees](#11-submodule-trees)
12. [Forks and upstreams](#12-forks-and-upstreams)
13. [The AI assistant](#13-the-ai-assistant)
14. [Self-hosted llama.cpp](#14-self-hosted-llamacpp)
15. [The landscape map](#15-the-landscape-map)
16. [The explorer, shell integration and deep links](#16-the-explorer-shell-integration-and-deep-links)
17. [Hosting providers](#17-hosting-providers)
18. [The React UI and the commit graph](#18-the-react-ui-and-the-commit-graph)
19. [The terminal UI](#19-the-terminal-ui)
20. [Security model](#20-security-model)
21. [Testing](#21-testing)
22. [Environment variables](#22-environment-variables)

---

## 1. Design principles

- **git is the source of truth.** Chrono keeps no database of the
  repository. Every view is computed from git's own output, and every change
  is made by running git. Anything Chrono does can be reproduced or inspected
  on the command line, and anything done on the command line shows up in
  Chrono.
- **The `git` CLI, not a library.** All git logic is TypeScript that runs the
  native `git` binary with an argument array. Behaviour, hooks, config,
  credential helpers and performance features are exactly git's.
- **Never through a shell.** Arguments are passed as arrays, so branch names,
  file names, commit messages and custom-command parameters are never
  interpreted by a shell.
- **Local first.** Nothing leaves the machine unless you choose a hosting
  provider or a remote AI provider. Tokens for hosting services live only in
  the browser tab's session storage.
- **One backend, several front-ends.** The web build, the desktop app, the
  Android companion and the terminal UI all use the same server code, so a
  feature works the same everywhere.
- **Never lose work.** Destructive operations ask first, prefer `--keep` and
  `--ff-only` modes, are journaled for undo, and refuse to run when the
  repository changed underneath them.

## 2. Processes and front-ends

```
                    ┌─────────────────────────── Node server (server/index.ts) ────────────────────────┐
 Browser / Electron │ RPC socket + HTTP routes → modules (backend, gkOps, features, forks, ai, …)       │
 renderer (React) ──┤        │                                                                         │
 Android companion  │        ├─ git lanes ──▶ git CLI (one bounded pool per repository)                 │
                    │        ├─ repo watchers (fs.watch / git status polling)                            │
                    │        ├─ PTYs for the terminal panel (node-pty)                                   │
                    │        └─ llama-server child process (+ watchdog)                                  │
                    └───────────────────────────────────────────────────────────────────────────────────┘
 Terminal UI (tui/main.ts) ── imports the same server modules directly, no HTTP
```

**Web, development.** `npm run dev` (`server/dev.mjs`) starts the API server
on port 1421 and Vite on 1420; Vite proxies `/api` to the server.

**Web, production.** `npm start` runs `server/index.ts` with Node's
`--experimental-strip-types` (no build step for the server) and serves the
built `dist/` on the same origin.

**Desktop (Electron).** `electron/main.cjs` starts the server as a child
process: Electron's own binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), on
127.0.0.1 and a random port from 14210 upwards, then loads the UI from it.
The child's stdin is a lifeline: when the app quits it closes the pipe
(`CHRONO_PARENT_PIPE=1`), and the server shuts down cleanly, unloading local
AI models; if the app crashes the pipe closes too. The server's output is also
written to `<userData>/logs/backend.log`. Packaged builds keep `server/`,
`dist/`, `public/` and the native modules in `app.asar.unpacked`, so the
backend runs as ordinary files. `chrono --tui` runs the terminal UI with the
same binary instead of opening a window, which is how the installed
`chrono-tui` works without a separate Node.

**Android.** A Capacitor app that is only a client: it connects to a Chrono
server elsewhere over HTTPS and sends the server's API token.

**Terminal UI.** `tui/main.ts` imports the server modules and calls them
directly in its own process. See [section 19](#19-the-terminal-ui).

## 3. Transport: from the UI to the server

Every server operation is a named command, listed in the route table in
`server/index.ts`. A command can be called two ways:

- **RPC over one WebSocket** (`/api/rpc`, `server/src/rpc.ts`). The client
  sends `{ id, command, body }` and gets `{ id, ok, result }` or
  `{ id, ok: false, error, status }`. Browsers allow only about six HTTP
  connections per host; with several repositories open, slow git calls in
  one tab could hold all of them. One multiplexed socket has no such limit,
  answers arrive in any order, and `{ id, cancel: true }` abandons a request
  (its git reads are then killed, see below).
- **HTTP POST** `/api/<command>` with a JSON body: the fallback when the
  socket is unavailable, and the interface for scripts.

Errors are an `AppError` with a `kind` (`server/src/lib/errors.ts`) that maps
to an HTTP status; the message is what the UI shows.

Long operations (commit with hooks, fetch, pull, push) accept a client-chosen
**stream id**. The server collects the process output into that channel
(`server/src/lib/streams.ts`), and the client polls `stream_read` while the
request runs. That is how the live-output console works.

The **terminal panel** uses its own WebSocket (`server/src/terminal.ts`):
`create`/`input`/`resize`/`close` frames drive real PTYs from node-pty.

## 4. Running git

All git calls go through `runGit` in `server/src/lib/git.ts`:

- `GIT_TERMINAL_PROMPT=0`, so git never waits for a password on a terminal
  nobody sees; credential helpers still work.
- Output up to 256 MB (large blame and log output).
- Per-request diff options (ignore whitespace, diff algorithm) are inserted
  into every `git diff` the request runs.
- Each call is recorded (id, arguments, directory, exit code, duration) in a
  ring buffer that the UI's git log shows.

**Lanes.** Every repository (keyed by its path) has its own lane: a pool of at
most `CHRONO_GIT_PER_REPO` (default 8) concurrent git processes. A slow
repository therefore never delays another tab. Within a lane:

1. Commands are classified as reads or writes (`status`, `log`, `diff`,
   `rev-parse`… are reads; `branch -D`, `stash push`, `config --set`… are
   writes; sub-commands are checked individually).
2. Identical reads that are already running are **shared**: switching tabs
   fires the same `status` and `log` repeatedly, and they cost one process.
3. Every write increments the lane's **generation**, so a read started after
   a write never reuses output from before it.
4. A read whose every caller has gone away (the client cancelled, or left the
   tab) is **killed**. Writes are never killed.
5. Idle lanes of repositories no longer in use are forgotten.

## 5. Where state lives

**Chrono's configuration directory** is `CHRONO_CONFIG_DIR`, by default
`~/.chrono-next`:

| Path | Contents |
|---|---|
| `workspaces.json` | The local repositories list and its order |
| `undo-journal.json` | Undo/redo entries per repository |
| `ai.json` | AI provider settings and keys (mode 0600, keys never sent to clients) |
| `profiles/<name>.gitconfig` | Identity profiles (name, email, signing key) |
| `llama/engines/<build>-<variant>/` | Unpacked llama.cpp builds, with `engine.json` |
| `llama/downloads/` | Archives while they download (`.part` files resume) |
| `models/` | GGUF models (the folder can be changed in settings) |
| `landscape/` | Landscape scans cached per repository and commit |

**In the repository**, Chrono uses only standard git places, so other tools
understand them:

| What | Where |
|---|---|
| Identity profile attached to a repository | `include.path` in `.git/config` pointing to the profile |
| Profile for every repository under a folder | `includeIf "gitdir:<folder>/"` in the global config |
| Trusted repositories owned by other users | `safe.directory` in the global config |
| Branch parent (stacked branches) | `branch.<name>.chronoParent` |
| Issue link rules | `chrono.autolink` |
| Archived branches | `refs/chrono/archive/*` |
| Commit notes | `refs/notes/commits` |

**In the browser** (`localStorage`): layout widths, view
choices, the landscape heatmap preferences and trail, and similar UI state.
Hosting-provider tokens are in `sessionStorage`, so they are gone when the
browser session ends; the server never stores them.

## 6. Live changes

`server/src/repoWatch.ts` keeps one watcher per repository, shared by every
client:

- **Working tree:** one non-recursive `fs.watch` per directory git cares
  about: directories of tracked files (submodules included) and untracked
  directories that aren't ignored. Ignored trees such as `node_modules` are
  never watched, so big repositories stay cheap. New directories are picked
  up from their parent's events.
- **Git directory:** `index` (a *worktree* change: only the status moved),
  and `HEAD`, refs, `packed-refs` and merge/rebase/cherry-pick state (a *git*
  change: the graph must reload). Submodule git directories are watched for
  `HEAD` and `index`.
- **Fallback:** if the system runs out of inotify watches, or the tree is
  huge, it compares `git status` once a second instead.

Each repository has a version counter. Clients long-poll with
`waitForChange(path, since)`, which returns as soon as the version passes
`since` (or after a timeout). Events settle for 80 ms before the version
moves, so an editor saving ten files or a checkout causes one refresh. The UI, the landscape heatmap and the
terminal UI all use this.

## 7. Undo and redo

`server/src/gkOps.ts` wraps every mutating action performed through Chrono
(commit, checkout, branch create/delete, reset, merge, pull, cherry-pick,
revert…) in a snapshot of `refs/heads/*` and `HEAD` before and after.

- **Undo** restores the *before* snapshot: it recreates deleted branches,
  removes created ones, switches back, and resets the moved branch. Commits
  are undone with `reset --soft` (the changes stay staged); everything else
  uses `reset --keep`, which refuses to discard local edits.
- **Redo** re-applies the *after* snapshot.
- Both first check that the branches and HEAD are still as Chrono left
  them; if something outside Chrono moved a ref, they refuse ("the repository
  changed outside Chrono") rather than guess.
- Up to 50 entries per repository, saved to `undo-journal.json` with an
  atomic write, so the journal survives restarts.

## 8. The commit pipeline

A commit from the commit panel (or the terminal UI's `c`) runs
`commitWithHooks` in `server/src/features.ts`:

1. **Identity.** If *Commit as* chose a profile, its name and email are passed
   as `GIT_AUTHOR_*` and `GIT_COMMITTER_*` environment variables for this
   commit only. *Always use here* instead writes an `include.path` to the
   profile, which changes the repository's identity for every tool.
2. **Submodules first** (`server/src/nestedCommit.ts`, below).
3. **The commit itself**, with `--signoff`, `--amend` or `--no-verify` as
   chosen and signing as configured in git. Hook output is streamed live.
4. **Journal** entry for undo.

### Commits through submodules

Plain git records a submodule's *old* commit when the parent is committed and
leaves the submodule's own edits behind (the "-dirty" state). Chrono treats a
submodule's staged changes as part of the commit:

- **Staging.** `stagePathsNested` turns `git add <submodule>` into "stage
  everything inside the submodule (its nested submodules first), then stage
  the gitlink". Unstaging works the same way in reverse. The panels use
  `src/submoduleStaging.ts` to decide which changed submodules count as
  staged, and the commit box shows the plan ("Commits first in …").
- **Committing.** `commitSubmodules` walks the tree depth first (up to a
  fixed maximum depth). For each submodule it first visits that submodule's
  own submodules; if one of them produced a commit, it runs `git add <child>`
  in the submodule to stage the child's new commit id. Then, if the
  submodule has anything staged, it commits it with the same message,
  sign-off, hook setting and identity. The repository the commit started in
  is committed last, by the caller.
- **Detached HEAD.** `git submodule update` leaves submodules detached. Before
  committing in one, Chrono looks for local branches pointing at its HEAD; if
  there is exactly one, it switches to it, so the commit lands on a branch.
  Otherwise the commit is made detached and reported as such.
- **Failure.** A failing commit (a hook, an empty identity) raises
  `NestedCommitError` naming the submodule. Commits already made stay; the UI
  offers *Commit anyway* for hook failures.

The result lists every submodule commit (path, id, detached, branch attached
to), which the UI shows as "also committed in lib".

## 9. Line-level staging

`server/src/lineStaging.ts` stages, unstages or discards individual lines. The
client shows a diff parsed into hunks and sends the selected (hunk, line)
pairs. The server rebuilds a patch that contains only those changes and
applies it with `git apply --recount`:

| Action | Diff used | Applied |
|---|---|---|
| Stage | unstaged (index → worktree) | forward onto the index (`--cached`) |
| Unstage | staged (HEAD → index) | reversed onto the index (`--cached -R`) |
| Discard | unstaged | reversed onto the working tree (`-R`) |

For a forward patch, unselected `-` lines become context and unselected `+`
lines are dropped; a reverse patch does the opposite. Either way only the
selected lines change. Untracked files, files without a trailing newline,
and a diff that changed since it was shown (refused) are handled explicitly.

## 10. Merges, rebases and conflicts

- **Operation state** (`server/src/operationState.ts`) detects an ongoing
  merge, rebase, cherry-pick or revert from the git directory and offers
  continue, skip and abort. The UI shows it as a banner.
- **Conflict prediction:** before a merge, rebase, cherry-pick, revert or a
  drag-and-drop, `git merge-tree` performs the merge in memory. Files that
  would conflict are listed before the working tree is touched.
- **Conflict Center** (`server/src/conflictCenter.ts`) reads index stages 1,
  2 and 3 (base, ours, theirs) for each conflicted file, and marks the
  resolution with `git add -A -- <file>`.
- **Interactive rebase** (`server/src/rebasePlanner.ts`) builds the todo list
  from the planner's table and starts `git rebase -i` with
  `GIT_SEQUENCE_EDITOR` set to a tiny program that writes exactly that list
  (passed in `CHRONO_REBASE_TODO`). `--update-refs` keeps stacked branches
  attached.
- **Stacked branches** store their parent in `branch.<name>.chronoParent`;
  *Restack* is `rebase --update-refs` from the tip of the stack.

## 11. Submodule trees

`server/src/submodules.ts` builds the overview with one
`git submodule status --recursive`, then one
`git status --porcelain=v2 --branch` per initialised submodule (in a bounded
pool) for branch, upstream and change counts. A parent's change count ignores
dirty children (`--ignore-submodules=dirty`) but still counts a moved
gitlink, so each change is reported where it is. *Behind branch* compares
the recorded commit with the tracking branch (`branch` in `.gitmodules`, else
`origin/HEAD`). Bulk actions run one nesting level at a time, several
submodules at once; *Run command* is `git submodule foreach`.

## 12. Forks and upstreams

`server/src/forks.ts` works from the remotes alone; it needs no network until
you sync.

**Detection.** For each checkout (the repository and every initialised
submodule, depth first):

- `origin` is the remote named `origin` (or the first remote).
- `upstream` is the remote named `upstream`, or else another remote whose
  repository name equals origin's but whose owner differs (a remote called
  `alice` pointing at `alice/app` counts).
- With an upstream it is a **fork**; with only origin it is **plain**; with no
  remote, **local**.

**Status.** The upstream's default branch is `refs/remotes/<upstream>/HEAD`,
or the first of `main`, `master`, `develop`, `trunk` that exists. Then, with
`git rev-list --count`:

| Field | Range |
|---|---|
| `behind` | local default branch `..` upstream default branch |
| `ahead` | upstream default branch `..` local default branch |
| `originBehind` | your fork on the server (`origin/<base>`) `..` upstream |
| `branchBehind` | the checked-out branch `..` upstream (when it isn't the default) |

`fetchedAt` is the time of `FETCH_HEAD`. A compare URL for a pull request to
upstream is built per provider (GitHub compare, GitLab new merge request,
Bitbucket Server create page, Gitea compare).

**Sync** (`syncFork`):

1. Fetch the upstream.
2. If the local default branch already equals upstream's, report "up to date".
3. If it has commits upstream lacks (`ahead > 0`), stop and say so: Chrono
   never rewrites history.
4. If it is checked out: `git merge --ff-only upstream/<base>`.
5. If it isn't: `git fetch . refs/remotes/upstream/<base>:refs/heads/<base>`,
   which moves the branch without touching the working tree and refuses
   anything but a fast-forward.
6. If it doesn't exist yet: create it tracking upstream.
7. Optionally push it to origin (`refs/heads/<base>:refs/heads/<base>`).

*Sync all forks* runs this for every fork in the tree. Syncing a submodule
moves its checkout, so its parent then shows a moved gitlink to commit.
*Merge upstream* merges upstream's default branch into the current branch
(with conflict handling as usual). *Find / add upstream* asks the hosting
service's public API for the repository's parent (GitHub, GitLab, Gitea,
Bitbucket Server), adds it as `upstream` and fetches it.

The UI reads the tree with the `fork_tree` route; the toolbar pill, the left
panel, the submodule list and mind map, and the terminal UI's status panel
all use the same data.

## 13. The AI assistant

`server/src/ai.ts` routes every assistant request (commit drafts,
explanations, the connection test) to the provider chosen in settings:

| Provider | How Chrono talks to it |
|---|---|
| `llamacpp` | Starts or reuses its own `llama-server` ([section 14](#14-self-hosted-llamacpp)), then OpenAI-compatible `/v1/chat/completions` |
| `network` | OpenAI-compatible `/v1/chat/completions` at the configured address, with an optional API key; `/v1/models` lists models |
| `ollama` | Ollama's `/api/generate` |
| `claude` | The official Anthropic SDK (`@anthropic-ai/sdk`), model Claude Opus 5.5 at low effort, with server-side fallback to another model if a request is declined |
| `off` | None |

When a provider can't answer, it raises `AiUnavailableError` with a reason,
and the caller falls back to **offline rules**: `server/src/commitWriter.ts`
writes a conservative draft from the staged diff (what changed, in
Conventional Commit or imperative style, with safe issue references) without
inventing behaviour. The UI shows which source produced the text and why the
model was not used. Drafts follow `AGENTS.md` and
`.github/copilot-instructions.md` when the repository has them.

**Keys** (Claude, the network server, the self-hosted server's network key)
are stored only in `ai.json`; the settings route returns whether a key is
set, never the key. Claude without a stored key uses the SDK's own
resolution (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, an `ant auth login`
profile).

**Preloading.** At server start and whenever the AI settings change,
`warmUpAi` loads the chosen local model so the first request doesn't wait:

- llama.cpp with *Start automatically*: start `llama-server`.
- Ollama: an empty `/api/generate` with `keep_alive: "10m"`, renewed every
  4 minutes. A lease instead of "forever" means that if Chrono dies the
  renewals stop and Ollama unloads the model by itself.
- Switching provider stops what the preload started (but not a server you
  started by hand in settings).

On a normal shutdown `shutdownAi` stops `llama-server` and unloads the Ollama
model (`keep_alive: 0`). `CHRONO_NO_AI_PRELOAD=1` disables preloading.

## 14. Self-hosted llama.cpp

`server/src/localLlm.ts` manages llama.cpp builds, models and the server
process.

**Builds.** `listEngineAssets` reads ggml-org/llama.cpp's GitHub releases
(cached for 10 minutes; `CHRONO_LLAMA_RELEASES_API` overrides the URL) and
picks the newest release that has archives for this platform, named
`llama-<build>-bin-<os>[-<variant>]-<arch>.<ext>`. Variants (CPU, Vulkan,
CUDA, ROCm, SYCL, OpenVINO, Metal) are listed with a note, CPU or Metal
recommended. On Windows, CUDA builds also need the release's `cudart-`
runtime archive, which is installed with them. Archives (`.tar.gz`, or
`.zip` on Windows) are unpacked with the system `tar` into
`llama/engines/<build>-<variant>/`. The binary used is the one chosen in
settings, else the newest installed build.

**Downloads** run as background jobs with progress:

- A `.part` file is resumed with an HTTP `Range` request; if the server
  ignores it (no `206`), the download restarts.
- Free space is checked first (`statfs`).
- Speed is an exponential moving average of one-second samples
  (`0.8 × old + 0.2 × new`), and the UI derives the time left from it.
- A size mismatch at the end is an error that asks you to resume.
- Only `https` URLs are accepted for models.

**The server.** `startLlamaServer`:

1. Resolves the binary and the model, and keeps an already running server if
   its settings match (otherwise it replaces it).
2. Refuses a port another server already answers on, then builds the
   arguments: model, host (127.0.0.1, or 0.0.0.0 with *Listen on the local
   network*, plus `--api-key` when a network key is set), port, context size,
   GPU layers.
3. For *Keep the model in RAM*, asks the binary which option it knows
   (`--help`, cached per binary): newer builds take
   `--load-mode mmap+mlock`, older ones `--mlock`.
4. Starts it with the library path (`LD_LIBRARY_PATH`, `DYLD_LIBRARY_PATH` or
   `PATH`) pointing at the build's folder, collects its log, and polls
   `/health` until the model has loaded (up to 3 minutes).

**Unloading.** The model must leave memory when Chrono goes away:

- A normal shutdown calls `stopLlamaServer`.
- Any other orderly exit is covered by a `process.on("exit")` handler.
- A **watchdog**, a tiny separate Node process started with each server,
  checks every second whether the Chrono backend still exists and stops
  `llama-server` if it doesn't. It covers crashes, hard kills (Windows ends
  processes with `TerminateProcess`, which runs no handlers) and a killed
  desktop app, and quits by itself once `llama-server` is gone.

## 15. The landscape map

**The scan** (`server/src/landscape.ts`, `landscapeParse.ts`) reads tracked
files only (`git ls-files --recurse-submodules`, up to 12,000 files), and for
each source file records its size, lines, and the imports, types and symbols
found by parsers for about 15 languages plus Renode's `.repl`, `.resc` and
`.robot`. Scans are cached in memory (8 entries) and on disk under
`landscape/`, keyed by repository and HEAD; *Rescan* reads the working tree
again.

**Recent changes for the heatmap** (`server/src/landscapeRecent.ts`) are not
cached, because the working tree changes without HEAD moving. One
`git log --no-merges --name-only --since=<days>` per repository (up to 4,000
commits, nested submodules up to 4 levels with their paths prefixed) gives,
per file, the time of its newest commit and the number of commits in the
window. `git status` marks uncommitted files. The server's clock is sent
along, so ages don't depend on the client's. The map turns recency and
frequency into the glow, draws a ring for uncommitted edits, and dims the
rest by the chosen strength. The view requests fresh data after every scan
and on every live change.

**The map** is a self-contained page (`public/landscape/index.html`) in a
sandboxed iframe with an opaque origin. It can't reach Chrono's API or the
network. It talks to `LandscapeView.tsx` only through `postMessage`: the
view sends `scan`, `recent`, `theme`, `loading` and `error`; the map sends
`ready`, `rescan`, `file` (open a file in Explorer, History or Blame),
`store` (its saved trail) and `pref` (heatmap settings, kept in
`localStorage`).

## 16. The explorer, shell integration and deep links

**Explorer** (`server/src/explorer.ts`) lists one folder at a time and
computes each entry's overlay from a single
`git status --porcelain=v1 -z --untracked-files=all --ignored=matching`.
A folder's overlay is the most severe status found below it (conflicted,
deleted, modified, renamed, added, staged, untracked, in that order), unless
the folder is ignored or entirely untracked. All TortoiseGit menu actions go through one dispatcher with
argument arrays.

**Shell integration** (`shell-integration/`) adds a *Chrono* submenu to the
operating system's file manager. It starts the desktop app as
`Chrono --tgit=<action> <paths…>`, which becomes the deep link
`chrono://tgit?action=…&path=…`; the web build accepts the same as
`?chrono=tgit&action=…&path=…`.

**Deep links and sagas.** `chrono://repo|branch|commit|search|workspaces|preferences|login|tgit|explorer`
links (parsed in `src/deeplinkParse.ts`) are dispatched through a saga
registry (`src/sagas/`) modelled on GitKraken's requestable sagas; the
server's `server/src/sagas.ts` handles the repository-level ones, so
`POST /api/saga/invoke` works without a browser.

## 17. Hosting providers

`parseRemote` (`server/src/features.ts`) recognises SSH and HTTPS remotes and
decides the provider: GitHub, GitLab, Gitea/Forgejo, or Bitbucket Server /
Data Center (`/scm/PROJECT/repo.git` URLs, SSH on port 7999, or a host
named bitbucket; bitbucket.org is left alone). For servers whose URL doesn't
give the kind away, the pull-request dialog has a provider picker; the
choice and the API base are remembered per host.

`server/src/provider.ts` implements, per provider with Node's `fetch`:
creating pull/merge requests (Bitbucket: `fromRef`/`toRef`, drafts on 8.18+),
listing them for triage (Bitbucket's paged `values`), CI checks (GitHub
Actions, GitLab pipelines, Bitbucket build statuses) and re-runs where the
service allows it, and parent lookup for forks. Tokens come from the client
with each request; the client keeps them per host in `sessionStorage`.

## 18. The React UI and the commit graph

The UI (`src/`) is React 19. `App.tsx` holds the open tabs, the active view
and the per-repository state; each tab keeps its last data so switching is
instant while a refresh runs in the background. All server calls go through
`src/api.ts` (RPC with HTTP fallback). Dialogs are promise-based
(`DialogHost`), toasts go through a small bus, and the command palette is a
list of commands with fuzzy matching.

**The graph** (`src/graph.ts`, pure and unit-tested) assigns each commit a
topological row (children above parents), a unique render row and a lane,
and computes for every row the segments arriving at the node, leaving it, and
passing through. "Passing through" is derived from edge spans (every
child→parent edge is active in each band strictly between the two rows), so
lanes stay continuous when several commits share a depth. A branch whose
parent another lane is already waiting for keeps its own lane down to that
parent and turns in with a rounded elbow. Lane colours are CSS variables, so
the colour-blind palette is a style change, not a re-layout.

**Rendering.** Nodes carry the author's initials on a colour hashed from the
email; merges are small dots and HEAD has a dashed ring. The *Branch / Tag*
column puts the refs pointing at a commit on its row, joined to the node by a
line; local and remote-tracking twins share a pill, and long names shrink
their folder part first. Large history windows keep the full layout but
mount only the rows in view plus an overscan, so thousands of commits scroll
smoothly. Signature badges are verified only for rows on screen.

## 19. The terminal UI

`tui/main.ts` is a single file with no dependencies beyond Node:

- **Screen.** It switches to the alternate screen, hides the cursor and
  redraws everything on each change with plain ANSI sequences (positions,
  colours, clear-line). Text is cleaned of control characters, so file names
  and git output can't move the cursor. Panels are boxes sized from the
  terminal; below 60×16 it shows a message instead, and redraws on resize.
- **Data.** `loadAll` calls the same modules the server uses (`backend`,
  `gkOps`, `features`, `forks`, `ai`…) in parallel: status, branches, the log
  with its graph, stashes and the fork tree.
- **Live refresh.** A loop awaits `waitForChange` from `repoWatch.ts`, so
  changes from other tools appear without polling the screen.
- **Keys.** Keypresses (Node's `readline` keypress events in raw mode) are
  queued on a promise chain, so none are lost while an action runs. Actions
  go through `act()`, which shows progress and the result.
- **Exit.** `q` restores the main screen and the cursor; an exit handler
  does the same if the process ends any other way.

Because it uses the server modules, nested submodule commits, the undo
journal, hooks, AI drafts and fork sync behave exactly as in the app.

## 20. Security model

The server can run git, custom commands and a shell, so it doesn't trust a
request just because it reached localhost (`server/src/lib/requestGuard.ts`):

- **Cross-site requests** are refused: a foreign `Origin` header (which
  browsers always send for cross-site POSTs and WebSockets) is rejected,
  including for the terminal socket.
- **DNS rebinding** is refused: on a loopback server the `Host` header must be
  a loopback name.
- API POSTs must be `Content-Type: application/json`.
- To serve other machines, set `CHRONO_API_TOKEN`; a valid token authorises a
  request on its own. The server refuses to listen on a non-loopback address
  without one, unless `CHRONO_ALLOW_INSECURE_REMOTE=1`.
- Custom commands other than git, and "open in the file manager" actions,
  only run when the server listens on localhost.
- **Trust:** *Trust this folder* adds `safe.directory` only when git really
  reports dubious ownership for that path, so it can't be used to whitelist
  arbitrary folders.
- **AI keys** stay in `ai.json` (0600) and are never returned or logged. The
  landscape map runs sandboxed without network access.

## 21. Testing

Most tests build real repositories in a temporary directory and run real git;
there are few mocks.

| Area | Test |
|---|---|
| Graph layout, history window, ref groups and visibility | `tests/graph-layout.test.ts`, `history-window.test.ts`, `ref-groups.test.mjs`, `ref-visibility.test.ts` |
| Git lanes (sharing, generations, cancellation) | `tests/gitLanes.test.ts` |
| Line staging | `tests/line-staging.test.ts` |
| Nested submodule commits | `tests/nested-commit.test.ts` |
| Forks and upstreams | `tests/forks.test.ts` |
| Submodule overview | `tests/submodules.test.ts` |
| Live changes | `tests/repoWatch.test.ts` |
| AI providers, self-hosted llama.cpp (mock servers, watchdog) | `tests/ai.test.ts`, `tests/local-llm.test.ts` |
| Bitbucket Server (mock server) | `tests/bitbucket-server.test.ts` |
| Landscape scan | `tests/landscape.test.ts` |
| Trust, folders, stash history | `tests/trust.test.ts`, `folders.test.ts`, `history-stash.test.ts` |
| Roadmap features (signing, hooks, search, cleanup, profiles…) | `tests/roadmap-features.test.ts` |
| Terminal UI, end to end in a pseudo-terminal | `tests/tui.test.mjs` |
| Operation state, Conflict Center, rebase planner, Git Intelligence | `tests/*-smoke.sh` |
| API and saga bridge | `tests/api-smoke.mjs`, `saga-bridge.test.mjs` |

`npm run test:all` runs them; CI runs the same list.

## 22. Environment variables

| Variable | Default | Effect |
|---|---|---|
| `CHRONO_PORT` | 1421 | Server port |
| `CHRONO_HOST` | 127.0.0.1 | Listen address |
| `CHRONO_CONFIG_DIR` | `~/.chrono-next` | Configuration directory ([section 5](#5-where-state-lives)) |
| `CHRONO_API_TOKEN` | none | Token that authorises requests; required to listen beyond loopback |
| `CHRONO_ALLOW_INSECURE_REMOTE` | unset | `1` allows a non-loopback address without a token |
| `CHRONO_ALLOWED_ORIGIN`, `CHRONO_DEV_ORIGINS` | none | Extra allowed origins |
| `CHRONO_GIT_PER_REPO` | 8 | Concurrent git processes per repository |
| `CHRONO_LOCAL_AI_MODEL` | `qwen2.5:3b` | Default Ollama model |
| `CHRONO_NO_AI_PRELOAD` | unset | `1` disables loading the local model at start |
| `CHRONO_LLAMA_RELEASES_API` | GitHub releases API | Where llama.cpp builds are listed |
| `CHRONO_VITE_PORT`, `CHRONO_VITE_HOST` | 1420, 127.0.0.1 | Development server |
| `CHRONO_PARENT_PIPE` | set by the desktop app | Shut down when stdin closes |
| `CHRONO_TERMINAL` | set in terminal-panel shells | Lets scripts know they run inside Chrono |

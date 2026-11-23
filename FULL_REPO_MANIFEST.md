# Chrono Next v6 — Full Standalone Repository Manifest

This tree is a complete standalone source tree for the Qt-free Chrono Next v6 application,
rewritten from the Tauri/Rust stack to pure TypeScript. It does not require the legacy
Qt/C++ Chrono repository or any Rust toolchain to build or run.

## Provenance

- Parent project: `xsession/chrono`
- Qt-free v5 architecture: Rust + Tauri 2 + React + TypeScript + Vite
- v6 rewrite: Node 22 TypeScript backend (every former Tauri command is now an HTTP
  route) + the same React 19 + TypeScript frontend

## Included

- complete React/TypeScript frontend source
- TypeScript Node HTTP API backend (`server/`)
- desktop Git CLI backend (shells out to `git`)
- operation-state controller (merge/rebase/cherry-pick/revert)
- three-way Conflict Center (index stages 1/2/3)
- interactive rebase planner (pick/reword/edit/squash/fixup/drop, `--update-refs`)
- Git Intelligence / GitLens clean-room workflows
- pull request providers (GitHub/GitLab/Gitea/Forgejo)
- UI workbench
- Vite/TypeScript/npm project files
- GitHub Actions CI definition
- tests and smoke suites (including an end-to-end API server smoke test)
- research, implementation and visual-QA documentation
- application icon required by the frontend
- Electron desktop shell, Capacitor Android companion, Docker image and
  installer scripts (`install-linux.sh`, `install-windows.bat`/`.ps1`)
- multi-repository tabs with live change detection (`server/src/repoWatch.ts`)
- submodule tooling: mind map, bulk actions, what changed inside a submodule,
  and commits through nested submodules (`server/src/nestedCommit.ts`)
- codebase landscape map with a recent-changes heatmap (`public/landscape/`)
- identity profiles with a per-commit "Commit as" choice
- AI assistant: local Ollama, Claude through `@anthropic-ai/sdk`, or offline
  rules (`server/src/ai.ts`)

## Deliberately excluded

- `.git/` history and credentials
- `node_modules/`
- `dist/`
- machine-specific caches

`package-lock.json` is committed, so `npm ci` installs exactly the pinned
dependencies (CI and the release workflow use it).

## Validation

Every push runs the CI workflow (`.github/workflows/ci.yml`): typecheck,
build and the full test suite on Linux, unit tests on Windows and macOS, shell
and workflow lint, and packaging checks for the desktop app, server tarball,
Docker image and Android APK. `npm run test:all` runs the same suite locally;
the README's *Tests* section lists what each part covers.

## Local validation

```bash
npm ci
npm run typecheck
npm run build
npm run test:all
npm run dev        # API server :1421 + Vite dev server :1420
npm start          # production: API server on :1421 serves dist/
```

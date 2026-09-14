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

## Deliberately excluded

- `.git/` history and credentials
- `node_modules/`
- `dist/`
- machine-specific caches

`package-lock.json` is not included in this snapshot. `npm install` will generate it;
commit the generated lock file after validating your chosen toolchain if you want
reproducible dependency pinning.

## Validation performed

- `npm run typecheck` (frontend + server): PASS
- `npm run build` (tsc + vite build): PASS
- conflict-marker unit test: PASS
- merge/rebase/cherry-pick/revert operation smoke tests: PASS
- Conflict Center Git mechanics smoke tests: PASS
- interactive rebase planner smoke tests: PASS
- Git Intelligence smoke tests: PASS
- end-to-end API server smoke test (`npm run test:api`, 66 checks): PASS

## Local validation

```bash
npm install
npm run typecheck
npm run build
npm run test:markers
npm run test:git
npm run test:api
npm run dev        # API server :1421 + Vite dev server :1420
npm start          # production: API server on :1421 serves dist/
```

# GitAhead Next v5 — Full Standalone Repository Manifest

This archive is a complete standalone source tree for the Qt-free GitAhead Next v5 application.
It does not require the legacy Qt/C++ GitAhead repository to build or run.

## Provenance

- Parent project: `xsession/gitahead`
- Parent master observed while packaging: `93ab5028b0818272a79992402c59ec0ca57566fd`
- Qt-free architecture: Rust + Tauri 2 + React + TypeScript + Vite
- Feature level: UI/UX v5, including v2-v5 modernization slices

The v5 overlay was combined with the baseline Qt-free project scaffolding required to make it an independent repository. Unchanged developer-workbench source required by `App.tsx` was restored so all relative source imports resolve inside this archive.

## Included

- complete React/TypeScript frontend source
- Tauri/Rust application source
- desktop Git CLI backend
- Android git2-rs backend foundation
- operation-state controller
- three-way Conflict Center
- interactive rebase planner
- Git Intelligence / GitLens clean-room workflows
- UI workbench
- Tauri capability/configuration files
- Vite/TypeScript/npm project files
- GitHub Actions CI definition
- tests and smoke suites
- research, implementation and visual-QA documentation
- application icon required by the frontend

## Deliberately excluded

- `.git/` history and credentials
- `node_modules/`
- `dist/`
- Rust `target/`
- generated Android project output (`src-tauri/gen/`)
- machine-specific caches

`package-lock.json` and `Cargo.lock` are not included in this assembled standalone snapshot because the packaging runtime cannot access npm/crates.io to regenerate locks for the final v5 dependency graph. `npm install` and Cargo will generate compatible lock files locally; commit those generated lock files after validating your chosen toolchain if you want reproducible dependency pinning.

## Validation performed during packaging

- JSON parsing: PASS
- shell script syntax: PASS
- all relative TS/TSX imports: PASS
- TypeScript syntax/transpile check: PASS (22 TS/TSX files)
- CSS brace structure: PASS (`styles.css` 6/6, `ux.css` 489/489)
- conflict-marker unit test: PASS
- merge/rebase/cherry-pick/revert operation smoke tests: PASS
- Conflict Center Git mechanics smoke tests: PASS
- interactive rebase planner smoke tests: PASS
- Git Intelligence smoke tests: PASS

Full `npm run typecheck`/Vite build is not runnable in this packaging container because npm dependencies are not installed and outbound registry access is unavailable. Full `cargo check`/`cargo test` is also not runnable because Cargo/Rust are not installed in the packaging container.

## Local validation

```bash
npm install
npm run typecheck
npm run build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run test:markers
npm run test:git
npm run tauri dev
```

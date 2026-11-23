# Releasing Chrono

## One-time setup (optional signing)

Releases build without any secrets, as unsigned installers and a debug-signed APK. Add these repository secrets to sign them:

| Platform | Secrets |
|---|---|
| macOS (sign + notarize) | `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows (Authenticode) | `WIN_CSC_LINK` (base64 .pfx), `WIN_CSC_KEY_PASSWORD` |
| Android | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` |

The Docker image is pushed to `ghcr.io/<owner>/<repo>` with the built-in `GITHUB_TOKEN`. No extra secret is needed.

## Cutting a release

```bash
npm run version:sync -- 0.9.0      # package.json + Android versionName/versionCode
git commit -am "Release 0.9.0"
git tag v0.9.0
git push origin main --follow-tags
```

The tag starts `.github/workflows/release.yml`:

1. **verify:** the tag must equal `package.json`'s version.
2. **installers** (`.github/workflows/installers.yml`, see below):
   - Windows: NSIS installer (x64 + ARM64, adds the Explorer "Chrono" menu) and a portable `.exe`.
   - Linux: `.deb` (Ubuntu/Debian), `.pacman` (Arch Linux), `.rpm`, AppImage, `.tar.gz`.
   - Each is installed, started and uninstalled on a clean system; the release
     is only published when all of them pass.
3. **desktop** (macOS runner): `.dmg` + `.zip` (Intel + Apple silicon).
4. **server:** `chrono-server-<version>.tar.gz`, the headless web server.
5. **android:** the companion APK.
6. **docker:** a multi-arch image (amd64 + arm64) tagged `<version>`, `<major>.<minor>` and `latest`.
7. **publish:** a GitHub Release with every file, `SHA256SUMS.txt` and generated notes. Tags like `v1.0.0-rc.1` become pre-releases.

To rebuild an existing tag, run the workflow manually ("Run workflow") and enter the tag.

## Installers without a release

`.github/workflows/installers.yml` builds and tests the Windows, Ubuntu/Debian
and Arch Linux installers on its own. Run it from the Actions tab
(**Installers → Run workflow**, optionally with a branch, tag or commit) to get
the installers as build artifacts without publishing anything. It also runs on
pull requests that change `package.json`, `build/`, `electron/` or the workflow
itself, and `release.yml` calls it for every release.

| Job | What it does |
|---|---|
| Build Linux | `electron-builder --linux --x64`: `.deb`, `.pacman`, `.rpm`, AppImage, `.tar.gz` (uploads `installers-linux`) |
| Build Windows | `electron-builder --win`: NSIS x64 + ARM64 and portable (uploads `installers-windows`), signed when `WIN_CSC_LINK` is set |
| Install on Ubuntu 22.04, 24.04, Debian 12 | `apt-get install ./…amd64.deb` in a clean container, checks the files, starts the installed backend and waits for `/api/health`, then `apt-get remove` and checks that `chrono` and `chrono-open` are gone |
| Install on Arch Linux | The same with `pacman -U` / `pacman -R` in an `archlinux` container |
| Install on Windows | Silent per-user install (`/S`), checks `Chrono.exe` and the Explorer menu, starts the backend, then a silent uninstall that must remove both |

The containers are minimal systems, so these jobs also prove that the
packages' dependency lists are complete: Electron needs `libgbm`, `libasound`
and `libcups` besides GTK and NSS, and they are listed for `.deb`, `.rpm` and
`.pacman`.

## CI on every push / pull request

`.github/workflows/ci.yml` runs:
- **Linux:** typecheck, build and the full test suite: `test:unit`, `test:lines`, `test:submodules`, `test:trust`, `test:lanes`, `test:landscape`, `test:folders`, `test:watch`, `test:stash-history`, `test:nested-commit`, `test:ai`, `test:local-llm`, `test:tui`, `test:forks`, `test:roadmap`, `test:git` and `test:api` (the same set as `npm run test:all`).
- **Windows and macOS:** typecheck, build, unit tests and line staging.
- **Linting:** shellcheck and actionlint.
- **Packaging checks:**
  - an unpacked Linux desktop build, whose backend is started to check it runs;
  - the server tarball;
  - a Docker image, checked to require its token;
  - a debug Android APK (on pushes only).

Dependabot keeps npm, GitHub Actions, Docker and Gradle dependencies current.

## Local packaging

```bash
npm run icons        # regenerate build/ and public/rsrc icons (needs Pillow)
npm run dist:linux   # or dist:win / dist:mac — output in release/
npm run dist:deb     # only the .deb (Ubuntu/Debian)
npm run dist:arch    # only the .pacman (Arch Linux; needs bsdtar from libarchive)
npm run dist:server  # release/chrono-server-<version>.tar.gz
docker build -t chrono .
```

The desktop packages use node-pty's prebuilt N-API binaries as they are
(`"npmRebuild": false` in `package.json`), so packaging needs no C++ toolchain.
node-pty's debug symbols (`.pdb`) and build sources are left out of the
packages.

## Troubleshooting local builds

- **Android: "invalid source release: 21".** Capacitor 7 compiles for Java 21;
  build with JDK 21 or newer (`JAVA_HOME`). The starters check for it.
- **Windows: makensis "error creating mmap".** NSIS is 32-bit and keeps its
  working files in `%TEMP%`; free space on that drive (usually C:).
- **Windows: the setup exits with code 2.** It could not remove the installed
  version: Chrono is still running, an all-users install is in the way, or an
  earlier install broke halfway (often because the disk filled up).
  `install-windows.bat` checks the first two before running the setup and
  names what it finds. A broken install is removed from Settings > Apps, or by
  deleting `%LOCALAPPDATA%\Programs\Chrono` and its entry under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`.
- **Windows: "Spectre-mitigated libraries are required".** An older checkout
  rebuilt node-pty from source; current ones do not (see above).
- **Line-ending test failures on Windows.** The test repositories set
  `core.autocrlf false`; a global `core.autocrlf true` is fine.

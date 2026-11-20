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
2. **desktop**, on Linux, Windows and macOS runners:
   - Linux: AppImage, `.deb`, `.rpm`, `.tar.gz`.
   - Windows: NSIS installer (x64 + ARM64, adds the Explorer "Chrono" menu) and a portable `.exe`.
   - macOS: `.dmg` + `.zip` (Intel + Apple silicon).
3. **server:** `chrono-server-<version>.tar.gz`, the headless web server.
4. **android:** the companion APK.
5. **docker:** a multi-arch image (amd64 + arm64) tagged `<version>`, `<major>.<minor>` and `latest`.
6. **publish:** a GitHub Release with every file, `SHA256SUMS.txt` and generated notes. Tags like `v1.0.0-rc.1` become pre-releases.

To rebuild an existing tag, run the workflow manually ("Run workflow") and enter the tag.

## CI on every push / pull request

`.github/workflows/ci.yml` runs:
- **Linux:** typecheck, build and the full test suite (`test:unit`, `test:lines`, `test:roadmap`, `test:git`, `test:api`).
- **Windows and macOS:** typecheck, build and unit tests.
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
npm run dist:server  # release/chrono-server-<version>.tar.gz
docker build -t chrono .
```

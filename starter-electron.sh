#!/usr/bin/env bash
# Chrono Electron desktop starter (Linux/macOS).
#
# Checks/installs prerequisites, then builds and launches the Electron
# desktop app. The Electron main process spawns the Chrono backend itself
# (random port from 14210 upwards), so nothing else needs to be running.
#
#   ./starter-electron.sh            build + launch
#   ./starter-electron.sh --check    build only, do not launch
#   ./starter-electron.sh --packager build + create installers (release/)
set -euo pipefail
cd "$(dirname "$0")"

MODE="run"
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --packager) MODE="packager" ;;
  esac
done

step() { printf '\n== %s ==\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

step "Checking prerequisites"

NODE_MAJOR=""
if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node' 2>/dev/null | cut -d. -f1 || true)"
fi
case "$NODE_MAJOR" in
  ''|*[!0-9]*) NODE_MAJOR="" ;;
esac
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22+ not found - installing..."
  have curl || { echo "error: curl is required for the Node.js install script. Install curl and run ./starter-electron.sh again." >&2; exit 1; }
  if have brew; then
    brew install node
  elif have apt-get; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif have dnf; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
    sudo dnf install -y nodejs
  elif have yum; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
    sudo yum install -y nodejs
  elif have pacman; then
    sudo pacman -Sy --noconfirm nodejs-lts
  elif have zypper; then
    sudo zypper install -y nodejs22
  else
    echo "error: no supported package manager found (brew/apt/dnf/yum/pacman/zypper)." >&2
    echo "Install Node.js 22+ from https://nodejs.org and run ./starter-electron.sh again." >&2
    exit 1
  fi
  echo "installed: $(node --version)"
fi
have node || { echo "error: node is still not available" >&2; exit 1; }
echo "node $(node --version), npm $(npm --version)"

have git || { echo "error: git not found on PATH. Install Git and run ./starter-electron.sh again." >&2; exit 1; }
echo "git $(git --version | cut -d' ' -f1-3)"

# Electron on Linux needs a few shared libraries for GUI launch.
# Ubuntu 24.04+ and Debian 13 renamed several of them with a t64 suffix
# (libasound2 -> libasound2t64); apt_pkg picks whichever name this release has.
apt_pkg() {
  local name
  for name in "${1}t64" "$1"; do
    if apt-cache policy "$name" 2>/dev/null | grep -q 'Candidate: [^(]'; then echo "$name"; return; fi
  done
  echo "$1"
}
if [ "$(uname -s)" = "Linux" ] && have apt-get; then
  # Read the cache once: under pipefail, "ldconfig -p | grep -q" fails even on
  # a match, because grep exits early and ldconfig dies of SIGPIPE.
  ldcache="$(ldconfig -p 2>/dev/null || true)"
  for lib in libnss3 libatk-1.0 libgtk-3 libasound; do
    if ! grep -q "${lib//./\\.}" <<<"$ldcache"; then
      pkgs=()
      for pkg in libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 libasound2 libxss1 libxtst6 libxcomposite1; do
        pkgs+=("$(apt_pkg "$pkg")")
      done
      echo "Installing Electron runtime libraries: ${pkgs[*]}"
      sudo apt-get install -y "${pkgs[@]}" || \
        echo "warning: could not install all Electron runtime libraries automatically."
      break
    fi
  done
fi

step "Installing npm dependencies (includes Electron)"
npm install

# Electron's own install script fetches the binary for this OS. npm 11.19+
# skips dependency install scripts that package.json does not allow, and no npm
# re-runs it for a package that is already installed, so a checkout shared
# with Windows would keep the Windows electron.exe. The script does nothing
# when the binary already matches this system.
step "Checking the Electron binary for $(uname -s)"
node node_modules/electron/install.js
node -e 'const p=require("electron"); require("fs").accessSync(p); console.log("electron:", p)'

step "Building frontend"
npm run build

if [ "$MODE" = "check" ]; then
  echo
  echo "Check complete - run ./starter-electron.sh (without --check) to launch the desktop app."
  exit 0
fi

if [ "$MODE" = "packager" ]; then
  step "Creating installers"
  echo "Installers are written to release/ after the build."
  npm run desktop:build
  exit 0
fi

# Chromium sandboxes its renderers with user namespaces. Ubuntu 23.10+ blocks
# those for programs without an AppArmor profile that allows them
# (kernel.apparmor_restrict_unprivileged_userns), and Electron then aborts with
# "No usable sandbox". As Chromium's docs recommend, install a small profile
# for this checkout's Electron binary that allows user namespaces (Ubuntu ships
# the same kind of profile for Chrome and VS Code). The sandbox stays on.
# https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
setup_linux_sandbox() {
  [ "$(uname -s)" = "Linux" ] || return 0
  [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ] || return 0
  local electron profile_file="/etc/apparmor.d/chrono-electron" profile
  electron="$(realpath node_modules/electron/dist/electron)"
  profile="# Lets Chrono's Electron (started by starter-electron.sh) use user namespaces
# for its sandbox. Remove this file to undo.
abi <abi/4.0>,
include <tunables/global>

profile chrono-electron \"$electron\" flags=(unconfined) {
  userns,

  include if exists <local/chrono-electron>
}"
  if [ "$(cat "$profile_file" 2>/dev/null)" = "$profile" ]; then return 0; fi

  step "Allowing the Electron sandbox (AppArmor)"
  echo "This system restricts unprivileged user namespaces, which Electron's sandbox"
  echo "needs. Installing an AppArmor profile for $electron"
  echo "to $profile_file (sudo is needed once)."
  if printf '%s\n' "$profile" | sudo tee "$profile_file" >/dev/null && sudo apparmor_parser -r "$profile_file"; then
    echo "AppArmor profile loaded: chrono-electron"
    return 0
  fi
  echo "error: could not install the AppArmor profile $profile_file." >&2
  exit 1
}
setup_linux_sandbox

step "Launching Chrono desktop (Electron)"
echo
echo "The backend starts inside the app on a random port from 14210 upwards."
# The frontend was built above, so start Electron directly (desktop:dev would build again).
exec npx --no-install electron .

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
  for lib in libnss3 libatk-1.0 libgtk-3 libasound; do
    if ! ldconfig -p 2>/dev/null | grep -q "${lib//./\\.}"; then
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
# those for unconfined programs (kernel.apparmor_restrict_unprivileged_userns),
# so Electron falls back to the setuid helper chrome-sandbox, which must be
# owned by root with mode 4755. A checkout on NTFS/exFAT or a nosuid mount
# cannot hold that. Then the helper is installed to /usr/local/lib/chrono and
# Electron is pointed at it with CHROME_DEVEL_SANDBOX; Electron only reads that
# variable when there is no chrome-sandbox next to its binary, so the unusable
# copy in node_modules is removed. The sandbox stays on either way.
setup_linux_sandbox() {
  [ "$(uname -s)" = "Linux" ] || return 0
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" != "1" ] &&
     [ "$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo 1)" = "1" ]; then
    return 0 # user namespaces are available; no setuid helper needed
  fi
  local helper="node_modules/electron/dist/chrome-sandbox"
  local dest="/usr/local/lib/chrono/chrome-sandbox"
  sandbox_ok() {
    [ "$(stat -c '%u %a' "$1" 2>/dev/null)" = "0 4755" ] &&
      ! findmnt -n -o OPTIONS -T "$1" 2>/dev/null | tr ',' '\n' | grep -qx nosuid
  }
  use_dest() { rm -f "$helper"; export CHROME_DEVEL_SANDBOX="$dest"; echo "chrome-sandbox: $dest"; }

  if [ -f "$helper" ] && sandbox_ok "$helper"; then return 0; fi
  # Installed on an earlier run (and the same Electron version).
  if sandbox_ok "$dest" && { [ ! -f "$helper" ] || cmp -s "$helper" "$dest"; }; then use_dest; return 0; fi
  if [ ! -f "$helper" ]; then
    echo "error: $helper is missing. Reinstall Electron (rm -rf node_modules/electron && npm install) and try again." >&2
    exit 1
  fi

  step "Setting up the Electron sandbox helper"
  echo "This system restricts unprivileged user namespaces, so Electron needs its"
  echo "setuid sandbox helper (owned by root, mode 4755). sudo is needed once."
  if sudo chown root:root "$helper" 2>/dev/null && sudo chmod 4755 "$helper" 2>/dev/null && sandbox_ok "$helper"; then
    echo "chrome-sandbox: $helper"
    return 0
  fi
  echo "This checkout's file system cannot hold a setuid file; installing the helper to $dest."
  if sudo install -D -o root -g root -m 4755 "$helper" "$dest" && sandbox_ok "$dest"; then
    use_dest
    return 0
  fi
  echo "error: could not set up the Electron sandbox helper. Run these and try again:" >&2
  echo "  sudo install -D -o root -g root -m 4755 $helper $dest" >&2
  echo "  rm $helper" >&2
  exit 1
}
setup_linux_sandbox

step "Launching Chrono desktop (Electron)"
echo
echo "The backend starts inside the app on a random port from 14210 upwards."
# The frontend was built above, so start Electron directly (desktop:dev would build again).
exec npx --no-install electron .

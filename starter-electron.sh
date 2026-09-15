#!/usr/bin/env bash
# Chrono Electron desktop starter (Linux/macOS).
#
# Checks/installs prerequisites, then builds and launches the Electron
# desktop app. The Electron main process spawns the Chrono backend itself
# (random port in 14210-14310), so nothing else needs to be running.
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
if [ "$(uname -s)" = "Linux" ]; then
  for lib in libnss3 libatk-1.0 libgtk-3; do
    if ! ldconfig -p 2>/dev/null | grep -q "${lib//./\\.}"; then
      if have apt-get; then
        echo "Installing Electron runtime libraries (libnss3, libatk, libgtk-3, libgbm, libasound2)..."
        sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 libasound2 libxss1 libxtst6 libxcomposite1 || \
          echo "warning: could not install all Electron runtime libraries automatically."
        break
      fi
    fi
  done
fi

step "Installing npm dependencies (includes Electron)"
npm install

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

step "Launching Chrono desktop (Electron)"
echo
echo "The backend starts inside the app on a port in 14210-14310."
npm run desktop:dev

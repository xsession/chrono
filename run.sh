#!/usr/bin/env bash
# Chrono Next launcher (Linux/macOS).
# Installs Node.js 22+ if missing, then npm dependencies, builds and starts the app.
# Usage: ./run.sh            build + start, open http://localhost:1421
#        ./run.sh --check    install + build only, do not start
set -euo pipefail
cd "$(dirname "$0")"

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

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
  have curl || { echo "error: curl is required for the Node.js install script. Install curl and run ./run.sh again." >&2; exit 1; }
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
    echo "Install Node.js 22+ from https://nodejs.org and run ./run.sh again." >&2
    exit 1
  fi
  echo "installed: $(node --version)"
fi
have node || { echo "error: node is still not available" >&2; exit 1; }
echo "node $(node --version), npm $(npm --version)"

have git || { echo "error: git not found on PATH. Install Git and run ./run.sh again." >&2; exit 1; }
echo "git $(git --version | cut -d' ' -f1-3)"

step "Installing npm dependencies"
npm install

step "Building frontend"
npm run build

if [ "$CHECK" -eq 1 ]; then
  echo
  echo "Check complete - run ./run.sh (without --check) to start the app."
  exit 0
fi

PORT="${CHRONO_PORT:-1421}"
step "Starting Chrono Next"
echo
echo "Open http://localhost:$PORT"
npm start

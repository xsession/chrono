#!/usr/bin/env bash
# Chrono Android companion starter (Linux/macOS).
#
# Checks/installs prerequisites (Node 22+, JDK 17+, Android SDK) and builds
# the debug APK with ./gradlew assembleDebug.
#
#   ./starter-android.sh            build + APK
#   ./starter-android.sh --check    install + build only
#   ./starter-android.sh --open     open the project in Android Studio
#
# The Android app is a companion client: after installing the APK, enter the
# HTTPS address of your Chrono server (Backend button in the app).
set -euo pipefail
cd "$(dirname "$0")"

MODE="apk"
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --open) MODE="open" ;;
  esac
done

step() { printf '\n== %s ==\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

step "Checking Node.js"
NODE_MAJOR=""
if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node' 2>/dev/null | cut -d. -f1 || true)"
fi
case "$NODE_MAJOR" in
  ''|*[!0-9]*) NODE_MAJOR="" ;;
esac
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22+ not found - installing..."
  have curl || { echo "error: curl is required for the Node.js install script. Install curl and run ./starter-android.sh again." >&2; exit 1; }
  if have brew; then
    brew install node
  elif have apt-get; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif have dnf; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
    sudo dnf install -y nodejs
  else
    echo "error: no supported package manager found (brew/apt/dnf). Install Node.js 22+ from https://nodejs.org and run ./starter-android.sh again." >&2
    exit 1
  fi
fi
echo "node $(node --version), npm $(npm --version)"

step "Checking Java (JDK 17+)"
if ! java -version 2>&1 | head -1 | grep -Eq 'version "(17|1[8-9]|[2-9][0-9])'; then
  echo "JDK 17+ not found - installing..."
  if have brew; then
    brew install --cask temurin@17 || brew install openjdk@17
  elif have apt-get; then
    sudo apt-get install -y openjdk-17-jdk
  elif have dnf; then
    sudo dnf install -y java-17-openjdk-devel
  else
    echo "error: install JDK 17+ (https://adoptium.net) and run ./starter-android.sh again." >&2
    exit 1
  fi
fi
java -version 2>&1 | head -1

step "Checking Android SDK"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
if [ ! -f "$SDK/platform-tools/adb" ] && [ ! -f "$SDK/platform-tools/adb.exe" ]; then
  echo "Android SDK not found at $SDK - bootstrapping command-line tools..."
  mkdir -p "$SDK/cmdline-tools"
  ZIP="$(mktemp -d)/android-cmdline-tools.zip"
  if curl -fsSL -o "$ZIP" "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"; then
    :
  elif curl -fsSL -o "$ZIP" "https://dl.google.com/android/repository/commandlinetools-darwin-11076708_latest.zip"; then
    :
  else
    echo "error: could not download Android command-line tools. Install them from https://developer.android.com/studio and set ANDROID_HOME, then run ./starter-android.sh again." >&2
    exit 1
  fi
  UNZIP_DIR="$(mktemp -d)"
  unzip -q "$ZIP" -d "$UNZIP_DIR"
  rm -f "$ZIP"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$UNZIP_DIR/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -rf "$UNZIP_DIR"
  export ANDROID_HOME="$SDK"
  yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" --licenses >/dev/null 2>&1 || true
  "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "platform-tools" "platforms;android-34" "build-tools;34.0.0"
  echo "Android SDK installed at $SDK (set ANDROID_HOME in your shell profile to persist it)."
else
  echo "Android SDK: $SDK"
fi
export ANDROID_HOME="$SDK"

step "Installing npm dependencies"
npm install

step "Building frontend + syncing Capacitor"
npm run android:sync

if [ "$MODE" = "check" ]; then
  echo
  echo "Check complete - run ./starter-android.sh (without --check) to build the APK."
  exit 0
fi

if [ "$MODE" = "open" ]; then
  have studio && studio . || npx cap open android
  exit 0
fi

step "Building debug APK"
(cd android && ./gradlew assembleDebug --console=plain)
APK="android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  echo
  echo "APK ready: $PWD/$APK"
  echo "Install it with: adb install $APK"
else
  echo "Build finished but $APK was not found - check gradle output above." >&2
  exit 1
fi

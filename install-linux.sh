#!/usr/bin/env bash
# Chrono desktop installer for Linux.
#
#   ./install-linux.sh                    build this checkout and install it
#   ./install-linux.sh --release [vX.Y.Z] download a GitHub release (latest if no tag)
#   ./install-linux.sh --file <package>   install a .deb, .rpm or .AppImage you already have
#   ./install-linux.sh --user             per-user AppImage install (no sudo), any distro
#   ./install-linux.sh --uninstall        remove Chrono (settings are kept)
#
# How it installs:
#   Debian/Ubuntu  .deb through apt  -> /opt/Chrono, `chrono` on PATH, file-manager menus
#   Fedora/SUSE    .rpm through dnf/zypper (same layout)
#   anything else  AppImage in ~/.local/opt/chrono, `chrono` in ~/.local/bin, menu entry
#                  (also what --user picks)
# The deb/rpm route asks for sudo once; the AppImage route never does.
set -euo pipefail
cd "$(dirname "$0")"
here="$(pwd -P)"

REPO="xsession/chrono"
PKG_NAME="chrono-next"   # package name in the .deb/.rpm (package.json "name")
user_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
opt_dir="$HOME/.local/opt/chrono"
bin_dir="$HOME/.local/bin"

source="build"   # build | release | file
tag=""
file=""
mode="auto"      # auto | user
uninstall=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) source="release"; if [ "${2:-}" ] && [ "${2#-}" = "$2" ]; then tag="$2"; shift; fi; shift ;;
    --file) source="file"; file="${2:?--file needs a path}"; shift 2 ;;
    --user) mode="user"; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s ==\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
die() { echo "error: $*" >&2; exit 1; }

case "$(uname -m)" in
  x86_64|amd64) deb_arch=amd64; rpm_arch=x86_64; app_arch=x86_64; eb_arch=x64 ;;
  aarch64|arm64) deb_arch=arm64; rpm_arch=aarch64; app_arch=arm64; eb_arch=arm64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac

# Which package to use on this machine.
if [ "$mode" = "user" ]; then
  kind="appimage"
elif have apt-get && have dpkg; then
  kind="deb"
elif have dnf || have zypper; then
  kind="rpm"
else
  kind="appimage"
fi

sudo_cmd() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

remove_user_install() {
  rm -f "$bin_dir/chrono" "$user_dir/applications/chrono.desktop" "$user_dir/icons/hicolor/512x512/apps/chrono.png"
  rm -rf "$opt_dir"
  have update-desktop-database && update-desktop-database -q "$user_dir/applications" 2>/dev/null || true
}

if [ "$uninstall" -eq 1 ]; then
  step "Removing Chrono"
  removed=0
  if [ -e "$opt_dir" ] || [ -e "$user_dir/applications/chrono.desktop" ]; then remove_user_install; echo "removed the per-user AppImage install"; removed=1; fi
  if have dpkg && dpkg -s "$PKG_NAME" >/dev/null 2>&1; then sudo_cmd apt-get remove -y "$PKG_NAME"; removed=1
  elif have rpm && rpm -q "$PKG_NAME" >/dev/null 2>&1; then
    if have dnf; then sudo_cmd dnf remove -y "$PKG_NAME"; else sudo_cmd zypper --non-interactive remove "$PKG_NAME"; fi
    removed=1
  fi
  [ "$removed" -eq 1 ] || echo "Chrono is not installed."
  echo "Settings are kept in ${XDG_CONFIG_HOME:-$HOME/.config}/Chrono."
  exit 0
fi

# --- 1. Get a package -------------------------------------------------------
pkg=""
case "$source" in
  file)
    [ -f "$file" ] || die "no such file: $file"
    pkg="$(cd "$(dirname "$file")" && pwd -P)/$(basename "$file")"
    case "$pkg" in
      *.deb) kind="deb" ;; *.rpm) kind="rpm" ;; *.AppImage) kind="appimage" ;;
      *) die "expected a .deb, .rpm or .AppImage file" ;;
    esac ;;

  release)
    have curl || die "curl is required to download a release"
    step "Looking up the ${tag:-latest} release of $REPO"
    if [ -n "$tag" ]; then api="https://api.github.com/repos/$REPO/releases/tags/$tag"; else api="https://api.github.com/repos/$REPO/releases/latest"; fi
    case "$kind" in
      deb) pattern="linux-$deb_arch\\.deb" ;;
      rpm) pattern="linux-$rpm_arch\\.rpm" ;;
      *) pattern="linux-$app_arch\\.AppImage" ;;
    esac
    url="$(curl -fsSL "$api" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(http[^"]*\)"/\1/' | grep -E "$pattern\$" | head -n1 || true)"
    [ -n "$url" ] || die "no $kind package for $(uname -m) in the ${tag:-latest} release (build from source instead: ./install-linux.sh)"
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    pkg="$tmp/$(basename "$url")"
    echo "downloading $(basename "$url")"
    curl -fL --progress-bar -o "$pkg" "$url" ;;

  build)
    [ -f package.json ] && [ -d electron ] || die "run this from a Chrono checkout, or use --release / --file"
    have node || die "Node.js 22+ is required to build (or use --release). ./starter-electron.sh can install it."
    [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node.js 22+ is required (found $(node --version))"
    have git || die "git is required"
    if [ "$kind" = "rpm" ] && ! have rpmbuild; then
      echo "rpmbuild is missing, so this machine gets the AppImage (install rpm-build to get an .rpm)."
      kind="appimage"
    fi
    case "$kind" in deb) target=deb ;; rpm) target=rpm ;; *) target=AppImage ;; esac
    version="$(node -p 'require("./package.json").version')"
    step "Installing npm dependencies"
    npm ci
    step "Building Chrono $version"
    npm run build
    step "Packaging ($target, $eb_arch)"
    # Remove the previous package of this version, so a failed packaging
    # step can never install a stale file.
    rm -f release/Chrono-"$version"-linux-*."${target,,}" release/Chrono-"$version"-linux-*.AppImage
    npx electron-builder --linux "$target" "--$eb_arch" --publish never
    case "$kind" in
      deb) pkg="$here/release/Chrono-$version-linux-$deb_arch.deb" ;;
      rpm) pkg="$here/release/Chrono-$version-linux-$rpm_arch.rpm" ;;
      *) pkg="$here/release/Chrono-$version-linux-$app_arch.AppImage" ;;
    esac
    [ -f "$pkg" ] || die "packaging finished but $pkg is missing (see release/)" ;;
esac

# --- 2. Install it ------------------------------------------------------------
if pgrep -x chrono >/dev/null 2>&1 || pgrep -f "$opt_dir/Chrono.AppImage" >/dev/null 2>&1; then
  echo "note: Chrono is running; restart it after the install to get the new version."
fi

step "Installing $(basename "$pkg")"
case "$kind" in
  deb)
    # apt resolves the dependencies (git, gtk, nss, ...) listed in the package.
    sudo_cmd apt-get install -y --allow-downgrades "$pkg"
    [ -e "$opt_dir" ] && { remove_user_install; echo "removed the older per-user AppImage install"; }
    installed="$(dpkg-query -W -f '${Version}' "$PKG_NAME" 2>/dev/null || true)"
    where="/opt/Chrono (run: chrono)" ;;
  rpm)
    if have dnf; then sudo_cmd dnf install -y --allowerasing "$pkg"; else sudo_cmd zypper --non-interactive install --allow-unsigned-rpm --oldpackage "$pkg"; fi
    [ -e "$opt_dir" ] && { remove_user_install; echo "removed the older per-user AppImage install"; }
    installed="$(rpm -q --qf '%{VERSION}' "$PKG_NAME" 2>/dev/null || true)"
    where="/opt/Chrono (run: chrono)" ;;
  appimage)
    mkdir -p "$opt_dir" "$bin_dir" "$user_dir/applications" "$user_dir/icons/hicolor/512x512/apps"
    install -m 0755 "$pkg" "$opt_dir/Chrono.AppImage.new"
    mv -f "$opt_dir/Chrono.AppImage.new" "$opt_dir/Chrono.AppImage"
    ln -sf "$opt_dir/Chrono.AppImage" "$bin_dir/chrono"
    if [ -f "$here/build/icons/512x512.png" ]; then cp "$here/build/icons/512x512.png" "$user_dir/icons/hicolor/512x512/apps/chrono.png"; fi
    cat > "$user_dir/applications/chrono.desktop" <<DESKTOP
[Desktop Entry]
Name=Chrono
Comment=Git client with a commit graph and a TortoiseGit-style explorer
Exec="$opt_dir/Chrono.AppImage" %U
Icon=chrono
Terminal=false
Type=Application
Categories=Development;RevisionControl;
MimeType=x-scheme-handler/chrono;
StartupWMClass=Chrono
DESKTOP
    have update-desktop-database && update-desktop-database -q "$user_dir/applications" 2>/dev/null || true
    have xdg-mime && xdg-mime default chrono.desktop x-scheme-handler/chrono 2>/dev/null || true
    # AppImages need FUSE 2 to start; say so instead of failing at first launch.
    if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
      echo "note: AppImages need libfuse2 (Debian/Ubuntu: sudo apt install libfuse2t64 or libfuse2)."
    fi
    case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "note: add $bin_dir to PATH to run 'chrono' from a terminal." ;; esac
    installed="$(basename "$pkg" | sed -n 's/^Chrono-\([0-9][^-]*\(-[a-z][0-9A-Za-z.]*\)\{0,1\}\)-linux-.*/\1/p')"
    where="$opt_dir/Chrono.AppImage (run: chrono)" ;;
esac

echo
echo "Chrono ${installed:-?} installed: $where"
menus="$here/shell-integration/linux/install.sh"; [ -f "$menus" ] || menus="/opt/Chrono/resources/shell-integration/linux/install.sh"
echo "Right-click menus for Nautilus/Caja (per user): sh $menus"

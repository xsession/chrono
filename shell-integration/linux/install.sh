#!/bin/sh
# Install the Chrono right-click menu for Linux file managers:
# Nautilus (GNOME Files), Caja (MATE), Nemo (Cinnamon) and Dolphin (KDE).
#
#   ./install.sh            install for the current user
#   ./install.sh --uninstall
#
# Menu entries call ~/.local/bin/chrono-open, which forwards to the Chrono
# desktop app (or to $CHRONO_WEB_URL for the web build).
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
share="${XDG_DATA_HOME:-$HOME/.local/share}"
config="${XDG_CONFIG_HOME:-$HOME/.config}"
bin_dir="$HOME/.local/bin"
nautilus_dir="$share/nautilus/scripts/Chrono"
caja_dir="$config/caja/scripts/Chrono"
nemo_dir="$share/nemo/actions"
dolphin_dirs="$share/kio/servicemenus $share/kservices5/ServiceMenus"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$nautilus_dir" "$caja_dir"
  rm -f "$nemo_dir"/chrono-*.nemo_action
  for dir in $dolphin_dirs; do rm -f "$dir/chrono.desktop"; done
  rm -f "$bin_dir/chrono-open"
  echo "Chrono file-manager integration removed."
  exit 0
fi

mkdir -p "$bin_dir" "$nautilus_dir" "$caja_dir" "$nemo_dir"
install -m 0755 "$here/../chrono-open" "$bin_dir/chrono-open"

index=0
dolphin_actions=""
dolphin_body=""
while IFS="$(printf '\t')" read -r action label; do
  [ -n "$action" ] || continue
  index=$((index + 1))
  name="$(printf '%02d %s' "$index" "$label")"
  for dir in "$nautilus_dir" "$caja_dir"; do
    script="$dir/$name"
    printf '#!/bin/sh\nexec "%s" %s "$@"\n' "$bin_dir/chrono-open" "$action" > "$script"
    chmod 0755 "$script"
  done
  cat > "$nemo_dir/chrono-$action.nemo_action" <<NEMO
[Nemo Action]
Name=Chrono: $label
Comment=Chrono — $label
Exec=$bin_dir/chrono-open $action %F
Selection=any
Extensions=any;
Icon-Name=git
NEMO
  dolphin_actions="$dolphin_actions$action;"
  dolphin_body="$dolphin_body
[Desktop Action $action]
Name=$label
Icon=git
Exec=$bin_dir/chrono-open $action %F
"
done < "$here/../actions.tsv"

for dir in $dolphin_dirs; do
  mkdir -p "$dir"
  cat > "$dir/chrono.desktop" <<DOLPHIN
[Desktop Entry]
Type=Service
MimeType=all/all;inode/directory;
Actions=$dolphin_actions
X-KDE-ServiceTypes=KonqPopupMenu/Plugin
X-KDE-Submenu=Chrono
X-KDE-Priority=TopLevel
$dolphin_body
DOLPHIN
  chmod 0755 "$dir/chrono.desktop"
done

echo "Installed Chrono menus for Nautilus, Caja, Nemo and Dolphin."
echo "Restart the file manager (e.g. 'nautilus -q') to see the 'Scripts → Chrono' / 'Chrono' menu."
case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "Note: $bin_dir is not on PATH; the menus use the full path, so they still work." ;; esac
if ! command -v chrono >/dev/null 2>&1 && [ -z "${CHRONO_BIN:-}" ]; then
  echo "Tip: set CHRONO_BIN to the Chrono executable, or CHRONO_WEB_URL=http://localhost:1421 for the web build (e.g. in ~/.profile)."
fi

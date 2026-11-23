#!/bin/sh
# Post-install for the Chrono .deb/.rpm/.pacman: CLI link, chrono:// handler and the
# system-wide file-manager menus (Dolphin service menu, Nemo actions).
# Nautilus/Caja scripts are per-user: run
#   /opt/Chrono/resources/shell-integration/linux/install.sh
set -e
APP_DIR="/opt/Chrono"
ln -sf "$APP_DIR/chrono" /usr/bin/chrono
if [ -f "$APP_DIR/chrome-sandbox" ]; then chmod 4755 "$APP_DIR/chrome-sandbox" || true; fi

SI="$APP_DIR/resources/shell-integration"
if [ -d "$SI" ]; then
  install -m 0755 "$SI/chrono-open" /usr/bin/chrono-open
  mkdir -p /usr/share/kio/servicemenus /usr/share/nemo/actions
  actions=""
  body=""
  while IFS="$(printf '\t')" read -r action label; do
    [ -n "$action" ] || continue
    actions="$actions$action;"
    body="$body
[Desktop Action $action]
Name=$label
Icon=chrono
Exec=/usr/bin/chrono-open $action %F
"
    cat > "/usr/share/nemo/actions/chrono-$action.nemo_action" <<NEMO
[Nemo Action]
Name=Chrono: $label
Exec=/usr/bin/chrono-open $action %F
Selection=any
Extensions=any;
Icon-Name=chrono
NEMO
  done < "$SI/actions.tsv"
  cat > /usr/share/kio/servicemenus/chrono.desktop <<DOLPHIN
[Desktop Entry]
Type=Service
MimeType=all/all;inode/directory;
Actions=$actions
X-KDE-ServiceTypes=KonqPopupMenu/Plugin
X-KDE-Submenu=Chrono
$body
DOLPHIN
  chmod 0755 /usr/share/kio/servicemenus/chrono.desktop
fi

if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true; fi
exit 0

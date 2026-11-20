#!/bin/sh
# Remove what after-install.sh added (only when the package is removed).
case "${1:-}" in upgrade|1) exit 0 ;; esac
rm -f /usr/bin/chrono /usr/bin/chrono-open /usr/share/kio/servicemenus/chrono.desktop
rm -f /usr/share/nemo/actions/chrono-*.nemo_action
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
exit 0

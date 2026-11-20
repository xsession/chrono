#!/bin/sh
# Install the Chrono server as a systemd *user* service.
#
#   ./install-linux-service.sh                 install + start (127.0.0.1:1421)
#   ./install-linux-service.sh --port 1500     custom port
#   ./install-linux-service.sh --remote        listen on 0.0.0.0 with a generated token
#   ./install-linux-service.sh --uninstall
#
# Run it from an extracted chrono-server-<version> release (or a built
# checkout). Needs Node.js 22+ and git. Logs: journalctl --user -u chrono
set -eu
app_dir="$(cd "$(dirname "$0")/../.." && pwd -P)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
env_file="${XDG_CONFIG_HOME:-$HOME/.config}/chrono/server.env"
port=1421
host=127.0.0.1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) port="$2"; shift 2 ;;
    --remote) host=0.0.0.0; shift ;;
    --uninstall)
      systemctl --user disable --now chrono.service 2>/dev/null || true
      rm -f "$unit_dir/chrono.service"
      systemctl --user daemon-reload 2>/dev/null || true
      echo "Chrono service removed (settings kept in $env_file)."
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

node_bin="$(command -v node || true)"
[ -n "$node_bin" ] || { echo "Node.js 22+ is required" >&2; exit 1; }
major="$("$node_bin" -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || { echo "Node.js 22+ is required (found $("$node_bin" --version))" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }
[ -f "$app_dir/dist/index.html" ] || { echo "$app_dir/dist is missing — run 'npm run build' first" >&2; exit 1; }
if [ ! -d "$app_dir/node_modules/ws" ]; then
  echo "Installing runtime dependencies…"
  (cd "$app_dir" && npm ci --omit=dev)
fi

mkdir -p "$unit_dir" "$(dirname "$env_file")"
if [ ! -f "$env_file" ]; then
  token=""
  if [ "$host" != "127.0.0.1" ]; then token="$("$node_bin" -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"; fi
  umask 077
  cat > "$env_file" <<ENV
CHRONO_HOST=$host
CHRONO_PORT=$port
CHRONO_API_TOKEN=$token
ENV
fi

cat > "$unit_dir/chrono.service" <<UNIT
[Unit]
Description=Chrono Git client server
After=network.target

[Service]
Type=simple
WorkingDirectory=$app_dir
EnvironmentFile=$env_file
ExecStart=$node_bin --experimental-strip-types $app_dir/server/index.ts
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now chrono.service
echo "Chrono is running: http://$( [ "$host" = 0.0.0.0 ] && echo "<this-host>" || echo 127.0.0.1 ):$port"
if grep -q '^CHRONO_API_TOKEN=.\+' "$env_file"; then echo "Access token: $(sed -n 's/^CHRONO_API_TOKEN=//p' "$env_file")  (stored in $env_file)"; fi
echo "Keep it running after logout: loginctl enable-linger $(id -un)"

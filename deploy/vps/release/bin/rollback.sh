#!/usr/bin/env bash
# OWNER ONLY — flips /srv/icos/current back to the previous release and restarts icos-web.
# The database is left as is: the release migrations are additive (see release/README.md).
#   sudo rollback.sh [previous-dir]
set -euo pipefail
root="${RELEASES_ROOT:-/srv/icos/releases}"
current="${CURRENT_LINK:-/srv/icos/current}"
prev="${1:-$(cat "$root/.previous" 2>/dev/null || true)}"
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
[[ -n "$prev" && -d "$prev" ]] || { echo "no previous release recorded ($root/.previous) — pass it explicitly" >&2; exit 1; }
[[ -L "$current" ]] || { echo "$current is not a symlink: the cutover never happened" >&2; exit 1; }
from=$(readlink "$current")
ln -sfn "$prev" "$current.tmp" && mv -T "$current.tmp" "$current"
echo "[rollback] current: $from -> $(readlink "$current")"
systemctl restart icos-web
for i in $(seq 1 60); do curl -s -m 2 -o /dev/null "http://127.0.0.1:3100/login" && break; sleep 1; done
"$(dirname "$0")/health-check.sh" 3100 "$(cat "$prev/RELEASE_SHA" 2>/dev/null || true)" || { echo "HEALTH FAIL after rollback — restore the drop-in-free unit: rm $root/../../etc/systemd/system/icos-web.service.d/10-release.conf; systemctl daemon-reload; systemctl restart icos-web" >&2; exit 1; }
echo "ROLLBACK=PASS"

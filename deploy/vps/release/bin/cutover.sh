#!/usr/bin/env bash
# OWNER ONLY — changes production: backup, drop-in, symlink flip, migrations, restart, health.
# Every step checks its precondition and the script stops at the first failure; nothing after a
# failed step runs. Rollback: rollback.sh (symlink back + restart; migrations are additive).
#   sudo -E cutover.sh <sha>
set -euo pipefail
sha="${1:?usage: cutover.sh <sha>}"
root="${RELEASES_ROOT:-/srv/icos/releases}"
dir="$root/${sha:0:7}"
current="${CURRENT_LINK:-/srv/icos/current}"
dropin_dir="/etc/systemd/system/icos-web.service.d"
dropin_src="$dir/deploy/vps/release/10-release.conf"
env_file="${ICOS_ENV_FILE:-/srv/icos/etc/icos.env}"
log() { printf '[cutover %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

[[ $EUID -eq 0 ]] || { echo "run as root (sudo -E): it installs a systemd drop-in and restarts icos-web" >&2; exit 1; }
[[ -f "$dir/RELEASE_SHA" && -f "$dir/.next/BUILD_ID" ]] || { echo "not a built release: $dir" >&2; exit 1; }
"$dir/deploy/vps/release/bin/preflight.sh" "$sha" || { echo "preflight FAIL — nothing changed" >&2; exit 1; }

# 1. The live tree becomes a release too, so the rollback is the same flip.
live_tree=$(systemctl show icos-web -p WorkingDirectory --value)
if [[ ! -L "$current" ]]; then
  prev="$root/$(git -C "$live_tree" rev-parse --short HEAD 2>/dev/null || echo live)-previous"
  [[ -e "$prev" ]] || ln -s "$live_tree" "$prev"
  log "previous release registered: $prev -> $live_tree"
else
  prev=$(readlink -f "$current")
fi
echo "$prev" > "$root/.previous"

# 2. Backup BEFORE anything changes (read-only on sources).
log "backup"
sudo -u icos BACKUP_ROOT=/srv/icos/backups/cutover "$dir/deploy/vps/bin/icos-backup.sh"

# 3. Drop-in: the unit runs from the symlink from now on.
install -d -m 755 "$dropin_dir"
install -m 644 "$dropin_src" "$dropin_dir/10-release.conf"
systemctl daemon-reload
log "drop-in installed: WorkingDirectory=$current"

# 4. Atomic symlink flip (rename over the old link).
ln -sfn "$dir" "$current.tmp" && mv -T "$current.tmp" "$current"
log "current -> $(readlink "$current")"

# 5. Additive migrations, as the icos user, with the production DATABASE_URL (never printed).
log "db:migrate"
sudo -u icos bash -c "set -a; . '$env_file'; set +a; cd '$dir' && pnpm --silent db:migrate" 2>&1 | grep -viE 'password|secret' | tail -3

# 6. Restart and prove.
log "restart icos-web"
systemctl restart icos-web
for i in $(seq 1 60); do curl -s -m 2 -o /dev/null "http://127.0.0.1:3100/login" && break; sleep 1; done
"$dir/deploy/vps/release/bin/health-check.sh" 3100 "$sha" || { echo "HEALTH FAIL — run rollback.sh" >&2; exit 1; }
log "CUTOVER=PASS $(cat "$dir/RELEASE_SHA")"

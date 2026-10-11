#!/usr/bin/env bash
# Preflight of a built release against the live host. READ-ONLY: prints PASS/FAIL per check and
# exits 1 if any FAIL. Secrets are never read for their values, only for the presence of a key.
#   preflight.sh <sha>
set -uo pipefail
sha="${1:?usage: preflight.sh <sha>}"
root="${RELEASES_ROOT:-/srv/icos/releases}"
dir="$root/${sha:0:7}"
env_file="${ICOS_ENV_FILE:-/srv/icos/etc/icos.env}"
live_tree="${LIVE_TREE:-$(systemctl show icos-web -p WorkingDirectory --value 2>/dev/null)}"
app_pg="${APP_PG:-icos-app-postgres}"
fail=0
check() { # name, status(0/1), detail
  if [[ "$2" == 0 ]]; then printf 'PASS  %-34s %s\n' "$1" "$3"; else printf 'FAIL  %-34s %s\n' "$1" "$3"; fail=1; fi
}

[[ -d "$dir" ]]; check "release directory" $? "$dir"
[[ -f "$dir/RELEASE_SHA" && "$(cat "$dir/RELEASE_SHA" 2>/dev/null)" == "$sha"* ]]; check "RELEASE_SHA matches" $? "$(cat "$dir/RELEASE_SHA" 2>/dev/null || echo none)"
[[ -f "$dir/.next/BUILD_ID" ]]; check "production build present" $? ".next/BUILD_ID=$(cat "$dir/.next/BUILD_ID" 2>/dev/null || echo none)"
[[ -d "$dir/node_modules/next" ]]; check "dependencies installed" $? "node_modules/next"
[[ -f "$dir/bin/icos-claude-worker.mjs" ]]; check "W10 executor shipped" $? "bin/icos-claude-worker.mjs"
[[ -f "$dir/deploy/vps/bin/icos-backup.sh" ]]; check "backup kit shipped" $? "deploy/vps/bin/icos-backup.sh"

# Migrations: the release journal vs what the live base already applied (read-only count).
if command -v docker >/dev/null && docker exec "$app_pg" true 2>/dev/null; then
  applied=$(docker exec "$app_pg" psql -U icos_app -d icos_app -Atc "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || echo "?")
  total=$(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["entries"]))' "$dir/drizzle/meta/_journal.json" 2>/dev/null || echo "?")
  if [[ "$applied" =~ ^[0-9]+$ && "$total" =~ ^[0-9]+$ ]]; then
    pending=$((total - applied))
    tags=$(python3 -I -c 'import json,sys; e=json.load(open(sys.argv[1]))["entries"]; print(",".join(x["tag"] for x in e[int(sys.argv[2]):]))' "$dir/drizzle/meta/_journal.json" "$applied")
    [[ $pending -ge 0 ]]; check "migrations pending (additive)" $? "$pending pending: ${tags:-none}"
  else
    check "migrations pending (additive)" 1 "could not read journal/applied ($total/$applied)"
  fi
else
  check "live database reachable" 1 "$app_pg"
fi

# Env keys the release needs (names only). The executor/gate keys are the autonomy step (B2).
if [[ -r "$env_file" ]]; then
  for k in DATABASE_URL BETTER_AUTH_SECRET BETTER_AUTH_URL OMNIROUTE_BASE_URL OMNIROUTE_API_KEY ICOS_EXECUTION_CALLBACK_SECRET TEMPORAL_ADDRESS TEMPORAL_NAMESPACE TEMPORAL_TASK_QUEUE; do
    grep -qE "^$k=" "$env_file"; check "env key $k" $? "present"
  done
  for k in ICOS_REPO_PATH ICOS_WORKER_WORKSPACE_ROOT ICOS_WORKSPACE_ROOT ICOS_RUNTIME_TIER; do
    if grep -qE "^$k=" "$env_file"; then printf 'PASS  %-34s %s\n' "env key $k" "present"; else printf 'WARN  %-34s %s\n' "env key $k" "absent (sovereignty/autonomy step, not required to serve)"; fi
  done
else
  check "env file readable" 1 "$env_file"
fi

code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"model":"nvidia/nvidia/nemotron-3-super-120b-a12b","stream":false,"max_tokens":1,"messages":[{"role":"user","content":"ping"}]}' http://127.0.0.1:20129/v1/chat/completions 2>/dev/null)
[[ "$code" == 200 ]]; check "OmniRoute answers (loopback)" $? "HTTP ${code:-000}"
systemctl is-active --quiet icos-web; check "icos-web active before cutover" $? "$(systemctl show icos-web -p ActiveState --value 2>/dev/null) from $live_tree"
[[ -n "$live_tree" && -d "$live_tree" ]]; check "live tree known (rollback target)" $? "$live_tree"
[[ "$(cat "$dir/.next/BUILD_ID" 2>/dev/null)" != "$(cat "$live_tree/.next/BUILD_ID" 2>/dev/null)" ]]; check "release differs from live" $? "builds differ"

echo
if [[ $fail == 0 ]]; then echo "PREFLIGHT=PASS"; else echo "PREFLIGHT=FAIL"; exit 1; fi

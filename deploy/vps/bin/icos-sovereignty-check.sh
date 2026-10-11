#!/usr/bin/env bash
# ICOS — VPS sovereignty check (READ-ONLY).
#
# Measures, on the VPS itself, whether ICOS runs without the owner's Mac, and prints the
# seven P0 verdicts. It never restarts, writes, migrates or prints a secret: credentials are
# read from the env file into a variable and only ever sent to loopback services.
#
#   deploy/vps/bin/icos-sovereignty-check.sh            # human report
#   ICOS_CHECK_JSON=1 deploy/vps/bin/icos-sovereignty-check.sh   # + JSON line at the end
#
# Exit code: 0 when every verdict is PASS, 1 otherwise.
set -uo pipefail

ICOS_ENV_FILE="${ICOS_ENV_FILE:-/srv/icos/etc/icos.env}"
ICOS_HTTP="${ICOS_HTTP:-http://127.0.0.1:3100}"
TAILNET_URL="${TAILNET_URL:-https://icos-node-01.tail2ea2a5.ts.net}"
TEMPORAL_CONTAINER="${TEMPORAL_CONTAINER:-icos-test-temporal}"
APP_DB_CONTAINER="${APP_DB_CONTAINER:-icos-app-postgres}"
PROD_QUEUE="${PROD_QUEUE:-icos-tasks}"
# The Mac's tailnet address and home prefix — anything that points at them is a dependency.
MAC_MARKERS="${MAC_MARKERS:-/Users/coco|100\.79\.85\.76|macbook|host\.docker\.internal}"

declare -A V
note() { printf '  %-6s %s\n' "$1" "$2"; }
env_get() { grep -E "^$1=" "$ICOS_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//"; }
unit_ok() { [[ "$(systemctl is-enabled "$1" 2>/dev/null)" == enabled && "$(systemctl is-active "$1" 2>/dev/null)" == active ]]; }

echo "== ICOS VPS sovereignty check — $(hostname) — $(date -Is)"

# ---------------------------------------------------------------- services persistent
echo "-- Services (systemd / docker restart policy)"
persist=PASS
for u in docker containerd tailscaled icos-web icos-omniroute; do
  if unit_ok "$u"; then note OK "$u enabled+active"; else note FAIL "$u not enabled+active"; persist=FAIL; fi
done
for c in "$APP_DB_CONTAINER" "$TEMPORAL_CONTAINER"; do
  pol=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}} {{.State.Status}}' "$c" 2>/dev/null)
  if [[ "$pol" == "unless-stopped running" || "$pol" == "always running" ]]; then note OK "container $c ($pol)"
  else note FAIL "container $c ($pol)"; persist=FAIL; fi
done
V[ICOS_SERVICES_PERSISTENT]=$persist

# ---------------------------------------------------------------- OmniRoute
echo "-- OmniRoute (loopback, VPS)"
omni=PASS
OMNI_URL=$(env_get OMNIROUTE_BASE_URL); OMNI_KEY=$(env_get OMNIROUTE_API_KEY); MODEL=$(env_get ICOS_COGNITIVE_MODEL)
[[ "$OMNI_URL" =~ ^http://127\.0\.0\.1: ]] && note OK "ICOS → OmniRoute is loopback ($OMNI_URL)" || { note FAIL "OMNIROUTE_BASE_URL not loopback: $OMNI_URL"; omni=FAIL; }
bind=$(ss -ltnH "sport = :20129" 2>/dev/null | awk '{print $4}' | head -1)
[[ "$bind" == 127.0.0.1:20129 ]] && note OK "listens on $bind only" || { note FAIL "20129 bind=$bind"; omni=FAIL; }
if [[ -n "$OMNI_KEY" && -n "$MODEL" ]]; then
  out=$(curl -s -m 120 -H "Authorization: Bearer $OMNI_KEY" -H 'Content-Type: application/json' \
    "$OMNI_URL/v1/chat/completions" \
    -d "{\"model\":\"$MODEL\",\"max_tokens\":200,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word PONG\"}]}" \
    | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print((d["choices"][0]["message"].get("content") or "").strip()[:20])
except Exception: print("")')
  [[ "$out" == *PONG* ]] && note OK "real completion via $MODEL → $out" || { note FAIL "completion via $MODEL failed"; omni=FAIL; }
else note FAIL "OMNIROUTE_API_KEY/ICOS_COGNITIVE_MODEL missing"; omni=FAIL; fi
noauth=$(curl -s -m 60 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' "$OMNI_URL/v1/chat/completions" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":1,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}")
[[ "$noauth" == 401 || "$noauth" == 403 ]] && note OK "unauthenticated /v1 refused ($noauth)" \
  || note WARN "unauthenticated /v1/chat/completions answered $noauth — enable 'require API key' before any non-loopback exposure"
V[OMNIROUTE_VPS]=$omni

# ---------------------------------------------------------------- internal routing
echo "-- Internal routing (every dependency on this host)"
routing=PASS
for k in DATABASE_URL OMNIROUTE_BASE_URL ICOS_BASE_URL TEMPORAL_ADDRESS; do
  v=$(env_get "$k" | sed -E 's#://[^@/]+@#://<cred>@#')
  [[ "$v" =~ (127\.0\.0\.1|localhost) ]] && note OK "$k → $v" || { note FAIL "$k → $v"; routing=FAIL; }
done
code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$ICOS_HTTP/login")
[[ "$code" == 200 ]] && note OK "ICOS web /login 200 on loopback" || { note FAIL "ICOS web /login → $code"; routing=FAIL; }
V[ICOS_INTERNAL_ROUTING]=$routing

# ---------------------------------------------------------------- remote access
echo "-- Remote access (Tailscale HTTPS)"
remote=PASS
serve=$(tailscale serve status 2>/dev/null)
grep -q 'proxy http://127.0.0.1:3100' <<<"$serve" && note OK "tailscale serve → 127.0.0.1:3100 (tailnet only)" || { note FAIL "no tailscale serve for ICOS"; remote=FAIL; }
grep -qi funnel <<<"$(tailscale funnel status 2>/dev/null)" && grep -q 'Funnel on' <<<"$(tailscale funnel status 2>/dev/null)" && { note FAIL "Funnel (public internet) is ON"; remote=FAIL; }
code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$TAILNET_URL/login")
[[ "$code" == 200 ]] && note OK "$TAILNET_URL/login 200 over tailnet TLS" || { note FAIL "$TAILNET_URL/login → $code"; remote=FAIL; }
V[ICOS_REMOTE_ACCESS]=$remote

# ---------------------------------------------------------------- workers
echo "-- Workers (Temporal queue '$PROD_QUEUE' + scheduler)"
workers=PASS
pollers=$(docker exec "$TEMPORAL_CONTAINER" sh -c "temporal task-queue describe --task-queue $PROD_QUEUE --address \$(hostname -i):7233 -o json" 2>/dev/null \
  | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print(sum(len(v.get("pollers") or []) for v in (d.get("versionsInfo") or {}).values()) if "versionsInfo" in d else len(d.get("pollers") or []))
except Exception: print(-1)')
[[ "${pollers:--1}" -gt 0 ]] && note OK "$pollers poller(s) on $PROD_QUEUE" || { note FAIL "no worker polls $PROD_QUEUE (pollers=$pollers)"; workers=FAIL; }
if unit_ok icos-temporal-worker; then note OK "icos-temporal-worker.service enabled+active"; else note FAIL "icos-temporal-worker.service absent/inactive"; workers=FAIL; fi
last=$(docker exec "$APP_DB_CONTAINER" psql -U icos_app -d icos_app -Atc \
  "select extract(epoch from now()-max(updated_at))::int from scheduled_jobs where state='succeeded'" 2>/dev/null)
[[ -n "$last" && "$last" -lt 900 ]] && note OK "in-process scheduler ran ${last}s ago" || { note FAIL "scheduler idle (${last:-?}s)"; workers=FAIL; }
V[ICOS_WORKERS_VPS]=$workers

# ---------------------------------------------------------------- Mac dependency
echo "-- Mac dependency"
mac=PASS
deploy_dir=$(systemctl show -p WorkingDirectory --value icos-web 2>/dev/null)
hits=$(grep -EIl "$MAC_MARKERS" "$ICOS_ENV_FILE" /srv/icos/etc/omniroute.env /etc/systemd/system/icos-*.service 2>/dev/null)
[[ -z "$hits" ]] && note OK "no Mac marker in live env/unit files" || { note FAIL "Mac marker in: $hits"; mac=FAIL; }
for k in ICOS_REPO_PATH ICOS_WORKER_WORKSPACE_ROOT ICOS_WORKSPACE_ROOT; do
  v=$(env_get "$k")
  [[ -n "$v" && -d "$v" ]] && note OK "$k=$v" || { note FAIL "$k unset → code falls back to /Users/coco/* or refuses"; mac=FAIL; }
done
peer=$(ss -tnH state established 2>/dev/null | grep -c '100\.79\.85\.76' || true)
note INFO "live TCP sessions from the Mac's tailnet IP: $peer (access only, not a dependency)"
V[MAC_DEPENDENCY_ZERO]=$mac

# ---------------------------------------------------------------- autonomy
echo "-- Autonomy without Mac"
auto=PASS
[[ "${V[ICOS_WORKERS_VPS]}" == PASS ]] || { note FAIL "no execution worker on the VPS"; auto=FAIL; }
execs=$(env_get ICOS_WORKER_EXEC_COMMANDS)
[[ -n "$execs" ]] && note OK "ICOS_WORKER_EXEC_COMMANDS declared" || { note FAIL "ICOS_WORKER_EXEC_COMMANDS unset → no executor runtime"; auto=FAIL; }
for b in claude hermes codex; do command -v "$b" >/dev/null && note INFO "$b: $(command -v "$b")" || note INFO "$b: not installed"; done
done_missions=$(docker exec "$APP_DB_CONTAINER" psql -U icos_app -d icos_app -Atc "select count(*) from dispatch_attempts" 2>/dev/null)
note INFO "dispatch_attempts recorded in prod: ${done_missions:-?}"
V[AUTONOMY_WITHOUT_MAC]=$auto

echo "== Verdicts"
all=0
for k in MAC_DEPENDENCY_ZERO OMNIROUTE_VPS ICOS_SERVICES_PERSISTENT ICOS_INTERNAL_ROUTING ICOS_REMOTE_ACCESS ICOS_WORKERS_VPS AUTONOMY_WITHOUT_MAC; do
  echo "$k=${V[$k]}"; [[ "${V[$k]}" == PASS ]] || all=1
done
if [[ "${ICOS_CHECK_JSON:-0}" == 1 ]]; then
  printf '{'; first=1; for k in "${!V[@]}"; do ((first)) || printf ','; first=0; printf '"%s":"%s"' "$k" "${V[$k]}"; done; printf '}\n'
fi
exit $all

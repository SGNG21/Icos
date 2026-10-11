#!/usr/bin/env bash
# READ-ONLY readiness check for autonomy on the VPS (B1 executor paths, B2 governed execution,
# D Temporal namespace, B3 worker). Prints PASS/FAIL/WARN per item and the verdicts; never prints
# a secret (only whether a key is set). Safe to run any time, before and after each step.
#   icos-autonomy-check.sh [env-file]
set -uo pipefail
env_file="${1:-${ICOS_ENV_FILE:-/srv/icos/etc/icos.env}}"
fail=0; warn=0
pass() { printf 'PASS  %-38s %s\n' "$1" "$2"; }
failf() { printf 'FAIL  %-38s %s\n' "$1" "$2"; fail=1; }
warnf() { printf 'WARN  %-38s %s\n' "$1" "$2"; warn=1; }
val() { grep -E "^$1=" "$env_file" 2>/dev/null | head -1 | cut -d= -f2- | sed -E "s/^'(.*)'$/\1/; s/^\"(.*)\"$/\1/"; }
has() { grep -qE "^$1=" "$env_file" 2>/dev/null; }

[[ -r "$env_file" ]] || { echo "env file not readable: $env_file"; exit 1; }
echo "# icos-autonomy-check $(date -u +%FT%TZ) env=$env_file"

# ---- B1 paths
for k in ICOS_REPO_PATH ICOS_WORKSPACE_ROOT; do
  v=$(val "$k")
  if [[ -z "$v" ]]; then failf "$k" "absent → code falls back to /Users/coco (Mac)"
  elif [[ "$v" == /Users/* ]]; then failf "$k" "Mac path"
  elif [[ -d "$v" ]]; then pass "$k" "$v (exists)"
  else failf "$k" "$v missing"; fi
done
v=$(val ICOS_WORKER_WORKSPACE_ROOT)
if [[ -z "$v" ]]; then failf "ICOS_WORKER_WORKSPACE_ROOT" "absent"
elif [[ -d "$v" && -w "$v" ]]; then pass "ICOS_WORKER_WORKSPACE_ROOT" "$v (writable by $(id -un))"
else failf "ICOS_WORKER_WORKSPACE_ROOT" "$v not a writable directory"; fi
grep -rqs '/Users/coco' "$env_file" && failf "env file Mac paths" "found" || pass "env file Mac paths" "none"
t=$(val ICOS_RUNTIME_TIER); [[ "$t" == live || "$t" == lab ]] && pass "ICOS_RUNTIME_TIER" "$t (certifies proofs only, never creates them)" || warnf "ICOS_RUNTIME_TIER" "undeclared → proofs credited CODE_READY"
st=$(stat -c '%a %U' "$env_file"); [[ "$st" == "600 icos" ]] && pass "env file mode" "$st" || warnf "env file mode" "$st (expected 600 icos)"

# ---- B2 executor
command -v claude >/dev/null && pass "claude CLI" "$(claude --version 2>/dev/null | head -1)" || failf "claude CLI" "not installed"
command -v bwrap >/dev/null && pass "bubblewrap" "$(bwrap --version 2>/dev/null)" || failf "bubblewrap" "not installed"
[[ -f /etc/apparmor.d/bwrap ]] && pass "AppArmor bwrap profile" "/etc/apparmor.d/bwrap" || warnf "AppArmor bwrap profile" "absent (bwrap may be refused on Ubuntu 24.04)"
ex=$(val ICOS_WORKER_EXEC_COMMANDS)
if [[ -z "$ex" ]]; then failf "ICOS_WORKER_EXEC_COMMANDS" "absent → Exécuteurs = 0, every task fails closed"
else
  cmd=$(python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); print(d.get("binary",{}).get("command",""))' "$ex" 2>/dev/null)
  if [[ -z "$cmd" ]]; then failf "ICOS_WORKER_EXEC_COMMANDS" "not valid JSON with a binary.command"
  elif [[ -x "$cmd" ]]; then pass "ICOS_WORKER_EXEC_COMMANDS" "binary → $cmd (executable)"
  else failf "ICOS_WORKER_EXEC_COMMANDS" "$cmd not executable"; fi
  al=$(val ICOS_WORKER_EXECUTABLE_ALLOWLIST)
  [[ -n "$al" && "$al" == *"$cmd"* ]] && pass "ICOS_WORKER_EXECUTABLE_ALLOWLIST" "contains the executor" || failf "ICOS_WORKER_EXECUTABLE_ALLOWLIST" "does not list $cmd"
fi
has ICOS_GATE_COMMANDS && pass "ICOS_GATE_COMMANDS" "set" || failf "ICOS_GATE_COMMANDS" "absent"
tdb=$(val ICOS_TEST_DATABASE_URL)
if [[ -z "$tdb" ]]; then failf "ICOS_TEST_DATABASE_URL (gate)" "absent → gate postgres step cannot run"
elif [[ "$tdb" == *"/icos_app"* || "$tdb" == *":5433/"* ]]; then failf "ICOS_TEST_DATABASE_URL (gate)" "points at the LIVE base"
elif [[ "${tdb##*/}" == *test* ]]; then pass "ICOS_TEST_DATABASE_URL (gate)" "database '${tdb##*/}' (name contains test)"
else failf "ICOS_TEST_DATABASE_URL (gate)" "database '${tdb##*/}' must contain 'test' (guard)"; fi
rc=$(val ICOS_REVIEWER_COMMAND); rm_=$(val ICOS_REVIEWER_MODEL)
if [[ "$rc" == *printf* ]]; then failf "reviewer" "ICOS_REVIEWER_COMMAND is the printf stub (no real review)"
elif [[ -n "$rm_" ]]; then pass "reviewer" "ICOS_REVIEWER_MODEL=$rm_ (OmniRoute reviewer)"
elif [[ -n "$rc" ]]; then warnf "reviewer" "ICOS_REVIEWER_COMMAND set (external reviewer)"
else failf "reviewer" "none configured"; fi
has ICOS_GOAL_MAX_TOTAL_TOKENS && pass "ICOS_GOAL_MAX_TOTAL_TOKENS" "$(val ICOS_GOAL_MAX_TOTAL_TOKENS)" || warnf "ICOS_GOAL_MAX_TOTAL_TOKENS" "absent (default cap)"
sd=$(val ICOS_SELF_DEVELOPMENT); [[ "$sd" == enabled ]] && warnf "ICOS_SELF_DEVELOPMENT" "enabled → the scheduler will propose and run goals on its own (step E)" || pass "ICOS_SELF_DEVELOPMENT" "${sd:-disabled}"
it=$(val ICOS_INTEGRATION_TARGET); [[ -z "$it" || "$it" == integration/* ]] && pass "ICOS_INTEGRATION_TARGET" "${it:-default integration/<name>}" || failf "ICOS_INTEGRATION_TARGET" "$it is not integration/<name>"
base=$(val OMNIROUTE_BASE_URL)
if [[ -n "$base" ]]; then
  m=$(val ICOS_REVIEWER_MODEL); m=${m:-codex/gpt-5.5-low}
  code=$(curl -s -m 25 -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d "{\"model\":\"$m\",\"stream\":false,\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" "$base/v1/chat/completions" 2>/dev/null)
  [[ "$code" == 200 ]] && pass "OmniRoute chat (reviewer/planner path)" "$m HTTP $code" || failf "OmniRoute chat (reviewer/planner path)" "$m HTTP ${code:-000}"
  code=$(curl -s -m 25 -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' -d '{"model":"codex/gpt-5.5-low","stream":false,"max_tokens":1,"messages":[{"role":"user","content":"ping"}]}' "$base/v1/messages" 2>/dev/null)
  [[ "$code" == 200 ]] && pass "OmniRoute messages (executor path)" "codex/gpt-5.5-low HTTP $code" || failf "OmniRoute messages (executor path)" "HTTP ${code:-000}"
fi

# ---- D Temporal
addr=$(val TEMPORAL_ADDRESS); ns=$(val TEMPORAL_NAMESPACE); tq=$(val TEMPORAL_TASK_QUEUE)
[[ -n "$ns" ]] && pass "TEMPORAL_NAMESPACE" "$ns" || warnf "TEMPORAL_NAMESPACE" "absent → default (shared with integration suites)"
[[ -n "$tq" ]] && pass "TEMPORAL_TASK_QUEUE" "$tq" || failf "TEMPORAL_TASK_QUEUE" "absent"
if [[ "$addr" == 127.0.0.1:7233 || "$addr" == localhost:7233 ]] && docker exec icos-test-temporal true 2>/dev/null; then
  if docker exec icos-test-temporal sh -c "temporal operator namespace describe --address \$(hostname -i):7233 --namespace '${ns:-default}'" >/dev/null 2>&1; then
    pass "namespace exists on $addr" "${ns:-default}"
    pol=$(docker exec icos-test-temporal sh -c "temporal task-queue describe --address \$(hostname -i):7233 --namespace '${ns:-default}' --task-queue '${tq:-icos-tasks}'" 2>/dev/null | grep -cE '^\s+[0-9a-f]')
    [[ "${pol:-0}" -ge 2 ]] && pass "pollers on ${tq:-icos-tasks}" "$pol (workflow + activity)" || failf "pollers on ${tq:-icos-tasks}" "${pol:-0} — no execution worker is polling"
  else failf "namespace exists on $addr" "${ns:-default} not registered (D)"; fi
else warnf "Temporal" "address $addr not the local shared server; not probed"; fi

# ---- B3 worker unit
if systemctl cat icos-temporal-worker >/dev/null 2>&1; then
  systemctl is-enabled --quiet icos-temporal-worker && pass "icos-temporal-worker enabled" "yes" || failf "icos-temporal-worker enabled" "no"
  systemctl is-active --quiet icos-temporal-worker && pass "icos-temporal-worker active" "$(systemctl show icos-temporal-worker -p NRestarts --value) restarts, $(systemctl show icos-temporal-worker -p WorkingDirectory --value)" || failf "icos-temporal-worker active" "$(systemctl show icos-temporal-worker -p ActiveState --value)"
else failf "icos-temporal-worker unit" "not installed (B3)"; fi

echo
[[ $fail == 0 ]] && echo "AUTONOMY_READY=PASS${warn:+ (with warnings)}" || { echo "AUTONOMY_READY=FAIL"; exit 1; }

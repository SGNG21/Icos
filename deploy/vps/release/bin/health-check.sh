#!/usr/bin/env bash
# Health of a running ICOS web instance. READ-ONLY. Exits 1 on any FAIL.
#   health-check.sh [port] [expected-sha]
set -uo pipefail
port="${1:-3100}"
expect="${2:-}"
base="http://127.0.0.1:$port"
unit="${ICOS_UNIT:-icos-web}"
fail=0
check() { if [[ "$2" == 0 ]]; then printf 'PASS  %-30s %s\n' "$1" "$3"; else printf 'FAIL  %-30s %s\n' "$1" "$3"; fail=1; fi; }

code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$base/login"); [[ "$code" == 200 ]]; check "GET /login" $? "HTTP $code"
code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$base/api/cockpit"); [[ "$code" == 401 || "$code" == 403 ]]; check "GET /api/cockpit without session" $? "HTTP $code (auth gate alive)"
code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$base/cockpit"); [[ "$code" == 200 || "$code" == 307 || "$code" == 302 ]]; check "GET /cockpit redirects to login" $? "HTTP $code"
if [[ -n "$expect" ]]; then
  tree=$(systemctl show "$unit" -p WorkingDirectory --value 2>/dev/null)
  served=$(cat "$tree/RELEASE_SHA" 2>/dev/null || echo "none")
  [[ "$served" == "$expect"* ]]; check "served RELEASE_SHA" $? "$served (from $tree)"
fi
if systemctl cat "$unit" >/dev/null 2>&1; then
  n=$(journalctl -u "$unit" --since '-2min' --no-pager -o cat 2>/dev/null | grep -cE 'Error:|unhandledRejection|EADDRINUSE|ECONNREFUSED')
  [[ "$n" == 0 ]]; check "journal errors (2 min)" $? "$n"
  restarts=$(systemctl show "$unit" -p NRestarts --value 2>/dev/null)
  [[ "${restarts:-0}" == 0 ]]; check "no crash-restart since start" $? "NRestarts=$restarts"
fi
echo
if [[ $fail == 0 ]]; then echo "HEALTH=PASS"; else echo "HEALTH=FAIL"; exit 1; fi

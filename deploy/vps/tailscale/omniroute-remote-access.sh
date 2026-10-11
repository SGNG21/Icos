#!/usr/bin/env bash
# OmniRoute dashboard over Tailscale HTTPS, directly on the VPS — replaces the Mac's
# `ssh -L 20130:127.0.0.1:20129` tunnel.
#
#   omniroute-remote-access.sh            # DRY RUN: checks preconditions, prints the plan
#   omniroute-remote-access.sh --apply    # owner only: applies it
#   omniroute-remote-access.sh --rollback # removes the :8443 handler
#
# ICOS keeps https://<node>.ts.net/ (443 → 127.0.0.1:3100); OmniRoute is added on :8443.
# Tailnet only — never `tailscale funnel`. OmniRoute keeps binding 127.0.0.1.
set -euo pipefail

NODE_URL="${NODE_URL:-https://icos-node-01.tail2ea2a5.ts.net}"
OMNI_LOCAL="${OMNI_LOCAL:-http://127.0.0.1:20129}"
HTTPS_PORT="${HTTPS_PORT:-8443}"
MODE="${1:-dry-run}"

if [[ "$MODE" == --rollback ]]; then
  sudo tailscale serve --https="$HTTPS_PORT" off
  tailscale serve status
  exit 0
fi

echo "== Preconditions"
fail=0
# 1. ICOS's handler must exist and must survive this change untouched.
tailscale serve status | grep -q 'proxy http://127.0.0.1:3100' && echo "OK   ICOS served on 443" || { echo "FAIL ICOS 443 handler missing"; fail=1; }
# 2. Tailscale serve forwards from 127.0.0.1, so OmniRoute sees every tailnet request as LOCAL.
#    Its OpenAI-compatible API must therefore refuse unauthenticated calls first
#    (dashboard → Settings → Security → "Require API key"). Owner action: it is a setting
#    stored in OmniRoute's SQLite, which automation must not modify.
code=$(curl -s -m 60 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  "$OMNI_LOCAL/v1/chat/completions" -d '{"model":"auto/fast","max_tokens":1,"stream":false,"messages":[{"role":"user","content":"x"}]}')
if [[ "$code" == 401 || "$code" == 403 ]]; then echo "OK   unauthenticated /v1 refused ($code)"
else echo "FAIL unauthenticated /v1/chat/completions → $code (enable 'Require API key' first)"; fail=1; fi
# 3. Dashboard management APIs already require a session.
code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$OMNI_LOCAL/api/providers")
[[ "$code" == 401 ]] && echo "OK   dashboard APIs require login" || { echo "FAIL /api/providers → $code"; fail=1; }
# 4. Port free in serve config.
tailscale serve status --json | grep -q "\"$HTTPS_PORT\"" && { echo "FAIL :$HTTPS_PORT already served"; fail=1; } || echo "OK   :$HTTPS_PORT free"

echo "== Plan"
echo "sudo tailscale serve --bg --https=$HTTPS_PORT $OMNI_LOCAL"
echo "→ $NODE_URL:$HTTPS_PORT/dashboard (tailnet devices only)"
echo "Live monitor WebSocket (127.0.0.1:20132) and embed proxy (127.0.0.1:20131) stay loopback;"
echo "see deploy/vps/README.md §OmniRoute for the optional live-WS exposure."

if [[ "$MODE" != --apply ]]; then echo "(dry run — nothing changed)"; exit $fail; fi
[[ $fail -eq 0 ]] || { echo "Preconditions failed — refusing to apply."; exit 1; }
sudo tailscale serve --bg --https="$HTTPS_PORT" "$OMNI_LOCAL"
tailscale serve status
curl -s -m 15 -o /dev/null -w "verify $NODE_URL:$HTTPS_PORT/login → %{http_code}\n" "$NODE_URL:$HTTPS_PORT/login"
curl -s -m 15 -o /dev/null -w "verify ICOS $NODE_URL/login → %{http_code}\n" "$NODE_URL/login"

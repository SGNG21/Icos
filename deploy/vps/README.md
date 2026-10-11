# ICOS on the VPS — sovereignty kit

Everything here is **prepared, not installed**. Each step below changes production and needs
the owner's go (release policy). Every step has a rollback. Audit and evidence:
`docs/icos/vps-sovereignty-audit-2026-10-11.md`.

| File                                                        | Purpose                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `bin/icos-sovereignty-check.sh`                             | Read-only check, prints the 7 P0 verdicts. Safe to run any time.              |
| `systemd/icos-temporal-worker.service`                      | The missing execution worker (polls `icos-tasks`).                            |
| `bin/icos-backup.sh`, `systemd/icos-backup.{service,timer}` | Daily backup of app PG, Temporal PG, OmniRoute SQLite (read-only on sources). |
| `env/icos.env.sovereignty.example`                          | Non-secret env additions that remove the `/Users/coco` fallbacks.             |
| `tailscale/omniroute-remote-access.sh`                      | OmniRoute dashboard over tailnet HTTPS (:8443), dry-run by default.           |

Run the check before and after each step:

```bash
/srv/icos/worktrees/p0-vps-sovereignty/deploy/vps/bin/icos-sovereignty-check.sh
```

## Step 1 — Workspace paths (removes the Mac path fallback)

```bash
sudo cp -a /srv/icos/etc/icos.env /srv/icos/etc/icos.env.bak-sovereignty-$(date +%Y%m%d-%H%M%S)
# Append the three uncommented lines of env/icos.env.sovereignty.example to icos.env, then:
sudo systemctl restart icos-web
```

Rollback: restore the `.bak-sovereignty-*` file and restart `icos-web`.
Effect: `WorkspaceManager` and the writer worker use `/srv/icos/repo` + `/srv/icos/workers`
instead of `/Users/coco/icos` + `/Users/coco/icos-worktrees`.

## Step 2 — Execution worker

Prerequisite: the deployed tree contains the worker code you want live. `/srv/icos/worktrees/vps-deploy`
(049a7d9) is 48 commits behind `main` and carries 5 voice commits not on `main`; the P0
autonomy work (W1–W11) is **not** deployed. Integrating it is the release decision, not this kit's.

```bash
sudo install -m 644 deploy/vps/systemd/icos-temporal-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now icos-temporal-worker
journalctl -u icos-temporal-worker -n 20 --no-pager     # expect "ICOS execution worker on 127.0.0.1:7233 …"
```

Without `ICOS_WORKER_EXEC_COMMANDS` the worker runs, polls, and every task fails closed with
PROVIDER_UNAVAILABLE — safe, but not yet autonomous. Choosing the executor (Claude Code via the
W10 executor, or installing Hermes/Codex) is an owner decision.

Rollback: `sudo systemctl disable --now icos-temporal-worker && sudo rm /etc/systemd/system/icos-temporal-worker.service && sudo systemctl daemon-reload`.
Workflows already started stay in Temporal and resume when a worker returns.

## Step 3 — Backups

```bash
sudo install -d -o icos -g icos -m 755 /srv/icos/bin
sudo install -o icos -g icos -m 755 deploy/vps/bin/icos-backup.sh /srv/icos/bin/
sudo install -m 644 deploy/vps/systemd/icos-backup.service deploy/vps/systemd/icos-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start icos-backup.service && journalctl -u icos-backup -n 10 --no-pager
sudo systemctl enable --now icos-backup.timer
```

Backups land in `/srv/icos/backups/daily/<UTC stamp>/` (mode 600, `SHA256SUMS`, 14-day
retention, a failed run is marked `FAILED`). They are **on the same disk**: an off-host copy
(Contabo snapshot or object storage) is still needed and is a budget decision.
Rollback: `sudo systemctl disable --now icos-backup.timer`.

Restore drill (lab, never over production):
`docker exec -i <lab-pg> pg_restore -U <user> -d <empty db> < icos_app.dump`.

## Step 2b — Gate database (B2): a TEST cluster the integration gate may create databases on

The gate's PostgreSQL step (W7) creates a per-run disposable database + role on an ADMIN test URL
(`ICOS_TEST_DATABASE_URL`), reached only through the gatekeeper socket; the live base must never be
that URL. Recommended: a dedicated loopback container with its own named volume, so the gate shares
nothing with the live base (5433) nor with the Temporal persistence (5432, risk R3).

```bash
# owner — one time; the password goes ONLY into /srv/icos/etc/icos.env (ICOS_TEST_DATABASE_URL)
docker run -d --name icos-gate-postgres --restart unless-stopped \
  -e POSTGRES_USER=icos -e POSTGRES_PASSWORD="$(openssl rand -hex 24)" -e POSTGRES_DB=icos_gate_test \
  -p 127.0.0.1:5434:5432 -v icos-gate-postgres-data:/var/lib/postgresql/data postgres:14-alpine
# ICOS_TEST_DATABASE_URL=postgres://icos:<that password>@127.0.0.1:5434/icos_gate_test
```

Check: `deploy/vps/bin/icos-autonomy-check.sh` (PASS "ICOS_TEST_DATABASE_URL (gate)" — the name
must contain `test`, the guard refuses anything else). Rollback: `docker rm -f icos-gate-postgres
&& docker volume rm icos-gate-postgres-data`; nothing else references it.

## Step 2c — Autonomy env (B1 + B2 + D) and the worker (B3), in this order

1. Namespace: `docker exec icos-test-temporal sh -c 'temporal operator namespace create --address $(hostname -i):7233 --namespace icos-prod --retention 720h'` (additive; inert until something uses it).
2. Merge `env/icos.env.sovereignty.example` then `env/icos.env.autonomy.example` into `icos.env`
   (owner; `.bak` first), REMOVE `ICOS_REVIEWER_COMMAND`, fill `ICOS_TEST_DATABASE_URL`.
3. `deploy/vps/bin/icos-autonomy-check.sh` → every FAIL must be gone except "pollers" (no worker yet).
4. `sudo systemctl restart icos-web` (reads the new namespace/paths/reviewer) → `release/bin/health-check.sh 3100`.
5. Step 2 above (worker unit; its `WorkingDirectory` is `/srv/icos/current`) → `icos-autonomy-check.sh` → `AUTONOMY_READY=PASS`.
   Rollback of the whole block: restore the `.bak`, `systemctl disable --now icos-temporal-worker`, restart `icos-web`.

## Step 4 — OmniRoute over Tailscale (replaces the Mac's SSH tunnel)

1. Owner, in the OmniRoute dashboard (still via the existing tunnel): enable **Require API key**
   for `/v1`. Today `/v1/chat/completions` answers unauthenticated callers, and Tailscale serve
   forwards from 127.0.0.1, so every tailnet device would be "local" to OmniRoute.
   ICOS already sends `OMNIROUTE_API_KEY`; nothing else changes for ICOS.
2. `deploy/vps/tailscale/omniroute-remote-access.sh` (dry run) must show all `OK`.
3. `deploy/vps/tailscale/omniroute-remote-access.sh --apply`
4. From the phone or Mac on the tailnet: `https://icos-node-01.tail2ea2a5.ts.net:8443/dashboard`.

Rollback: `deploy/vps/tailscale/omniroute-remote-access.sh --rollback`.

Cookies are scoped by host, not port: the ICOS session cookie will also be sent to :8443 and
OmniRoute's to :443. Both apps are the owner's and loopback-only behind Tailscale, so this is
accepted for now; a separate hostname (Tailscale Service `svc:omniroute`) removes it but needs the
node to be tagged — an ACL change for the owner.

Optional live-monitor WebSocket (loopback :20132 today): add to `/srv/icos/etc/omniroute.env`
`LIVE_WS_ALLOWED_ORIGINS=https://icos-node-01.tail2ea2a5.ts.net:8443` and serve
`sudo tailscale serve --bg --https=8444 http://127.0.0.1:20132`, then restart `icos-omniroute`.
Whether the dashboard picks up `NEXT_PUBLIC_LIVE_WS_PUBLIC_URL` at runtime is unverified.
Port 20131 (embedded-service WS proxy) must stay loopback.

# Handoff — `COMPUTE_BOOTSTRAP PROVIDER_UNAVAILABLE` (N1 lab run8) — 2026-10-11

For the OmniRoute lane and the fleet lane (W1/W9, `feat/p0-autonomy-unblock`). Measured by
FABLE 5.1 on the VPS, read-only; nothing changed. No OmniRoute worker session is reachable from
this session (`ListAgents` shows only `p0-vps-sovereignty`), hence this file.

## What the lab logs say

`/home/icos/.icos-n1-lab/logs/app.log` (run8, `icos_lab_run8`): three
`COMPUTE_BOOTSTRAP {"status":"PROVIDER_UNAVAILABLE","error":"The operation was aborted due to timeout"}`
at boot. `journalctl -u icos-omniroute` over the same two hours: 0 error, 0 timeout — OmniRoute
did not fail; it answered too late.

## The mechanism

- `src/server/workers/compute-fleet.ts:71` — `listOmniRouteModels` aborts after
  `timeoutMs ?? 10_000`; `startup-compute-bootstrap.ts` passes no value, and no env key exists
  to raise it.
- OmniRoute's `/v1/models` is slow only on the FIRST call after an idle period, then fast:
  measured 5.03 s → 1.07 s → 0.03 s (20:19 UTC) and 5.57 s → 0.89 s → 0.035 s → 0.008 s
  (20:08 UTC) — provider re-resolution on a cold cache. Under host load (load average 13.9 at
  20:15 with ten lab Postgres containers and two builds) that first call crosses 10 s.
- The bootstrap fires exactly at app boot, i.e. when OmniRoute is most likely cold → the one
  call that times out is the one that seeds the fleet.

## Why run8 still progressed

The periodic fleet reconciliation on the durable scheduler (W9 `85b2720`, migration 0064)
re-listed the models later: run8 reached a successful Claude Code execution at 19:09 UTC and
two independent reviews at 19:12. So the timeout DELAYS the fleet; it does not block N1 by
itself. The mission then failed on the review path (`REQUEST_CHANGES` + deterministic `BLOCK`,
19:12:51), which is the W6/W8 lane.

## Options (owners decide; none applied here)

1. `startup-compute-bootstrap.ts`: one bounded retry with backoff (e.g. 3 × 10 s) — the second
   call is warm and sub-second (measured).
2. An env override for the discovery timeout (`ICOS_COMPUTE_DISCOVERY_TIMEOUT_MS`), defaulting
   to 10 s, so a loaded host can be configured rather than patched.
3. OmniRoute: keep the provider cache warm (a loopback `/v1/models` on a timer, or OmniRoute's
   own warm-up setting if one exists) — OmniRoute lane.
4. Host load: the `p0au-pg-w*` containers from finished worker runs (`restart=no`, 9 running)
   are the easiest load to remove — their owners' call.

## Repro (read-only)

```bash
for i in 1 2 3; do curl -s -m 30 -o /dev/null -w '%{time_total}s\n' http://127.0.0.1:20129/v1/models; done
grep -c 'COMPUTE_BOOTSTRAP' /home/icos/.icos-n1-lab/logs/app.log
```

# Live activation procedure — PREPARED, NOT EXECUTED

**Nothing in this document has been run.** No live database was touched, no deployment made,
nothing pushed, port 3310 untouched. Every step below is for you to execute, in order, with
a stop condition. `LIVE_ACTIVATION_PLAN=READY` means the procedure is written and its
preconditions are checkable — not that any of it happened.

Two standing hazards, both previously observed in this repository, that this plan is shaped
around:

- **Another session shares this worktree.** A second Claude session was live here during
  this work. Gates run on a mutating tree prove nothing — check for live writers before
  certifying.
- **A live runtime is serving from `integration-central`.** `scripts/voice-server.ts` is
  running from that worktree. A clean tree in *this* one does not mean nothing is deployed.

---

## a. Merge/reconcile into integration-central

```bash
cd ~/icos-worktrees/integration-central && git fetch --all && git log --oneline -3
cd ~/icos-worktrees/big-autonomy-ui-self-improve
git merge-base --is-ancestor HEAD <central-tip> || echo "DIVERGED — reconcile, do not force"
```

**Collision audit must come from `git diff`, not filenames** — name-based ownership has been
wrong here before. Check in particular:

| What | Why |
|---|---|
| decision + migration numbers | Parallel lanes have silently claimed the same number; differing filenames merge with NO git conflict. |
| `src/server/container.ts` | Every lane touches it. The spend composition **moved above `buildLlmReviewer`** in this lane; a merge that reorders it back breaks reviewer metering silently. |
| `src/server/system/production-services.ts` | Known shared file. |
| `src/core/workforce/contracts.ts` | `WorkRequest.requiredAgentId` added here. |

**Stop if** the merge reorders the container's spend composition, or two lanes claim one
migration number.

## b. Full re-certification (on a frozen tree, no other writer)

```bash
ps -axo pid,command | grep -c "[c]laude"        # expect only your own session
git status --short                               # expect empty
pnpm typecheck && pnpm lint && pnpm build
pnpm test                                        # expect 3597 passed
docker info >/dev/null && pnpm test:integration  # Docker MUST be up — see below
pnpm certify:gateway                             # expect 2x PROVEN
```

**Docker must be running.** 13 integration files are gated `skipIf(!dockerAvailable)` and
skip SILENTLY with exit 0 — including auth and audit append-only. "Integration green" with
Docker down means considerably less than it looks.

**Stop if** any gate fails, or if the integration file count is lower than the previous run.

## c. Bootstrap exactly 12 canonical brains

```bash
export ICOS_OWNER_EMAIL=<owner>
export ICOS_ROLE_CERTIFIER_EMAIL=<a different human>   # see note
pnpm workforce:bootstrap
```

This is **a human act, deliberately**: it creates twelve durable identities and grants them
tools. It never runs at boot, because a redeploy must not grant powers. It is idempotent —
re-running creates nothing and re-grants nothing, and an interrupted run resumes.

Note on the two emails: `SELF_CERTIFICATION` compares the certifier to the role's *creator*.
Shipped templates are created by `{system, workforce-bootstrap}`, so the owner may certify
them and the second email is optional today. A **system** certifier is always refused.

Expected output: `"result": "workforce_ready"`, every brain `created`, every grant
`granted` or `no-tools-needed`.

## d. Verify 12 rows, no duplicates

```sql
SELECT count(*), count(DISTINCT agent_id) FROM workforce_agents WHERE kind = 'DURABLE_AGENT';
-- expect 12 | 12
SELECT agent_id, status, jsonb_array_length(policy->'toolGrants') AS tools
FROM workforce_agents WHERE kind = 'DURABLE_AGENT' ORDER BY agent_id;
```

Expect exactly: architect, builder, business, chief, delivery, evolution, growth, memory,
planner, recovery, research, reviewer — all `active`. `brain-chief` holds the union of the
fleet's tools (authority flows down); `brain-research` holds only `web_research`.

**Stop if** count ≠ 12, any duplicate, or any brain holds tools its role does not declare.

## e. Restart / reload the runtime

Required: the container composes the spend meters, the reviewer seam and
`conversationFetch` at construction. A running process from before this lane keeps the old
graph — the reviewer and the CEO client would still spend off-meter.

**Check for a live deploy first**, not just a clean tree:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E "3000|3001|3310"
```

## f. Verify UI

- `/voice` loads, phase **OFF**, "Micro fermé", one large button.
- Wake-word toggle visible and **DISABLED**, reading "Aucun moteur local installé".
- Cockpit loads; no console errors.

## g. Xiaomi continuous voice acceptance

Run `docs/acceptance/2026-10-02-voice-device-checklist.md` and fill the result column.
**PASS requires zero mic taps between opening and closing the session.**

## h. ONE bounded read-only autonomous E2E

> "ICOS, audite ton système et propose trois améliorations."

Set these **before** launching, or it is not bounded:

```bash
ICOS_GOAL_MAX_TOTAL_TOKENS=<a number you are willing to spend>
ICOS_MAX_OUTPUT_TOKENS=8192
ICOS_CONVERSATION_MAX_TOTAL_TOKENS=200000
```

Expect: a goal, Chief delegation, assignments visible to the dispatcher, a **proposal**, and
an approval card. Verify afterwards:

```sql
SELECT attribution_key, sum(total_tokens) FROM spend_ledger GROUP BY 1;
SELECT state, count(*) FROM spend_reservations GROUP BY 1;   -- expect no stuck OPEN rows
```

**Stop immediately if** anything is written outside a worktree, spend appears under an
unexpected attribution key, or reservations remain OPEN after the mission settles.

## i. Then "ICOS, améliore-toi." in READ-ONLY / proposal mode

Keep `ICOS_SELF_DEVELOPMENT` **off**. Expect SELF_IMPROVEMENT → Chief → `brain-evolution`,
and a proposal awaiting your decision. Nothing integrates without approval.

---

## Known limits you are activating with

| Limit | Consequence in production |
|---|---|
| Per-endpoint network policy is declarative | A worker granted network has **all** network. Seatbelt cannot filter hostnames. |
| Worker token spend is bounded, not metered | Hermes and Codex report usage and it is read; any other executor is bounded by invocations + wall clock only. |
| A money cap denies while the price table is empty | Intended fail-closed. Use a **token** cap until real prices exist. |
| `sandbox-exec` is deprecated by Apple | Works, no CLI successor; container port is in the type. |
| The execution record is defined, not yet persisted | It is produced and proven; it does not yet have its own durable table. |

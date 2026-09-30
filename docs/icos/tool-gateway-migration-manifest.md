# Tool Gateway — migration collision manifest

For the central integration lane. This lane does **not** renumber or edit other lanes'
migrations or `_journal.json`; this file states what the integrator must know to do it.

Snapshot taken 2026-09-30 (read-only scan of every local branch and worktree).

## TOOL_GATEWAY_MIGRATION

- File: `drizzle/0049_tool_gateway.sql`, journal entry `idx 46`, tag `0049_tool_gateway`,
  written against a journal ending at `0048_compute_routing_evidence`.
- Drizzle source of truth: `src/server/database/tool-gateway-schema.ts` (parity asserted by
  `src/server/tool-gateway/postgres-stores.integration.test.ts`).
- Creates (all `IF NOT EXISTS`, additive, no FK to any other lane's table):
  `tool_executions`, `tool_approval_requests` (tenant-composite FK → `tool_executions`),
  `tool_grants`, `tool_connector_health`.
- Rewrites exactly one shared object: `audit_entries.audit_event_type_check` (DROP + ADD in a
  guarded `DO` block).
- Branch-local only: never applied to a shared or live database, so it was edited in place during
  this lane. Once merged it is immutable (forward migrations only).

## AUDIT_CHECK_VALUES_ADDED

Six values, on top of the complete 0047 list (41 values):

```
tool.execution.recorded
tool.approval.requested
tool.approval.decided
tool.approval.consumed
tool.grant.changed
tool.request.denied
```

The same six are in `auditEventTypeSchema` (`src/core/contracts/audit.ts`) and in the
`audit_event_type_check` literal of `src/server/database/schema.ts`.

## KNOWN_0049_COLLISIONS

| Migration                                                   | Branch / worktree                                                      | Number clash | Touches `audit_event_type_check` | Table-name clash                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | ------------ | -------------------------------- | -------------------------------------------------------------------- |
| `0049_tool_gateway.sql`                                     | `feat/tool-gateway-connectors` (this lane)                             | —            | **yes** (+6 `tool.*`)            | —                                                                    |
| `0049_proactive_supervisor.sql`                             | `feat/proactive-supervisor` (committed)                                | **0049**     | no                               | none (`supervisor_*`)                                                |
| `0049_control_plane.sql`                                    | `integration/icos-central` worktree (uncommitted, journal in conflict) | **0049**     | **yes** (+4 `control.command.*`) | none (`control_*`, `runtime_control_flags`, `mission_control_holds`) |
| `0050_digital_workforce.sql`                                | `feat/digital-workforce`                                               | 0050         | no                               | none (`workforce_*`)                                                 |
| `0050_cognitive_runtime.sql` → `0051_cognitive_runtime.sql` | `feat/cognitive-runtime` (renumbering in progress in its worktree)     | 0050/0051    | no                               | none (`cognitive_*`, `memory_*`)                                     |

No other lane creates a `tool_*` table.

## REQUIRED_MERGE_SEMANTICS

1. **`audit_event_type_check` is a set union, never a replacement.** Both `0049_tool_gateway` and
   `0049_control_plane` DROP and re-ADD the whole CHECK. Whichever runs second silently removes the
   other's values, and every write of the removed events then fails with a constraint violation.
   That failure is invisible until the event is first written. The last migration to touch the
   CHECK after merge must list: the 41 values of 0047, plus the 4 `control.command.*` values, plus
   the 6 `tool.*` values. Prefer a single follow-up migration (e.g. `00NN_audit_event_union`) that
   re-adds the union, so no lane migration needs editing after it has been applied anywhere.
2. `schema.ts` (`audit_event_type_check` literal) and `auditEventTypeSchema` must carry the same
   union. Today `schema.ts` omits `task.execution.dispatched` and `task.execution.started`, which
   is a pre-existing drift and not caused by this lane.
3. Everything else in `0049_tool_gateway` is order-independent. It references only its own
   tables, so it may be renumbered to any slot after `0048`.
4. Rollback never deletes audit rows. See the migration header.

## JOURNAL_RESEQUENCING_REQUIRED

**Yes.** Three lanes claim `0049` (tool gateway, proactive supervisor, control plane) and two claim
`0050`. The integrator must assign final numbers, rewrite `drizzle/meta/_journal.json` with
contiguous `idx` and strictly increasing `when` (asserted by `migration-journal.test.ts`), rename
the SQL files to match their tags, and then run the fresh-database test
(`migrations-fresh-database.integration.test.ts`) together with this lane's parity test.

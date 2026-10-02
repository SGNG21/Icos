-- 0056_spend_reservations
--
-- TOKEN RESERVATIONS FOR ONE GOAL BUDGET (autonomy blocker P0-D).
--
-- WHY THIS EXISTS
-- `spend_ledger` (0055) is append-only evidence of what WAS spent, and `checkBudget()` is a
-- PRE-FLIGHT read of it. That bounds nothing when several workers run at once: W callers read
-- the same "already spent" total, all pass, and the goal ends at `cap + the consumption of
-- those W calls`. The bound therefore GROWS with worker count (measured: 2 workers -> 10
-- tokens over, 16 -> 150). Four parallel workers each believed they owned the whole remaining
-- budget. This table adds the missing term: tokens already COMMITTED by calls in flight.
--
-- The previous lot rejected reservations on the grounds that a call's consumption is unknown
-- before the provider answers, so there was "no honest amount to reserve". That is true of an
-- ESTIMATE and false of a LIMIT: the caller declares a maximum it accepts to be charged for,
-- that maximum is what gets reserved, and settlement then replaces it with the ACTUAL usage
-- read from the provider's response (`core/budget/usage.ts`). Nothing is invented: a goal can
-- only ever authorise `cap` tokens of in-flight work, and over-reserving costs availability
-- (a DENY), never silent overspend.
--
-- NOT A SECOND LEDGER, NOT A SECOND ACCUMULATOR
-- This table holds ONLY live commitments, never a running total of spend. Actual spend stays
-- in `spend_ledger` and is still obtained by READING those rows back and folding them through
-- `accumulate` — the single accumulation authority. A reservation row is deleted-by-state once
-- settled and never summed again, so there is exactly one answer to "what did this goal spend".
--
-- ATOMICITY (the whole point)
-- `reserve()` runs ONE transaction that first takes `pg_advisory_xact_lock(hashtext(
-- 'icos.budget:<tenant>|<attribution_key>'))`, the same shape as `postgres-workforce-store.ts`
-- and `cognitive/memory-store.ts`. Without the lock, two concurrent transactions at READ
-- COMMITTED each sum the OPEN rows without seeing the other's uncommitted insert — classic
-- write skew — and both would be granted. A CHECK or a UNIQUE constraint cannot express "the
-- SUM of a set of rows must not exceed a ceiling", so the serialisation is the constraint.
-- It is per attribution key, so two different goals never wait on each other.
-- This is deliberately NOT in application memory: a per-process cache would give every process
-- its own window and bound nothing at all, forever.
--
-- EXPIRY IS A PREDICATE, NOT A SWEEPER
-- A worker that crashes between reserve and settle must not hold its goal's budget hostage.
-- Every row carries `lease_until`, and the only read that matters sums rows that are
-- `state = 'OPEN' AND lease_until > now()`. An abandoned reservation therefore stops counting
-- the moment its lease lapses, with no background job to deploy, schedule or debug, and no
-- window during which a crashed process is believed to still be spending. `owner_token` is the
-- fencing token: only the holder can settle its own reservation (same shape as
-- `recovery_units` / 0039). All time comparisons use PostgreSQL `now()`, so no process clock
-- drift can extend a lease.
--
-- MUTABLE BY DESIGN (unlike spend_ledger)
-- A reservation has a LIFECYCLE (OPEN -> SETTLED | EXPIRED), so this table is NOT append-only
-- and carries no append-only trigger. That is the difference between a lease and evidence: the
-- evidence of what was spent is the `spend_ledger` row written at settlement, which stays
-- immutable. A reservation row is never rewritten after it closes (`closed_at` is set once and
-- the state can only leave 'OPEN'), so settlement history cannot be laundered either.
--
-- TENANT
-- TENANT KEY: `tenant_id`, NOT NULL, non-empty, FIRST column of the only read index, and a
-- mandatory predicate of every query in `postgres-spend-reservations.ts` (which, like the
-- ledger, refuses to be constructed without a tenant id). It is also part of the advisory lock
-- key, so two tenants never serialise against each other.
-- RLS STRATEGY: RLS is NOT enabled — identical to `spend_ledger` (0055), `recovery_units`,
-- `workforce_*` and 0053. ICOS is single-tenant today; isolation is enforced in the service
-- layer and moves to RLS with the TenantContext of COMPLIANCE-1. A lone RLS policy on this one
-- table would read as protection that exists nowhere else in the database. Access is only
-- through the reservation store; no direct agent SQL.
--
-- DATA SAFETY (forward)
-- Additive only: ONE new table and ONE index. No existing table, column, constraint or row is
-- read, rewritten or dropped, so the forward migration cannot fail on existing data and is
-- safe on a NON-EMPTY database. Every statement is guarded (`IF NOT EXISTS`), so re-running is
-- a no-op.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS spend_reservations;
-- Nothing else references it and it references nothing (`goal_id` is plain text, deliberately
-- NOT a foreign key, so a reservation survives the deletion of its goal, like a ledger row).
-- Rolling back loses only IN-FLIGHT commitments, never spend history: `spend_ledger` keeps
-- every settled observation. The cost of the rollback is exactly the defect this migration
-- closes — concurrent workers stop being bounded as a group and the ceiling goes back to
-- growing with worker count. There is no data migration to undo.
--
-- NUMBERING
-- 0056 is the first free prefix on this branch (journal tail: idx 52, `0055_spend_ledger`).
-- Parallel lanes in this repository have silently collided on migration numbers before
-- (differing filenames merge with no git conflict), so THIS NUMBER MUST BE RE-CHECKED AT
-- INTEGRATION and renumbered, together with its `drizzle/meta/_journal.json` entry, if another
-- lane also claimed 0056.

CREATE TABLE IF NOT EXISTS spend_reservations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) > 0),
  -- `attributionKey()` of core/budget/contracts: the GOAL ALONE when a goal is imputed, so
  -- every task, worker, reviewer, retry, replan and further mission of one goal reserves from
  -- the SAME budget (P0-B). Spawning more workers cannot create more budget.
  attribution_key text NOT NULL CHECK (length(attribution_key) > 0),
  -- The goal as reported, for reporting only. Plain text on purpose: no FK.
  goal_id text,
  -- The ceiling this reservation commits, in TOKENS. Tokens, not money: a token budget must
  -- stay enforceable with no price table at all (the price table is empty today).
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens > 0),
  -- Fencing token: only its holder may settle this reservation.
  owner_token text NOT NULL CHECK (length(owner_token) > 0),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'SETTLED', 'EXPIRED')),
  -- Past this instant an OPEN reservation stops being counted. PostgreSQL `now()`, always.
  lease_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  -- A row is closed if and only if it left 'OPEN': no half-settled reservation is representable.
  CONSTRAINT spend_reservations_closed_shape CHECK ((state = 'OPEN') = (closed_at IS NULL))
);--> statement-breakpoint

-- The only read: the LIVE commitments of one imputation inside one tenant.
CREATE INDEX IF NOT EXISTS spend_reservations_live_idx
  ON spend_reservations (tenant_id, attribution_key, state, lease_until);

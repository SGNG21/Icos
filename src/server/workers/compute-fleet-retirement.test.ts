import { describe, expect, it } from "vitest";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import {
  FLEET_RETIREMENT_METADATA_KEY,
  WorkerRegistrationService,
} from "@/server/services/worker-registry/worker-registration-service";
import {
  applyComputeBootstrap,
  DEFAULT_COMPUTE_CAPABILITIES,
  isFleetOwned,
  planComputeBootstrap,
} from "@/server/workers/compute-bootstrap";
import { candidateWorkerId } from "@/server/workers/compute-fleet";

/*
 * GOVERNED RETIREMENT OF FLEET ORPHANS.
 *
 * A model the provider stopped listing used to stay `active` for ever: "reported, never
 * written". The reconciler now retires it — but only a row it provably created, only
 * while it is active, only when its own evidence says it does not work, never as a mass
 * withdrawal, always through the canonical service and always with an audit entry. And
 * a row it retired comes back when the model is listed again; an operator-disabled row
 * never does.
 */

const SERVED = [
  "claude/claude-sonnet-5",
  "claude/claude-opus-5",
  "codex/gpt-5.6-sol",
  "nvidia/nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
];
const GONE_MODEL = "codex/gpt-5.6-sol";
const GONE = candidateWorkerId(GONE_MODEL);
const WITHOUT_GONE = SERVED.filter((m) => m !== GONE_MODEL);

const OPTIONS = { runtime: "binary" as const, capabilities: [...DEFAULT_COMPUTE_CAPABILITIES] };

function harness() {
  const store = new InMemoryWorkerRegistryStore();
  const log = new InMemoryAuditLog();
  const audit = new InMemoryAuditRepository(log);
  const registration = new WorkerRegistrationService(store);
  const plan = async (listed: readonly string[] = SERVED) =>
    planComputeBootstrap({
      source: "https://gateway.invalid",
      listed,
      existing: await store.list(),
      options: OPTIONS,
    });
  const apply = async (listed: readonly string[] = SERVED) =>
    applyComputeBootstrap(registration, await plan(listed), { audit });
  const fail = (id: string) =>
    registration.probe(id, {
      health: "unhealthy",
      availability: "unavailable",
      outcome: "failed",
      errorClass: "UNAVAILABLE",
    });
  return { store, audit, registration, plan, apply, fail };
}

describe("governed retirement of compute fleet orphans", () => {
  it("ORPHAN_RETIRED: a failing, no-longer-listed fleet worker is deactivated with an audit entry", async () => {
    const { store, audit, apply, fail } = harness();
    await apply();
    await fail(GONE);

    const result = await apply(WITHOUT_GONE);

    expect(result.retired).toEqual([GONE]);
    const row = (await store.get(GONE))!;
    expect(row.status).toBe("inactive");
    expect(row.health).toBe("unknown");
    expect(row.availability).toBe("unknown");
    expect(row.metadata[FLEET_RETIREMENT_METADATA_KEY]).toBe("ORPHAN_NOT_LISTED");
    /* The declaration and the probe date stay as audit; nothing is deleted. */
    expect(row.metadata.model).toBe(GONE_MODEL);
    expect(row.lastProbeAt).not.toBeNull();

    const entries = await audit.query({ eventType: "worker.fleet.retired" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toEqual({ kind: "system", id: "compute-fleet-reconciler" });
    expect(entries[0]!.details).toMatchObject({
      workerId: GONE,
      reason: "ORPHAN_NOT_LISTED",
      source: "https://gateway.invalid",
      model: GONE_MODEL,
      lastProbeOutcome: "failed",
      lastProbeErrorClass: "UNAVAILABLE",
    });
  });

  it("RETIREMENT_IDEMPOTENT: any number of later boots write nothing and audit nothing more", async () => {
    const { store, audit, apply, fail } = harness();
    await apply();
    await fail(GONE);
    await apply(WITHOUT_GONE);
    const after = await store.list();

    for (let boot = 0; boot < 3; boot += 1) {
      const result = await apply(WITHOUT_GONE);
      expect(result.retired).toEqual([]);
      expect(result.reinstated).toEqual([]);
    }

    expect(await store.list()).toEqual(after);
    expect(await audit.query({ eventType: "worker.fleet.retired" })).toHaveLength(1);
  });

  it("ORPHAN_REINSTATED: a retired worker listed again comes back unproven, audited, once", async () => {
    const { store, audit, plan, apply, fail } = harness();
    await apply();
    await fail(GONE);
    await apply(WITHOUT_GONE);

    expect((await plan()).reinstate.map((p) => p.id)).toEqual([GONE]);
    const result = await apply();

    expect(result.reinstated).toEqual([GONE]);
    const row = (await store.get(GONE))!;
    expect(row.status).toBe("active");
    /* Re-activation is not a health claim: exactly what ENABLE_WORKER does. */
    expect(row.health).toBe("unknown");
    expect(row.lastProbeOutcome).toBe("never");
    expect(row.lastProbeAt).toBeNull();
    expect(row.metadata[FLEET_RETIREMENT_METADATA_KEY]).toBeUndefined();
    expect(await audit.query({ eventType: "worker.fleet.reinstated" })).toHaveLength(1);

    /* And the next boot sees an ordinary, unchanged worker. */
    const next = await plan();
    expect(next.unchanged.map((p) => p.id)).toContain(GONE);
    expect(next.reinstate).toEqual([]);
    await apply();
    expect(await audit.query({ eventType: "worker.fleet.reinstated" })).toHaveLength(1);
  });

  it("an OPERATOR-disabled worker is never reinstated, listed or not", async () => {
    const { store, audit, registration, plan, apply } = harness();
    await apply();
    await registration.deactivate(GONE); // the DISABLE_WORKER effect
    const disabled = await store.get(GONE);

    await apply(WITHOUT_GONE);
    const p = await plan();
    expect(p.reinstate).toEqual([]);
    expect(p.disabled.map((d) => d.id)).toContain(GONE);
    await apply();

    expect(await store.get(GONE)).toEqual(disabled);
    expect(await audit.list()).toEqual([]);
  });

  it("MANUAL_WORKER_NEVER_RETIRED: a hand-registered worker is untouched, even one named compute:*", async () => {
    const { store, registration, apply, fail } = harness();
    await apply();
    const manual = "99999999-9999-4999-8999-999999999999";
    await registration.register({
      id: manual,
      workerKind: "agent",
      displayName: "compute:codex/gpt-5.6-sol-handmade",
      metadata: { model: "codex/gpt-5.6-sol-handmade", provider: "codex" },
      runtime: "binary",
      runtimeSupport: "SUPPORTED_RUNTIME",
    });
    await fail(manual);
    const before = await store.get(manual);

    const p = (await apply()).retired;

    expect(isFleetOwned(before!)).toBe(false);
    expect(p).toEqual([]);
    expect(await store.get(manual)).toEqual(before);
  });

  it("MASS_WITHDRAWAL_WITHHELD: a listing that would retire most of the fleet retires nothing", async () => {
    const { store, apply, fail } = harness();
    await apply();
    for (const w of await store.list()) await fail(w.id);
    const before = await store.list();

    /* One model listed out of five: far likelier a bad listing than a withdrawn catalog. */
    const result = await apply(["claude/claude-sonnet-5"]);

    expect(result.retirement).toBe("WITHHELD_MASS_WITHDRAWAL");
    expect(result.retired).toEqual([]);
    expect(await store.list()).toEqual(before);
  });

  it("an EMPTY listing retires nothing (0064: an empty discovery is not a withdrawal)", async () => {
    const { store, apply, fail } = harness();
    await apply();
    for (const w of await store.list()) await fail(w.id);
    const before = await store.list();

    const result = await apply([]);

    expect(result.retirement).toBe("WITHHELD_EMPTY_DISCOVERY");
    expect(await store.list()).toEqual(before);
  });

  it("NO_AUDIT_NO_STATUS_WRITE: without an audit sink the retirement is skipped, not done silently", async () => {
    const { store, registration, plan, apply, fail } = harness();
    await apply();
    await fail(GONE);
    const before = await store.get(GONE);

    const result = await applyComputeBootstrap(registration, await plan(WITHOUT_GONE));

    expect(result.retired).toEqual([]);
    expect(result.skippedUnaudited).toEqual([GONE]);
    expect(await store.get(GONE)).toEqual(before);
  });
});

describe("review L2 — retirement needs failing evidence and never empties the fleet", () => {
  it("a NEVER-PROBED orphan is reported, not retired", async () => {
    const { plan, apply } = harness();
    await apply();
    const p = await plan(WITHOUT_GONE);
    expect(p.orphan.map((o) => o.id)).toContain(GONE);
    expect(p.retire).toEqual([]);
  });

  it("the LAST active fleet worker is never retired, even alone and failing", async () => {
    const { plan, apply, fail } = harness();
    await apply([GONE_MODEL]);
    await fail(GONE);
    const p = await plan(["claude/claude-sonnet-5"]);
    /* The new model is registered; the only ACTIVE fleet row is still the failing one. */
    expect(p.retire).toEqual([]);
    expect(p.retirement).toBe("WITHHELD_MASS_WITHDRAWAL");
  });
});

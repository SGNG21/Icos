import { describe, expect, it, vi } from "vitest";

import { buildWorkerViews } from "@/features/cockpit/snapshot";
import { missing, real } from "@/features/cockpit/truth";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import {
  applyComputeBootstrap,
  DEFAULT_COMPUTE_CAPABILITIES,
  discoverComputeFleet,
  planComputeBootstrap,
} from "@/server/workers/compute-bootstrap";
import { candidateWorkerId } from "@/server/workers/compute-fleet";

/*
 * LIVE WORKER FLEET BOOTSTRAP.
 *
 * The lane's question is not "can a worker be registered" (M5 proved that) but
 * "can the DECLARED fleet reach a registry reproducibly, on every boot, without
 * destroying the health evidence that makes it routable".
 *
 * Nothing here writes to a live database and nothing copies a row between
 * databases: the registry under test is in-memory, and the provider is a stub.
 */

const SERVED = [
  "claude/claude-sonnet-5",
  "claude/claude-opus-5",
  "codex/gpt-5.6-sol",
  "nvidia/nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  /* Must be ignored: a meta-route is not ONE model, and these are effort variants. */
  "auto/best",
  "claude/claude-sonnet-5-high",
];

const OPTIONS = {
  runtime: "binary" as const,
  capabilities: [...DEFAULT_COMPUTE_CAPABILITIES],
};

function harness() {
  const store = new InMemoryWorkerRegistryStore();
  return {
    store,
    registration: new WorkerRegistrationService(store),
    plan: async (listed: readonly string[] = SERVED) =>
      planComputeBootstrap({
        source: "https://gateway.invalid",
        listed,
        existing: await store.list(),
        options: OPTIONS,
      }),
  };
}

describe("live worker fleet bootstrap", () => {
  it("DRY_RUN_NO_WRITE: planning reports what would change and writes nothing", async () => {
    const { store, plan } = harness();

    const planned = await plan();

    expect(planned.register.length).toBeGreaterThan(1);
    expect(planned.update).toEqual([]);
    expect(planned.unchanged).toEqual([]);
    expect(planned.pools.length).toBeGreaterThan(1);
    /* Provider dependencies are visible, and the credential is nowhere in the report. */
    expect(planned.pools.map((p) => p.pool)).toEqual(
      expect.arrayContaining(["provider:claude", "provider:nvidia"]),
    );
    expect(JSON.stringify(planned)).not.toMatch(/secret|api[_-]?key|bearer/i);
    /* THE POINT: the registry is untouched. */
    expect(await store.list()).toEqual([]);
  });

  it("the plan declares only what the provider serves — no meta-route, no effort variant", async () => {
    const { plan } = harness();

    const models = (await plan()).register.map((p) => p.model);

    expect(models).not.toContain("auto/best");
    expect(models).not.toContain("claude/claude-sonnet-5-high");
    expect(models).toContain("claude/claude-sonnet-5");
  });

  it("WORKER_BOOTSTRAP_IDEMPOTENT: applying the same plan twice registers one fleet", async () => {
    const { store, registration, plan } = harness();

    const first = await applyComputeBootstrap(registration, await plan());
    const afterFirst = await store.list();

    const second = await applyComputeBootstrap(registration, await plan());

    expect(first.registered.length).toBe(afterFirst.length);
    expect(second.registered).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.length).toBe(afterFirst.length);
    expect(await store.list()).toEqual(afterFirst);
  });

  it("NO_DUPLICATE_WORKERS: a model keeps one deterministic id across runs", async () => {
    const { store, registration, plan } = harness();

    await applyComputeBootstrap(registration, await plan());
    await applyComputeBootstrap(registration, await plan());

    const ids = (await store.list()).map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(candidateWorkerId("claude/claude-sonnet-5"));
  });

  it("WORKER_BOOTSTRAP_RESTART_SAFE: a re-boot preserves probe evidence instead of resetting it", async () => {
    const { store, registration, plan } = harness();
    await applyComputeBootstrap(registration, await plan());
    const probed = candidateWorkerId("claude/claude-sonnet-5");
    await registration.probe(probed, { health: "healthy", availability: "available" });
    const beforeRestart = await store.get(probed);

    /* The same process boots again and bootstraps unconditionally, as it must. */
    const result = await applyComputeBootstrap(registration, await plan());

    expect(result.registered).toEqual([]);
    expect(result.unchanged).toContain(probed);
    const afterRestart = await store.get(probed);
    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart?.health).toBe("healthy");
    expect(afterRestart?.lastProbeOutcome).toBe("ok");
    expect(afterRestart?.lastProbeAt).toBe(beforeRestart?.lastProbeAt);
  });

  it("a CHANGED declaration still resets evidence: new declaration, new proof required", async () => {
    const { store, registration, plan } = harness();
    await applyComputeBootstrap(registration, await plan());
    const id = candidateWorkerId("claude/claude-sonnet-5");
    await registration.probe(id, { health: "healthy", availability: "available" });

    const changed = planComputeBootstrap({
      source: "https://gateway.invalid",
      listed: SERVED,
      existing: await store.list(),
      options: { ...OPTIONS, capabilities: ["review"] },
    });
    expect(changed.update.map((p) => p.id)).toContain(id);
    expect(changed.unchanged).toEqual([]);
    await applyComputeBootstrap(registration, changed);

    const after = await store.get(id);
    expect(after?.capabilities).toEqual(["review"]);
    expect(after?.health).toBe("unknown");
    expect(after?.lastProbeOutcome).toBe("never");
    expect(after?.lastProbeAt).toBeNull();
  });

  it("HEALTH_UNKNOWN_NOT_HEALTHY: a bootstrapped fleet is registered, not available, not routable", async () => {
    const { store, registration, plan } = harness();

    await applyComputeBootstrap(registration, await plan());

    const workers = await store.list();
    expect(workers.length).toBeGreaterThan(1);
    for (const w of workers) {
      expect(w.status).toBe("active");
      expect(w.health).toBe("unknown");
      expect(w.availability).toBe("unknown");
      expect(w.lastProbeOutcome).toBe("never");
      expect(w.lastProbeAt).toBeNull();
    }
    const router = new CapabilityRouter(store);
    expect((await router.route({ requiredCapabilities: ["code_editing"] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );
  });

  it("COMPUTE_ROUTING_AFTER_REGISTRATION: a probed candidate becomes routable through the canonical matcher", async () => {
    const { store, registration, plan } = harness();
    await applyComputeBootstrap(registration, await plan());
    const id = candidateWorkerId("claude/claude-sonnet-5");

    await registration.probe(id, { health: "healthy", availability: "available" });

    const routed = await new CapabilityRouter(store).route({
      requiredCapabilities: ["code_editing"],
    });
    expect(routed.decision).toBe("ROUTED");
    expect(routed.worker?.id).toBe(id);
  });

  it("CAPACITY_RECONCILIATION: capacity and pools change in place, without a second row", async () => {
    const { store, registration, plan } = harness();
    await applyComputeBootstrap(registration, await plan());
    const before = await store.list();
    const id = candidateWorkerId("claude/claude-sonnet-5");

    const rescaled = planComputeBootstrap({
      source: "https://gateway.invalid",
      listed: SERVED,
      existing: before,
      options: { ...OPTIONS, maxConcurrency: 4 },
    });
    await applyComputeBootstrap(registration, rescaled);

    const after = await store.list();
    expect(after.length).toBe(before.length);
    expect((await store.get(id))?.maxConcurrency).toBe(4);
    /*
     * Several models behind ONE provider share ONE pool rather than multiplying it:
     * two nvidia families, two workers, one `provider:nvidia` ceiling to count against.
     */
    const nvidia = rescaled.pools.find((p) => p.pool === "provider:nvidia");
    expect(nvidia?.workers).toBe(2);
    expect(nvidia?.declaredConcurrency).toBe(8);
    expect(after.filter((w) => w.capacityPool === "provider:nvidia").length).toBe(2);
  });

  it("reports a withdrawn model but never writes its status: that decision is governed", async () => {
    const { store, registration, plan } = harness();
    await applyComputeBootstrap(registration, await plan());
    const gone = candidateWorkerId("codex/gpt-5.6-sol");
    await registration.probe(gone, { health: "healthy", availability: "available" });
    const before = await store.list();

    const next = await plan(SERVED.filter((m) => m !== "codex/gpt-5.6-sol"));

    expect(next.orphan.map((o) => o.id)).toEqual([gone]);
    await applyComputeBootstrap(registration, next);
    /*
     * Still active, still carrying its evidence: taking a worker out of rotation is
     * DISABLE_WORKER's decision, and the prober stops routing to a dead model on
     * evidence anyway. The reconciler reports; it does not legislate.
     */
    expect(await store.list()).toEqual(before);
    expect((await store.get(gone))?.status).toBe("active");
  });

  it("NEVER re-enables a worker an operator disabled, on any number of boots", async () => {
    const { store, registration, plan } = harness();
    await applyComputeBootstrap(registration, await plan());
    const id = candidateWorkerId("claude/claude-sonnet-5");
    /* Exactly what the DISABLE_WORKER control command does. */
    await registration.deactivate(id);
    const disabled = await store.get(id);

    for (let boot = 0; boot < 3; boot += 1) {
      const p = await plan();
      expect(p.disabled.map((d) => d.id)).toContain(id);
      expect(p.register.map((x) => x.id)).not.toContain(id);
      expect(p.update.map((x) => x.id)).not.toContain(id);
      const result = await applyComputeBootstrap(registration, p);
      expect(result.skippedDisabled).toContain(id);
    }

    expect(await store.get(id)).toEqual(disabled);
    expect((await store.get(id))?.status).toBe("inactive");
  });

  it("the plan reports already-registered candidates that cannot take work, and never fixes them", async () => {
    const { store, registration, plan } = harness();
    await applyComputeBootstrap(registration, await plan());
    const id = candidateWorkerId("claude/claude-opus-5");
    await registration.probe(id, {
      health: "unhealthy",
      availability: "unavailable",
      outcome: "failed",
    });

    const next = await plan();

    expect(next.unavailable.map((u) => u.id)).toContain(id);
    expect(next.update).toEqual([]);
    await applyComputeBootstrap(registration, next);
    expect((await store.get(id))?.health).toBe("unhealthy");
  });

  it("PROVIDER_UNAVAILABLE_FAILS_SAFE: an EMPTY 200 listing never deactivates the fleet", async () => {
    const { store, registration, plan } = harness();
    await applyComputeBootstrap(registration, await plan());
    const before = await store.list();

    /* The outage that arrives as a success: a 200 whose listing yields no candidate. */
    const emptyListing = await plan([]);
    const unrecognised = await plan(["some-gateway/unknown-model-7", "auto/best"]);

    for (const outage of [emptyListing, unrecognised]) {
      expect(outage.discovery).toBe("EMPTY");
      expect(outage.orphan).toEqual([]);
      await applyComputeBootstrap(registration, outage);
    }
    expect(await store.list()).toEqual(before);
    for (const w of await store.list()) expect(w.status).toBe("active");
  });

  it("PROVIDER_UNAVAILABLE_FAILS_SAFE: an unreachable provider yields no plan and no write", async () => {
    const { store, registration, plan } = harness();
    await applyComputeBootstrap(registration, await plan());
    const before = await store.list();

    await expect(
      discoverComputeFleet({
        baseUrl: "https://gateway.invalid",
        credential: "unused",
        options: OPTIONS,
        workers: store,
        fetch: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);

    await expect(
      discoverComputeFleet({
        baseUrl: "https://gateway.invalid",
        credential: "unused",
        options: OPTIONS,
        workers: store,
        fetch: vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/COMPUTE_DISCOVERY_HTTP_503/);

    /* No plan means no apply: the proven fleet is NOT deactivated as orphaned. */
    expect(await store.list()).toEqual(before);
  });

  it("COCKPIT_WORKER_PROJECTION: the cockpit shows the bootstrapped fleet as registered and not routable", async () => {
    const { store, registration, plan } = harness();
    await applyComputeBootstrap(registration, await plan());
    const probed = candidateWorkerId("claude/claude-sonnet-5");
    await registration.probe(probed, { health: "healthy", availability: "available" });

    const views = buildWorkerViews(
      await store.list(),
      real<string[]>([]),
      missing("unknown", "not read"),
      new Date(),
    );

    expect(views.length).toBe((await store.list()).length);
    expect(views.filter((v) => v.routable).map((v) => v.id)).toEqual([probed]);
    for (const view of views) {
      expect(view.name.startsWith("compute:")).toBe(true);
      expect(view.pool?.name).toMatch(/^provider:/);
    }
    const unprobed = views.find((v) => v.id !== probed)!;
    expect(unprobed.probe.outcome).toBe("never");
    expect(unprobed.probe.at).toBeNull();
    expect(unprobed.routable).toBe(false);
  });

  it("TENANT_ENVIRONMENT_ISOLATION: one bootstrap reaches exactly one registry", async () => {
    const live = harness();
    const other = harness();

    await applyComputeBootstrap(live.registration, await live.plan());

    /* Same declaration, different registry: no shared state, no cross-write. */
    expect((await live.store.list()).length).toBeGreaterThan(1);
    expect(await other.store.list()).toEqual([]);

    await applyComputeBootstrap(other.registration, await other.plan(["claude/claude-sonnet-5"]));
    expect((await other.store.list()).length).toBe(1);
    expect((await live.store.list()).length).toBeGreaterThan(1);
  });

  it("NO_TEST_DB_TO_LIVE_COPY: the plan is derived from the provider, never from another registry", async () => {
    const seeded = harness();
    await applyComputeBootstrap(seeded.registration, await seeded.plan());
    for (const w of await seeded.store.list()) {
      await seeded.registration.probe(w.id, { health: "healthy", availability: "available" });
    }
    const target = harness();

    /*
     * The ONLY inputs a plan accepts are the provider's listing and the TARGET's own
     * registry. There is no parameter through which a populated registry — a *_test
     * database, a proof database — could seed another, and a plan built from an empty
     * provider listing declares nothing rather than inheriting anything.
     */
    const empty = await target.plan([]);
    expect(empty.discovery).toBe("EMPTY");
    expect(empty.register).toEqual([]);
    expect(empty.update).toEqual([]);
    expect(empty.unchanged).toEqual([]);

    await applyComputeBootstrap(target.registration, empty);
    expect(await target.store.list()).toEqual([]);

    /* And health never travels: the target's own candidates arrive unprobed. */
    await applyComputeBootstrap(target.registration, await target.plan());
    for (const w of await target.store.list()) {
      expect(w.health).toBe("unknown");
      expect(w.lastProbeOutcome).toBe("never");
    }
  });
});

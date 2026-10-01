import { describe, expect, it } from "vitest";

import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { CapabilityRouter } from "@/server/routing/capability-router";

/*
 * M5 — worker registration and probing.
 *
 * The invariant under test is that REGISTRATION IS NOT A HEALTH CLAIM: a
 * worker that has announced itself but has not been probed routes nothing.
 */

const WORKER_A = "11111111-1111-4111-8111-111111111111";
const WORKER_B = "22222222-2222-4222-8222-222222222222";

function harness() {
  const store = new InMemoryWorkerRegistryStore();
  return {
    store,
    service: new WorkerRegistrationService(store),
    router: new CapabilityRouter(store),
  };
}

const declaration = (id: string, capabilities: string[]) => ({
  id,
  workerKind: "agent",
  displayName: "Worker",
  capabilities,
  runtime: "node" as const,
  runtimeSupport: "SUPPORTED_RUNTIME" as const,
});

describe("worker registration", () => {
  it("REGISTRATION_IS_NOT_A_HEALTH_CLAIM: a registered but unprobed worker routes nothing", async () => {
    const { service, router } = harness();

    const registered = await service.register(declaration(WORKER_A, ["code-generation"]));
    expect(registered.health).toBe("unknown");
    expect(registered.availability).toBe("unknown");
    // M5.2: registration also produces no EVIDENCE, not merely no health value.
    expect(registered.lastProbeAt).toBeNull();
    expect(registered.lastProbeOutcome).toBe("never");

    const routed = await router.route({ requiredCapabilities: ["code-generation"] });
    expect(routed.decision).toBe("NO_ELIGIBLE_WORKER");
    expect(routed.candidates[0].reasons).toEqual([
      "HEALTH_NOT_HEALTHY",
      "NOT_AVAILABLE",
      "HEALTH_EVIDENCE_MISSING",
    ]);
  });

  it("a caller cannot smuggle a health claim through registration", async () => {
    const { service, store } = harness();

    await service.register({
      ...declaration(WORKER_A, ["code-generation"]),
      // @ts-expect-error — not part of WorkerRegistrationInput, and must be ignored.
      health: "healthy",
      availability: "available",
    });

    const stored = await store.get(WORKER_A);
    expect(stored?.health).toBe("unknown");
    expect(stored?.availability).toBe("unknown");
  });

  it("runtimeSupport defaults to UNKNOWN: declaring a runtime is not being able to run it", async () => {
    const { service, store } = harness();

    await service.register({ id: WORKER_A, workerKind: "agent", displayName: "W", runtime: "node" });

    expect((await store.get(WORKER_A))?.runtimeSupport).toBe("UNKNOWN");
  });

  it("a probe makes the worker routable", async () => {
    const { service, router } = harness();
    await service.register(declaration(WORKER_A, ["code-generation"]));

    await service.probe(WORKER_A, { health: "healthy", availability: "available" });

    const routed = await router.route({ requiredCapabilities: ["code-generation"] });
    expect(routed.decision).toBe("ROUTED");
    expect(routed.worker?.id).toBe(WORKER_A);
  });

  it("a probe reporting degraded or unavailable takes the worker back out", async () => {
    const { service, router } = harness();
    await service.register(declaration(WORKER_A, ["code-generation"]));
    await service.probe(WORKER_A, { health: "healthy", availability: "available" });

    await service.probe(WORKER_A, { health: "degraded", availability: "available" });
    expect((await router.route({ requiredCapabilities: ["code-generation"] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );

    await service.probe(WORKER_A, { health: "healthy", availability: "unavailable" });
    expect((await router.route({ requiredCapabilities: ["code-generation"] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );
  });

  it("RE_REGISTRATION_RESETS_PROBE: a changed declaration invalidates old evidence", async () => {
    const { service, store, router } = harness();
    await service.register(declaration(WORKER_A, ["code-generation"]));
    await service.probe(WORKER_A, { health: "healthy", availability: "available" });

    await service.register(declaration(WORKER_A, ["code-generation", "testing"]));

    const stored = await store.get(WORKER_A);
    expect(stored?.capabilities).toEqual(["code-generation", "testing"]);
    expect(stored?.health).toBe("unknown");
    expect((await router.route({ requiredCapabilities: ["code-generation"] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );
  });

  it("RE_REGISTRATION_IS_A_NO_OP: an UNCHANGED declaration keeps the probe evidence", async () => {
    const { service, store, router } = harness();
    await service.register(declaration(WORKER_A, ["code-generation"]));
    await service.probe(WORKER_A, { health: "healthy", availability: "available" });
    const before = await store.get(WORKER_A);

    /* The same declaration again — what a startup bootstrap does on every boot. */
    const returned = await service.register(declaration(WORKER_A, ["code-generation"]));

    expect(returned).toEqual(before);
    expect(await store.get(WORKER_A)).toEqual(before);
    expect((await router.route({ requiredCapabilities: ["code-generation"] })).worker?.id).toBe(
      WORKER_A,
    );
  });

  it("METADATA_KEY_ORDER_IS_NOT_A_CHANGE: jsonb reorders keys; that must not reset evidence", async () => {
    const { service, store } = harness();
    const metadata = { model: "m", provider: "p", tierHint: "3" };
    await service.register({ ...declaration(WORKER_A, ["code-generation"]), metadata });
    await service.probe(WORKER_A, { health: "healthy", availability: "available" });
    const before = await store.get(WORKER_A);

    /*
     * Exactly what reading the row back from PostgreSQL produces: the same pairs, a
     * different key order. Treating that as a changed declaration would make every
     * restart wipe the fleet's health evidence against a real database while looking
     * correct here.
     */
    await service.register({
      ...declaration(WORKER_A, ["code-generation"]),
      metadata: { tierHint: "3", provider: "p", model: "m" },
    });

    expect(await store.get(WORKER_A)).toEqual(before);
    expect((await store.get(WORKER_A))?.health).toBe("healthy");
  });

  it("re-registering a DEACTIVATED worker is a change: it comes back active and unproven", async () => {
    const { service, store } = harness();
    await service.register(declaration(WORKER_A, ["code-generation"]));
    await service.probe(WORKER_A, { health: "healthy", availability: "available" });
    await service.deactivate(WORKER_A);

    await service.register(declaration(WORKER_A, ["code-generation"]));

    const stored = await store.get(WORKER_A);
    expect(stored?.status).toBe("active");
    expect(stored?.health).toBe("unknown");
    expect(stored?.lastProbeOutcome).toBe("never");
  });

  it("probing an unregistered worker returns null rather than inventing one", async () => {
    const { service, store } = harness();

    expect(await service.probe(WORKER_A, { health: "healthy", availability: "available" })).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("deactivate keeps the declaration and the last probe but stops routing", async () => {
    const { service, store, router } = harness();
    await service.register(declaration(WORKER_A, ["code-generation"]));
    await service.probe(WORKER_A, { health: "healthy", availability: "available" });

    await service.deactivate(WORKER_A);

    const stored = await store.get(WORKER_A);
    expect(stored?.status).toBe("inactive");
    expect(stored?.health).toBe("healthy");
    expect(stored?.capabilities).toEqual(["code-generation"]);
    expect((await router.route({ requiredCapabilities: ["code-generation"] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );
  });

  it("deregister removes the worker and reports whether anything was removed", async () => {
    const { service, router } = harness();
    await service.register(declaration(WORKER_A, ["code-generation"]));

    expect(await service.deregister(WORKER_A)).toBe(true);
    expect(await service.deregister(WORKER_A)).toBe(false);
    // Back to an empty registry: not a routing table at all.
    expect((await router.route({ requiredCapabilities: ["code-generation"] })).decision).toBe(
      "ROUTING_UNCONFIGURED",
    );
  });

  it("registration rejects a malformed worker rather than storing it", async () => {
    const { service, store } = harness();

    await expect(
      service.register({ id: "not-a-uuid", workerKind: "agent", displayName: "W" }),
    ).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it("a second registered worker does not disturb deterministic selection", async () => {
    const { service, router } = harness();
    // Registered in reverse id order on purpose.
    await service.register(declaration(WORKER_B, ["code-generation"]));
    await service.register(declaration(WORKER_A, ["code-generation"]));
    await service.probe(WORKER_A, { health: "healthy", availability: "available" });
    await service.probe(WORKER_B, { health: "healthy", availability: "available" });

    expect((await router.route({ requiredCapabilities: ["code-generation"] })).worker?.id).toBe(
      WORKER_A,
    );
  });
});

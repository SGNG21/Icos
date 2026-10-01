import { describe, expect, it, vi } from "vitest";

import type { Env } from "@/config/env";
import type { Container } from "@/server/container";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { bootstrapComputeFleetAtStartup } from "@/server/workers/startup-compute-bootstrap";

/*
 * The startup half of the bootstrap: WHEN a boot is allowed to write, and what a boot
 * does when the provider is not there. The reconciliation itself is proven in
 * compute-bootstrap.test.ts.
 */

const MODELS = { data: [{ id: "claude/claude-sonnet-5" }, { id: "codex/gpt-5.6-sol" }] };

function harness(fetchImpl?: unknown) {
  const store = new InMemoryWorkerRegistryStore();
  const container = {
    workerRegistryStore: store,
    workerRegistration: new WorkerRegistrationService(store),
  } as unknown as Container;
  const okFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => MODELS });
  return { store, container, fetch: (fetchImpl ?? okFetch) as typeof fetch };
}

const env = (over: Partial<Env> = {}): Env =>
  ({
    OMNIROUTE_BASE_URL: "https://gateway.invalid",
    OMNIROUTE_API_KEY: "unused-in-this-test",
    ICOS_COMPUTE_BOOTSTRAP: true,
    ...over,
  }) as Env;

/*
 * `discoverComputeFleet` resolves its own fetch from globalThis, which is what the
 * startup path does in production. Stubbing it here is the only way to keep this a unit.
 */
async function run(h: ReturnType<typeof harness>, e: Env) {
  const original = globalThis.fetch;
  globalThis.fetch = h.fetch;
  try {
    return await bootstrapComputeFleetAtStartup(h.container, e, () => {});
  } finally {
    globalThis.fetch = original;
  }
}

describe("startup compute bootstrap", () => {
  it("DRY_RUN_NO_WRITE by default: an unflagged deployment writes nothing at boot", async () => {
    const h = harness();

    const outcome = await run(h, env({ ICOS_COMPUTE_BOOTSTRAP: undefined }));

    expect(outcome).toEqual({ status: "DISABLED" });
    expect(await h.store.list()).toEqual([]);
  });

  it("registers the declared fleet when the deployment opts in, fail-closed", async () => {
    const h = harness();

    const outcome = await run(h, env());

    expect(outcome.status).toBe("APPLIED");
    const workers = await h.store.list();
    expect(workers.length).toBe(2);
    for (const w of workers) {
      expect(w.health).toBe("unknown");
      expect(w.lastProbeOutcome).toBe("never");
    }
  });

  it("WORKER_BOOTSTRAP_RESTART_SAFE: a second boot writes nothing and keeps evidence", async () => {
    const h = harness();
    await run(h, env());
    const probed = (await h.store.list())[0]!;
    await h.container.workerRegistration.probe(probed.id, {
      health: "healthy",
      availability: "available",
    });
    const before = await h.store.list();

    const outcome = await run(h, env());

    expect(outcome).toMatchObject({
      status: "APPLIED",
      result: { registered: [], updated: [], skippedDisabled: [] },
    });
    expect(await h.store.list()).toEqual(before);
  });

  it("PROVIDER_UNAVAILABLE_FAILS_SAFE: a provider outage leaves the registry alone and does not throw", async () => {
    const h = harness();
    await run(h, env());
    const before = await h.store.list();
    const down = {
      ...h,
      fetch: vi.fn().mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:443")) as typeof fetch,
    };

    const outcome = await run(down, env());

    expect(outcome.status).toBe("PROVIDER_UNAVAILABLE");
    expect(await h.store.list()).toEqual(before);
  });

  it("names the missing variable instead of booting a bootstrap that can never run", async () => {
    const h = harness();

    const outcome = await run(h, env({ OMNIROUTE_API_KEY: undefined }));

    expect(outcome).toEqual({ status: "UNCONFIGURED", missing: ["OMNIROUTE_API_KEY"] });
    expect(await h.store.list()).toEqual([]);
  });

  it("never logs the credential", async () => {
    const h = harness();
    const logged: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = h.fetch;
    try {
      await bootstrapComputeFleetAtStartup(
        h.container,
        env({ OMNIROUTE_API_KEY: "super-secret-credential" }),
        (o) => logged.push(o),
      );
    } finally {
      globalThis.fetch = original;
    }

    expect(JSON.stringify(logged)).not.toContain("super-secret-credential");
  });
});

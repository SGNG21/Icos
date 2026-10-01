import { describe, expect, it, vi } from "vitest";

import type { Env } from "@/config/env";
import type { Container } from "@/server/container";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import {
  bootstrapComputeFleetAtStartup,
  warnOnAttention,
} from "@/server/workers/startup-compute-bootstrap";

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
  const okFetch = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => MODELS,
      text: async () => JSON.stringify(MODELS),
    });
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
async function run(h: ReturnType<typeof harness>, e: Env, log: (o: unknown) => void = () => {}) {
  const original = globalThis.fetch;
  globalThis.fetch = h.fetch;
  try {
    return await bootstrapComputeFleetAtStartup(h.container, e, log);
  } finally {
    globalThis.fetch = original;
  }
}

describe("startup compute bootstrap", () => {
  it("DEFAULT_OFF: an unflagged deployment writes nothing at boot", async () => {
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

  it("NEVER_LOGS_THE_CREDENTIAL: the failure branch truncates and carries no secret", async () => {
    const CREDENTIAL = "super-secret-credential";
    const h = harness(
      vi.fn().mockRejectedValue(
        /* A gateway error that embeds BOTH the credential and a long body, which is what
         * `response.json()` on an HTML error page produces. The catch branch is the only
         * path that can carry provider text into a log, so it is the one under test. */
        new Error(
          `Unexpected token '<' — Authorization: Bearer ${CREDENTIAL}\n` + "x".repeat(5_000),
        ),
      ),
    );
    const logged: unknown[] = [];

    const outcome = await run(h, env({ OMNIROUTE_API_KEY: CREDENTIAL }), (o) => logged.push(o));

    expect(outcome.status).toBe("PROVIDER_UNAVAILABLE");
    /* It is truncated to one bounded line: a whole response body never reaches a log. */
    const error = (outcome as { error: string }).error;
    expect(error.length).toBeLessThanOrEqual(200);
    expect(error).not.toContain("\n");
    /* And nothing the bootstrap ITSELF builds contains the credential. */
    expect(JSON.stringify(logged)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(outcome)).not.toContain("x".repeat(500));
  });

  it("the PRODUCTION log sink stays silent on success and speaks on every attention outcome", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      /* Silent: results are evidence in the registry, never a stdout dump. */
      warnOnAttention({ status: "DISABLED" });
      warnOnAttention({
        status: "APPLIED",
        source: "https://gateway.invalid",
        result: { registered: [], updated: [], unchanged: [], skippedDisabled: [] },
      });
      expect(warn).not.toHaveBeenCalled();

      /*
       * Loud: a bootstrap that is ENABLED and did not register the fleet is invisible
       * otherwise — fail-closed and undiagnosable is the failure mode to avoid.
       */
      warnOnAttention({ status: "UNCONFIGURED", missing: ["OMNIROUTE_API_KEY"] });
      warnOnAttention({ status: "PROVIDER_UNAVAILABLE", error: "COMPUTE_DISCOVERY_HTTP_503" });
      warnOnAttention({
        status: "WRITE_FAILED",
        source: "https://gateway.invalid",
        error: "connection terminated",
        registered: 4,
      });
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).not.toContain("Bearer");
    } finally {
      warn.mockRestore();
    }
  });

  it("WRITE_FAILED is not reported as a provider outage: the two need opposite responses", async () => {
    const h = harness();
    const boom = new Error("connection terminated unexpectedly");
    vi.spyOn(h.container.workerRegistration, "register").mockRejectedValue(boom);

    const outcome = await run(h, env());

    expect(outcome.status).toBe("WRITE_FAILED");
    expect((outcome as { error: string }).error).toContain("connection terminated");
    expect(await h.store.list()).toEqual([]);
  });

  it("a DEAD CONNECTION still returns WRITE_FAILED and still warns, instead of aborting startup", async () => {
    /*
     * INDEPENDENT REVIEW (MEDIUM). The WRITE_FAILED branch counted the registry with an
     * unguarded `await store.list()` INSIDE its own catch. The realistic cause of a write
     * failure is a dead connection, in which case `list()` fails too: the error escaped
     * `bootstrapComputeFleetAtStartup`, `production-services.ts` closed the container and
     * rethrew, and startup aborted — the exact opposite of this function's documented
     * promise. `log(outcome)` was never reached either, so the operator got no
     * COMPUTE_BOOTSTRAP warning: fail-closed AND undiagnosable.
     *
     * The previous test could not catch this: it mocked only `register` and left `list()`
     * healthy, which is the one combination that cannot occur for the error it models.
     * Here BOTH fail, as a dead connection actually behaves.
     */
    const h = harness();
    const dead = new Error("connection terminated unexpectedly");
    vi.spyOn(h.container.workerRegistration, "register").mockRejectedValue(dead);
    let listCalls = 0;
    vi.spyOn(h.store, "list").mockImplementation(async () => {
      listCalls += 1;
      if (listCalls === 1) return []; // discovery still works
      throw dead; // ...then the connection is gone
    });
    const logged: unknown[] = [];

    const outcome = await run(h, env(), (o) => logged.push(o));

    expect(outcome.status).toBe("WRITE_FAILED");
    /* undefined, not a crash and not a fabricated 0. */
    expect((outcome as { registered: number | undefined }).registered).toBeUndefined();
    /* The operator is told, which is what makes this diagnosable. */
    expect(logged).toHaveLength(1);
    expect(String(JSON.stringify(logged[0]))).toContain("WRITE_FAILED");
  });
});

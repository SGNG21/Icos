import { describe, expect, it } from "vitest";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { evaluateWorkerEligibility } from "@/core/workers/worker-eligibility";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { WorkerRegistrationService } from "./worker-registration-service";
import {
  WorkerHealthProber,
  type WorkerHealthObservation,
  type WorkerHealthProbePort,
} from "./worker-health-prober";

/*
 * M5.2 HEALTH PROBING — defect 14.
 *
 * Mutation-verified. Each proof names, in its title, the property that fails if
 * the corresponding branch of WorkerHealthProber is removed.
 */

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";

function clockAt(iso: string): { now: () => Date; set: (next: string) => void } {
  let current = iso;
  return { now: () => new Date(current), set: (next: string) => void (current = next) };
}

function healthy(): WorkerHealthProbePort {
  return { probe: async (): Promise<WorkerHealthObservation> => ({ health: "healthy", availability: "available" }) };
}

function harness(iso = "2026-09-27T12:00:00.000Z") {
  const clock = clockAt(iso);
  const store = new InMemoryWorkerRegistryStore();
  const registration = new WorkerRegistrationService(store, clock.now);
  return { clock, store, registration };
}

async function registerAgent(registration: WorkerRegistrationService, id: string, kind = "agent") {
  return registration.register({
    id,
    workerKind: kind,
    displayName: id,
    capabilities: ["code-generation"],
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
  });
}

/** Eligibility exactly as the router asks it: with a freshness horizon. */
function eligibleAt(worker: WorkerRegistryEntry, now: string, maxAgeMs = 60_000): boolean {
  return evaluateWorkerEligibility(worker, {
    requiredCapabilities: ["code-generation"],
    evidenceHorizon: { now, maxAgeMs },
  }).eligible;
}

describe("M5.2 WorkerHealthProber", () => {
  it("HEALTH_PROBING_PROVEN: a probe loop turns a registered worker into an eligible one", async () => {
    const { clock, store, registration } = harness();
    await registerAgent(registration, W1);

    // Registered but unprobed: routes nothing. This is the M5.1 state.
    expect(eligibleAt((await store.get(W1))!, clock.now().toISOString())).toBe(false);

    const prober = new WorkerHealthProber(store, registration, {
      adapters: { agent: healthy() },
      now: clock.now,
    });
    const records = await prober.probeAll();

    expect(records).toEqual([
      { workerId: W1, outcome: "ok", health: "healthy", availability: "available" },
    ]);

    const probed = (await store.get(W1))!;
    expect(probed.lastProbeAt).toBe("2026-09-27T12:00:00.000Z");
    expect(probed.lastProbeOutcome).toBe("ok");
    expect(eligibleAt(probed, clock.now().toISOString())).toBe(true);
  });

  it("REGISTRATION_IS_NOT_A_HEALTH_CLAIM still holds: registration produces NO evidence", async () => {
    const { registration, store } = harness();
    await registerAgent(registration, W1);

    const entry = (await store.get(W1))!;
    expect(entry.health).toBe("unknown");
    expect(entry.availability).toBe("unknown");
    expect(entry.lastProbeAt).toBeNull();
    expect(entry.lastProbeOutcome).toBe("never");
  });

  it("PROBE_FAILURE_DOES_NOT_SILENTLY_PASS: a throwing adapter records unhealthy + failed", async () => {
    const { clock, store, registration } = harness();
    await registerAgent(registration, W1);

    const prober = new WorkerHealthProber(store, registration, {
      adapters: {
        agent: {
          probe: async () => {
            throw new Error("RUNTIME_UNREACHABLE");
          },
        },
      },
      now: clock.now,
    });
    const [record] = await prober.probeAll();

    expect(record.outcome).toBe("failed");
    expect(record.error).toContain("RUNTIME_UNREACHABLE");

    const entry = (await store.get(W1))!;
    expect(entry.health).toBe("unhealthy");
    expect(entry.availability).toBe("unavailable");
    // The failure is DATED and distinguishable from "never probed".
    expect(entry.lastProbeOutcome).toBe("failed");
    expect(entry.lastProbeAt).not.toBeNull();
    expect(eligibleAt(entry, clock.now().toISOString())).toBe(false);
  });

  it("UNPROBEABLE_FAILS_CLOSED: a worker kind with no adapter is 'unsupported', never healthy", async () => {
    const { clock, store, registration } = harness();
    await registerAgent(registration, W1, "hermes");

    const prober = new WorkerHealthProber(store, registration, {
      adapters: { agent: healthy() }, // nothing can probe 'hermes'
      now: clock.now,
    });
    const [record] = await prober.probeAll();

    expect(record.outcome).toBe("unsupported");
    const entry = (await store.get(W1))!;
    expect(entry.health).toBe("unknown");
    expect(eligibleAt(entry, clock.now().toISOString())).toBe(false);
  });

  it("NO_PROVIDER_HARDWIRE: an unknown worker kind becomes probeable by DATA alone", async () => {
    const { clock, store, registration } = harness();
    await registerAgent(registration, W1, "openhands");

    const prober = new WorkerHealthProber(store, registration, {
      adapters: { openhands: healthy() },
      now: clock.now,
    });

    expect((await prober.probeAll())[0].outcome).toBe("ok");
    expect(eligibleAt((await store.get(W1))!, clock.now().toISOString())).toBe(true);
  });

  it("STALE_HEALTH_FAIL_CLOSED: evidence nothing refreshed is durably invalidated", async () => {
    const { clock, store, registration } = harness();
    await registerAgent(registration, W1);

    const prober = new WorkerHealthProber(store, registration, {
      adapters: { agent: healthy() },
      maxEvidenceAgeMs: 60_000,
      now: clock.now,
    });
    await prober.probeAll();
    expect((await store.get(W1))!.health).toBe("healthy");

    // The worker's process dies: nothing probes it any more, time passes.
    clock.set("2026-09-27T12:05:00.000Z");
    const expired = await prober.expireStaleEvidence();

    expect(expired).toEqual([W1]);
    const entry = (await store.get(W1))!;
    expect(entry.health).toBe("unknown");
    expect(entry.availability).toBe("unknown");
    expect(entry.lastProbeOutcome).toBe("stale");
  });

  it("RESTART_CANNOT_RESTORE_HEALTHY: the DURABLE row, reread cold, is ineligible", async () => {
    const { clock, store, registration } = harness();
    await registerAgent(registration, W1);
    await new WorkerHealthProber(store, registration, {
      adapters: { agent: healthy() },
      now: clock.now,
    }).probeAll();

    // A brand-new process, hours later, with NO in-memory state whatsoever.
    const later = "2026-09-27T18:00:00.000Z";
    const coldStore = new InMemoryWorkerRegistryStore(await store.list());
    const rehydrated = (await coldStore.get(W1))!;

    expect(rehydrated.health).toBe("healthy"); // the stored claim survives...
    expect(eligibleAt(rehydrated, later)).toBe(false); // ...but buys nothing.

    // And a sweep in that fresh process makes the DURABLE state agree.
    const coldClock = clockAt(later);
    const coldRegistration = new WorkerRegistrationService(coldStore, coldClock.now);
    await new WorkerHealthProber(coldStore, coldRegistration, {
      adapters: {},
      now: coldClock.now,
    }).expireStaleEvidence();

    expect((await coldStore.get(W1))!.health).toBe("unknown");
  });

  it("expiry is idempotent: an already-stale row is not rewritten on every sweep", async () => {
    const { clock, store, registration } = harness();
    await registerAgent(registration, W1);
    const prober = new WorkerHealthProber(store, registration, {
      adapters: { agent: healthy() },
      maxEvidenceAgeMs: 60_000,
      now: clock.now,
    });
    await prober.probeAll();

    clock.set("2026-09-27T12:05:00.000Z");
    expect(await prober.expireStaleEvidence()).toEqual([W1]);
    const afterFirst = (await store.get(W1))!;

    clock.set("2026-09-27T12:06:00.000Z");
    expect(await prober.expireStaleEvidence()).toEqual([]);
    expect(await store.get(W1)).toEqual(afterFirst);
  });

  it("a never-probed worker is left alone by expiry: 'never' stays distinct from 'stale'", async () => {
    const { clock, store, registration } = harness();
    await registerAgent(registration, W1);

    clock.set("2026-09-28T12:00:00.000Z");
    const expired = await new WorkerHealthProber(store, registration, {
      adapters: {},
      now: clock.now,
    }).expireStaleEvidence();

    expect(expired).toEqual([]);
    expect((await store.get(W1))!.lastProbeOutcome).toBe("never");
  });

  it("DEACTIVATE_PRESERVES_AUDIT survives probing: an inactive worker is neither probed nor expired", async () => {
    const { clock, store, registration } = harness();
    await registerAgent(registration, W1);
    const prober = new WorkerHealthProber(store, registration, {
      adapters: { agent: healthy() },
      maxEvidenceAgeMs: 60_000,
      now: clock.now,
    });
    await prober.probeAll();
    await registration.deactivate(W1);

    clock.set("2026-09-27T13:00:00.000Z");
    const report = await prober.sweep();

    expect(report.probed).toEqual([]);
    expect(report.expired).toEqual([]);
    const entry = (await store.get(W1))!;
    expect(entry.health).toBe("healthy"); // last known verdict kept for audit
    expect(entry.status).toBe("inactive"); // and it still routes nothing
    expect(eligibleAt(entry, clock.now().toISOString())).toBe(false);
  });

  it("PROBE_DOES_NOT_INVENT_WORKERS: probing an empty registry writes nothing", async () => {
    const { store, registration } = harness();
    const report = await new WorkerHealthProber(store, registration, {
      adapters: { agent: healthy() },
    }).sweep();

    expect(report).toEqual({ probed: [], expired: [] });
    expect(await store.list()).toEqual([]);
  });

  it("the sweep report is deterministic: ordered by worker id regardless of storage order", async () => {
    const { clock, store, registration } = harness();
    await registerAgent(registration, W2);
    await registerAgent(registration, W1);

    const records = await new WorkerHealthProber(store, registration, {
      adapters: { agent: healthy() },
      now: clock.now,
    }).probeAll();

    expect(records.map((r) => r.workerId)).toEqual([W1, W2]);
  });

  it("a degraded observation is recorded faithfully and still routes nothing", async () => {
    const { clock, store, registration } = harness();
    await registerAgent(registration, W1);

    await new WorkerHealthProber(store, registration, {
      adapters: {
        agent: { probe: async () => ({ health: "degraded", availability: "available" }) },
      },
      now: clock.now,
    }).probeAll();

    const entry = (await store.get(W1))!;
    expect(entry.health).toBe("degraded");
    expect(entry.lastProbeOutcome).toBe("ok"); // the PROBE worked; the WORKER is degraded
    expect(eligibleAt(entry, clock.now().toISOString())).toBe(false);
  });
});

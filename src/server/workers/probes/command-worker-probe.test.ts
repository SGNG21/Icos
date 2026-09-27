import { describe, expect, it } from "vitest";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { evaluateWorkerEligibility } from "@/core/workers/worker-eligibility";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { WorkerHealthProber } from "@/server/services/worker-registry/worker-health-prober";
import { CommandWorkerProbe, runCommand } from "./command-worker-probe";
import {
  createWorkerProbeResolver,
  parseWorkerProbeCommands,
  probeableRuntimes,
} from "./probe-command-config";

/*
 * M6 REAL WORKER PROBE — defect 16.
 *
 * These run REAL child processes. Everything before M6 was proven against fake
 * adapters, so this is the first place the outside world's failure modes are
 * exercised: a missing executable, a non-zero exit, a process that hangs, and a
 * runtime nobody configured.
 */

const W1 = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-27T12:00:00.000Z";

function worker(over: Partial<WorkerRegistryEntry> = {}): WorkerRegistryEntry {
  return {
    id: W1,
    workerKind: "agent",
    displayName: "worker",
    capabilities: ["code-generation"],
    features: [],
    supportsTools: true,
    supportsStructuredOutput: true,
    status: "active",
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
    health: "unknown",
    availability: "unknown",
    tags: [],
    metadata: {},
    lastProbeAt: null,
    lastProbeOutcome: "never",
    maxConcurrency: 1,
    capacityPool: null,
    capacityPoolLimit: null,
    updatedAt: NOW,
    ...over,
  };
}

describe("M6 CommandWorkerProbe (real child processes)", () => {
  it("REAL_PROBE_SUCCEEDS: running the actual node runtime reports healthy", async () => {
    const probe = new CommandWorkerProbe(createWorkerProbeResolver({}));

    // No stub: this genuinely spawns `process.execPath --version`.
    await expect(probe.probe(worker())).resolves.toEqual({
      health: "healthy",
      availability: "available",
    });
  });

  it("MISSING_EXECUTABLE_IS_A_FAILURE, not a pass", async () => {
    const probe = new CommandWorkerProbe(() => ({
      command: "/nonexistent/icos-probe-should-not-exist",
    }));

    await expect(probe.probe(worker())).rejects.toThrow(/WORKER_PROBE_EXIT_null/);
  });

  it("NON_ZERO_EXIT_IS_A_FAILURE and the reason is carried", async () => {
    const probe = new CommandWorkerProbe(() => ({
      command: process.execPath,
      args: ["-e", "process.stderr.write('runtime refused'); process.exit(3)"],
    }));

    await expect(probe.probe(worker())).rejects.toThrow(/WORKER_PROBE_EXIT_3.*runtime refused/s);
  });

  it("a runtime that reports readiness with a non-zero code can be configured to pass", async () => {
    const probe = new CommandWorkerProbe(() => ({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      healthyExitCodes: [3],
    }));

    await expect(probe.probe(worker())).resolves.toEqual({
      health: "healthy",
      availability: "available",
    });
  });

  it("A HANGING PROBE IS A FAILED PROBE: the timeout kills it", async () => {
    const probe = new CommandWorkerProbe(() => ({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      timeoutMs: 250,
    }));

    const started = Date.now();
    await expect(probe.probe(worker())).rejects.toThrow(/WORKER_PROBE_TIMEOUT/);
    // It really was killed, not awaited.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("NON_INTERACTIVE: a process that tries to read stdin gets EOF instead of blocking", async () => {
    const probe = new CommandWorkerProbe(() => ({
      command: process.execPath,
      // Would block forever on an inherited TTY; with stdio ignore it ends at once.
      args: [
        "-e",
        "process.stdin.on('data', () => process.exit(1)); process.stdin.on('end', () => process.exit(0)); process.stdin.resume();",
      ],
      timeoutMs: 3_000,
    }));

    await expect(probe.probe(worker())).resolves.toEqual({
      health: "healthy",
      availability: "available",
    });
  });

  it("UNRESOLVED_RUNTIME_FAILS_LOUDLY: an unconfigured runtime throws rather than passing", async () => {
    const probe = new CommandWorkerProbe(createWorkerProbeResolver({}));

    await expect(probe.probe(worker({ runtime: "docker" }))).rejects.toThrow(
      /WORKER_PROBE_UNRESOLVED/,
    );
  });

  it("runCommand never rejects: a spawn error arrives as a non-zero result", async () => {
    const result = await runCommand({ command: "/nonexistent/icos-probe" }, 1_000);

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr).not.toBe("");
  });
});

describe("M6 probe command configuration", () => {
  it("absent configuration leaves ONLY the node runtime probeable", () => {
    expect(probeableRuntimes(parseWorkerProbeCommands(undefined))).toEqual(["node"]);
  });

  it("a configured runtime becomes probeable without any code change", () => {
    const configured = parseWorkerProbeCommands(
      JSON.stringify({ binary: { command: "/opt/worker", args: ["--health"] } }),
    );

    expect(probeableRuntimes(configured)).toEqual(["binary", "node"]);
    expect(createWorkerProbeResolver(configured)(worker({ runtime: "binary" }))).toEqual({
      command: "/opt/worker",
      args: ["--health"],
    });
  });

  it("configuration OVERRIDES the built-in node answer", () => {
    const configured = parseWorkerProbeCommands(
      JSON.stringify({ node: { command: "/custom/node", args: ["-v"] } }),
    );

    expect(createWorkerProbeResolver(configured)(worker())).toEqual({
      command: "/custom/node",
      args: ["-v"],
    });
  });

  it("MALFORMED CONFIGURATION REFUSES TO BOOT rather than probing nothing", () => {
    expect(() => parseWorkerProbeCommands("{not json")).toThrow(
      /WORKER_PROBE_COMMANDS_INVALID_JSON/,
    );
    expect(() => parseWorkerProbeCommands(JSON.stringify({ node: { command: "" } }))).toThrow(
      /WORKER_PROBE_COMMANDS_INVALID/,
    );
    expect(() =>
      parseWorkerProbeCommands(JSON.stringify({ not_a_runtime: { command: "x" } })),
    ).toThrow(/WORKER_PROBE_COMMANDS_INVALID/);
  });
});

describe("M6 real probe through the prober, end to end", () => {
  function harness(iso = NOW) {
    let current = iso;
    const clock = { now: () => new Date(current), set: (n: string) => void (current = n) };
    const store = new InMemoryWorkerRegistryStore();
    const registration = new WorkerRegistrationService(store, clock.now);
    return { clock, store, registration };
  }

  const eligible = (w: WorkerRegistryEntry, now: string) =>
    evaluateWorkerEligibility(w, {
      requiredCapabilities: ["code-generation"],
      evidenceHorizon: { now, maxAgeMs: 60_000 },
    }).eligible;

  it("UNKNOWN -> HEALTHY only after a REAL successful probe", async () => {
    const { clock, store, registration } = harness();
    await registration.register({
      id: W1,
      workerKind: "agent",
      displayName: "real worker",
      capabilities: ["code-generation"],
      runtime: "node",
      runtimeSupport: "SUPPORTED_RUNTIME",
    });

    expect((await store.get(W1))!.health).toBe("unknown");
    expect(eligible((await store.get(W1))!, clock.now().toISOString())).toBe(false);

    const prober = new WorkerHealthProber(store, registration, {
      adapters: { node: new CommandWorkerProbe(createWorkerProbeResolver({})) },
      now: clock.now,
    });
    const [record] = await prober.probeAll();

    expect(record).toEqual({
      workerId: W1,
      outcome: "ok",
      health: "healthy",
      availability: "available",
    });
    expect(eligible((await store.get(W1))!, clock.now().toISOString())).toBe(true);
  });

  it("ADAPTER_FAILURE_IS_OBSERVABLE: the error text is returned AND the row fails closed", async () => {
    const { clock, store, registration } = harness();
    await registration.register({
      id: W1,
      workerKind: "agent",
      displayName: "broken worker",
      capabilities: ["code-generation"],
      runtime: "node",
      runtimeSupport: "SUPPORTED_RUNTIME",
    });

    const prober = new WorkerHealthProber(store, registration, {
      adapters: {
        node: new CommandWorkerProbe(() => ({
          command: process.execPath,
          args: ["-e", "process.stderr.write('boom'); process.exit(9)"],
        })),
      },
      now: clock.now,
    });
    const [record] = await prober.probeAll();

    // Observable: the record names the failure.
    expect(record.outcome).toBe("failed");
    expect(record.error).toMatch(/WORKER_PROBE_EXIT_9/);
    expect(record.error).toMatch(/boom/);

    // Fail closed: the durable row refuses work.
    const stored = (await store.get(W1))!;
    expect(stored.health).toBe("unhealthy");
    expect(stored.availability).toBe("unavailable");
    expect(stored.lastProbeOutcome).toBe("failed");
    expect(eligible(stored, clock.now().toISOString())).toBe(false);
  });
});

/*
 * M6 CONTAINER WIRING (defect 16, requirement: the adapter must be WIRED).
 *
 * Writing an adapter proves nothing if the composition root still passes `{}`.
 * These assert the wiring itself, through `buildMemoryContainer`, which uses the
 * same `buildWorkerProbeAdapters()` as the PostgreSQL root.
 */
describe("M6 container wiring", () => {
  it("container.workerHealthProber really probes a node worker to HEALTHY", async () => {
    const { buildMemoryContainer } = await import("@/server/container");
    const container = buildMemoryContainer();

    await container.workerRegistration.register({
      id: W1,
      workerKind: "agent",
      displayName: "wired worker",
      capabilities: ["code-generation"],
      runtime: "node",
      runtimeSupport: "SUPPORTED_RUNTIME",
    });

    // Registered but unprobed: the wired router refuses it.
    expect(
      (await container.capabilityRouter.route({ requiredCapabilities: ["code-generation"] }))
        .decision,
    ).toBe("NO_ELIGIBLE_WORKER");

    // A REAL child process runs inside the container's own prober.
    const [record] = await container.workerHealthProber.probeAll();
    expect(record).toMatchObject({ workerId: W1, outcome: "ok", health: "healthy" });

    expect(
      (await container.capabilityRouter.route({ requiredCapabilities: ["code-generation"] }))
        .worker?.id,
    ).toBe(W1);
  });

  it("the wired prober leaves an unconfigured runtime UNSUPPORTED, not healthy", async () => {
    const { buildMemoryContainer } = await import("@/server/container");
    const container = buildMemoryContainer();

    await container.workerRegistration.register({
      id: W1,
      workerKind: "agent",
      displayName: "docker worker",
      capabilities: ["code-generation"],
      runtime: "docker",
      runtimeSupport: "SUPPORTED_RUNTIME",
    });

    const [record] = await container.workerHealthProber.probeAll();

    expect(record.outcome).toBe("unsupported");
    expect(
      (await container.capabilityRouter.route({ requiredCapabilities: ["code-generation"] }))
        .decision,
    ).toBe("NO_ELIGIBLE_WORKER");
  });
});

import { describe, expect, it, vi } from "vitest";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { buildMemoryContainer } from "@/server/container";
import { candidateRegistration } from "@/server/workers/compute-fleet";
import { CommandWorkerProbe } from "@/server/workers/probes/command-worker-probe";
import { OmniRouteHttpWorkerProbe } from "@/server/workers/probes/omniroute-http-worker-probe";

/*
 * THE WIRING IS THE CLAIM.
 *
 * The adapter is only safe if the REAL container actually selects it for a model worker.
 * These tests fail if someone deletes `selectProbe` from the container — the mutation that
 * would silently put every model probe back on the agent-CLI path with the server's whole
 * environment and an agent's toolset.
 */

const modelWorker = () =>
  candidateRegistration(
    { modelId: "claude/claude-sonnet-5", provider: "claude", family: "CLAUDE_SONNET" },
    { runtime: "binary", capabilities: ["code_editing"] },
  ) as WorkerRegistryEntry;

const binaryWorker = (): WorkerRegistryEntry =>
  ({ ...modelWorker(), displayName: "plain-binary-worker", metadata: {} }) as WorkerRegistryEntry;

/** Reaches the prober's private selector exactly as `probeOne` does. */
const selectorOf = (prober: unknown) =>
  (prober as { selectProbe?: (w: WorkerRegistryEntry) => unknown }).selectProbe;

describe("REAL container — model probe selection", () => {
  it("MODEL_PROBE_WIRED: with OmniRoute configured, a model worker gets the HTTP probe", async () => {
    vi.stubEnv("OMNIROUTE_BASE_URL", "http://127.0.0.1:20129");
    vi.stubEnv("OMNIROUTE_API_KEY", "test-credential");

    const container = await buildMemoryContainer();
    try {
      const select = selectorOf(container.workerHealthProber);
      expect(select, "container did not wire selectProbe").toBeTypeOf("function");
      expect(select!(modelWorker())).toBeInstanceOf(OmniRouteHttpWorkerProbe);
      /* A worker that is not a model is DECLINED, so the runtime map still answers. */
      expect(select!(binaryWorker())).toBeUndefined();
    } finally {
      await container.close();
      vi.unstubAllEnvs();
    }
  });

  it("NO_COMMAND_FALLBACK_WHEN_UNCONFIGURED: no OmniRoute means NO model probe at all", async () => {
    vi.stubEnv("OMNIROUTE_BASE_URL", "");
    vi.stubEnv("OMNIROUTE_API_KEY", "");

    const container = await buildMemoryContainer();
    try {
      /*
       * Fail CLOSED: the model worker has no adapter, is recorded `unsupported` and routes
       * nothing. It must NOT inherit the command probe — a missing gateway credential is
       * not a reason to hand a model probe the host's environment and an agent's tools.
       */
      expect(selectorOf(container.workerHealthProber)).toBeUndefined();
      const [record] = await container.workerHealthProber.probeAll();
      expect(record).toBeUndefined(); // no workers registered; nothing is invented
    } finally {
      await container.close();
      vi.unstubAllEnvs();
    }
  });

  it("the command probe is PRESERVED for non-model workers", async () => {
    vi.stubEnv("OMNIROUTE_BASE_URL", "http://127.0.0.1:20129");
    vi.stubEnv("OMNIROUTE_API_KEY", "test-credential");
    vi.stubEnv(
      "ICOS_WORKER_PROBE_COMMANDS",
      JSON.stringify({ binary: { command: process.execPath, args: ["-e", ""] } }),
    );

    const container = await buildMemoryContainer();
    try {
      const prober = container.workerHealthProber as unknown as {
        adapters: Record<string, unknown>;
      };
      expect(prober.adapters.binary).toBeInstanceOf(CommandWorkerProbe);
      expect(prober.adapters.node).toBeInstanceOf(CommandWorkerProbe);
    } finally {
      await container.close();
      vi.unstubAllEnvs();
    }
  });

  it("the configured HTTP timeout reaches the adapter", async () => {
    vi.stubEnv("OMNIROUTE_BASE_URL", "http://127.0.0.1:20129");
    vi.stubEnv("OMNIROUTE_API_KEY", "test-credential");
    vi.stubEnv("ICOS_WORKER_PROBE_HTTP_TIMEOUT_MS", "9000");

    const container = await buildMemoryContainer();
    try {
      const probe = selectorOf(container.workerHealthProber)!(modelWorker()) as unknown as {
        options: { timeoutMs?: number; credential: string };
      };
      expect(probe.options.timeoutMs).toBe(9000);
      expect(probe.options.credential).toBe("test-credential");
    } finally {
      await container.close();
      vi.unstubAllEnvs();
    }
  });
});

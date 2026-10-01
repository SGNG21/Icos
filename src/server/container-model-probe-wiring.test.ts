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

const modelDeclaration = () => ({
  id: "33333333-3333-4333-8333-333333333333",
  workerKind: "agent",
  displayName: "compute:claude/claude-sonnet-5",
  capabilities: ["code_editing"],
  runtime: "binary" as const,
  runtimeSupport: "SUPPORTED_RUNTIME" as const,
  metadata: { model: "claude/claude-sonnet-5", provider: "claude" },
});

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

  it("NO_COMMAND_FALLBACK_WHEN_UNCONFIGURED: an unconfigured gateway must not put a MODEL worker on the agent CLI", async () => {
    /*
     * THE REGRESSION THIS FILE EXISTS FOR. The first version of the selector returned
     * `undefined` when OmniRoute was unconfigured, which the prober read as "not mine" and
     * answered from `adapters["binary"]` — the agent CLI. Measured before the fix: the
     * command probe ran for a model worker and recorded outcome `ok`, i.e. a model
     * certified healthy by starting a runtime that knows nothing about it. Fail-OPEN.
     */
    vi.stubEnv("OMNIROUTE_BASE_URL", "");
    vi.stubEnv("OMNIROUTE_API_KEY", "");
    vi.stubEnv(
      "ICOS_WORKER_PROBE_COMMANDS",
      JSON.stringify({ binary: { command: process.execPath, args: ["-e", ""] } }),
    );

    const container = await buildMemoryContainer();
    try {
      await container.workerRegistration.register(modelDeclaration());
      const adapters = (
        container.workerHealthProber as unknown as { adapters: Record<string, unknown> }
      ).adapters;
      const command = vi.spyOn(adapters.binary as CommandWorkerProbe, "probe");

      const [record] = await container.workerHealthProber.probeAll();

      expect(
        command,
        "the agent-CLI probe must never run for a model worker",
      ).not.toHaveBeenCalled();
      /* "We have no way to check this", which routes nothing — not a borrowed verdict. */
      expect(record?.outcome).toBe("unsupported");
      expect(record?.health).toBe("unknown");
      expect(record?.availability).toBe("unknown");
    } finally {
      await container.close();
      vi.unstubAllEnvs();
    }
  });

  it("SECOND_DOOR: a compute row that lost its model metadata is still refused the command probe", async () => {
    vi.stubEnv("OMNIROUTE_BASE_URL", "http://127.0.0.1:20129");
    vi.stubEnv("OMNIROUTE_API_KEY", "test-credential");
    vi.stubEnv(
      "ICOS_WORKER_PROBE_COMMANDS",
      JSON.stringify({ binary: { command: process.execPath, args: ["-e", ""] } }),
    );

    const container = await buildMemoryContainer();
    try {
      /* A `compute:` row with no metadata.model — a hand-edited or partially reconciled row. */
      await container.workerRegistration.register({ ...modelDeclaration(), metadata: {} });
      const adapters = (
        container.workerHealthProber as unknown as { adapters: Record<string, unknown> }
      ).adapters;
      const command = vi.spyOn(adapters.binary as CommandWorkerProbe, "probe");

      const [record] = await container.workerHealthProber.probeAll();

      expect(command).not.toHaveBeenCalled();
      /* It reaches the HTTP probe's own guard: a diagnosable failure, never a pass. */
      expect(record?.outcome).toBe("failed");
      expect(record?.error).toMatch(/WORKER_PROBE_NO_MODEL/);
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

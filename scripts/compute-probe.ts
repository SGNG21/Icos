/**
 * Live compute probe (decision 0054) — the certification counterpart of compute:snapshot.
 *
 * For one representative model per (family, provider) that OmniRoute LISTS, runs the CANONICAL
 * probe adapter (`CommandWorkerProbe`, configured by ICOS_WORKER_PROBE_COMMANDS — the same
 * adapter the container's WorkerHealthProber uses) and reports whether the model actually
 * ANSWERED. Listing is not serving: nothing is AVAILABLE without a real answer.
 *
 * Read-only: registers nothing, writes nothing. Credentials are never printed — the probe
 * command resolves its own, and failure text is cut to one line.
 *
 * Usage: pnpm compute:probe
 */
import { loadEnv } from "@/config/env";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import {
  candidateRegistration,
  classifyModels,
  classifyProbeFailure,
  listOmniRouteModels,
  representativeModels,
} from "@/server/workers/compute-fleet";
import { CommandWorkerProbe } from "@/server/workers/probes/command-worker-probe";
import {
  createWorkerProbeResolver,
  parseWorkerProbeCommands,
} from "@/server/workers/probes/probe-command-config";

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.OMNIROUTE_BASE_URL || !env.OMNIROUTE_API_KEY) {
    throw new Error(
      "COMPUTE_PROBE_UNCONFIGURED: OMNIROUTE_BASE_URL and OMNIROUTE_API_KEY are required",
    );
  }
  const commands = parseWorkerProbeCommands(env.ICOS_WORKER_PROBE_COMMANDS);
  const runtime = "binary" as const;
  if (!commands[runtime])
    throw new Error("COMPUTE_PROBE_UNCONFIGURED: ICOS_WORKER_PROBE_COMMANDS.binary is required");
  const probe = new CommandWorkerProbe(createWorkerProbeResolver(commands));

  const listed = await listOmniRouteModels({
    baseUrl: env.OMNIROUTE_BASE_URL,
    credential: env.OMNIROUTE_API_KEY,
  });
  const gateway = new URL(env.OMNIROUTE_BASE_URL).origin;

  for (const model of representativeModels(classifyModels(listed))) {
    /* Only identity and metadata matter to a probe; nothing is registered. */
    const worker = candidateRegistration(model, {
      runtime,
      capabilities: [],
    }) as WorkerRegistryEntry;
    const started = Date.now();
    let result: { ok: boolean; classification: string; detail?: string };
    try {
      await probe.probe(worker);
      result = { ok: true, classification: "AVAILABLE" };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error))
        .split("\n")[0]!
        .slice(0, 200);
      result = {
        ok: false,
        classification: /TIMEOUT/.test(message) ? "UNKNOWN" : classifyProbeFailure(message),
        detail: message,
      };
    }
    console.log(
      JSON.stringify({
        family: model.family,
        provider: model.provider,
        model: model.modelId,
        gateway,
        ...result,
        latencyMs: Date.now() - started,
      }),
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "COMPUTE_PROBE_FAILED");
  process.exit(1);
});

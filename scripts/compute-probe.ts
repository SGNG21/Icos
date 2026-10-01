/**
 * Live compute probe — the certification counterpart of compute:snapshot.
 *
 * For one representative model per (family, provider) that OmniRoute LISTS, runs the
 * CANONICAL probe adapter — `OmniRouteHttpWorkerProbe`, the same adapter the container's
 * WorkerHealthProber selects for a model worker — and reports whether the model actually
 * ANSWERED. Listing is not serving: nothing is AVAILABLE without a real answer.
 *
 * IT USED TO SPAWN AN AGENT CLI, and that was the problem this lane measured: a probe
 * through `CommandWorkerProbe` inherits the whole process environment (every provider key,
 * the database credential, the auth secret) and the agent's toolset — terminal, file,
 * code execution, browser — with approvals auto-bypassed. The unattended sweep stopped
 * doing that; this operator command had no business continuing to, least of all while
 * calling itself canonical.
 *
 * Read-only: registers nothing, writes nothing, touches no database. The credential is
 * sent in one header and struck from any failure text.
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
import { OmniRouteHttpWorkerProbe } from "@/server/workers/probes/omniroute-http-worker-probe";
import { firstLineRedacted } from "@/server/workers/probes/probe-redaction";

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.OMNIROUTE_BASE_URL || !env.OMNIROUTE_API_KEY) {
    throw new Error(
      "COMPUTE_PROBE_UNCONFIGURED: OMNIROUTE_BASE_URL and OMNIROUTE_API_KEY are required",
    );
  }
  const baseUrl = env.OMNIROUTE_BASE_URL;
  const credential = env.OMNIROUTE_API_KEY;
  const probe = new OmniRouteHttpWorkerProbe({
    baseUrl,
    credential,
    timeoutMs: env.ICOS_WORKER_PROBE_HTTP_TIMEOUT_MS,
  });

  const listed = await listOmniRouteModels({ baseUrl, credential });
  const gateway = new URL(baseUrl).origin;

  for (const model of representativeModels(classifyModels(listed))) {
    /* Only identity and metadata matter to a probe; nothing is registered. */
    const worker = candidateRegistration(model, {
      runtime: "binary",
      capabilities: [],
    }) as WorkerRegistryEntry;
    const started = Date.now();
    let result: { ok: boolean; classification: string; detail?: string };
    try {
      await probe.probe(worker);
      result = { ok: true, classification: "AVAILABLE" };
    } catch (error) {
      /* Already one redacted line from the adapter; redacted again, never trusted raw. */
      const message = firstLineRedacted(error instanceof Error ? error.message : String(error))
        .split(credential)
        .join("<redacted>");
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

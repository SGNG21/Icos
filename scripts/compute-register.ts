/**
 * Register the compute fleet OmniRoute serves — the operator counterpart of compute:snapshot /
 * compute:probe, and exactly what the ICOS_SELF_BUILD_E2E fixture does before a run.
 *
 * Thin CLI over four canonical calls, no business logic here:
 *   listOmniRouteModels → representativeModels(classifyModels(...)) →
 *   workerRegistration.register(candidateRegistration(...))  [fail-closed: unknown/unknown]
 *   → workerHealthProber.probeAll()                            [health is probed, never asserted]
 *
 * Idempotent: re-registering an existing worker id is the registry's business. Nothing is marked
 * healthy here; a candidate routes only once its own probe (ICOS_WORKER_PROBE_COMMANDS) answered.
 * Credentials are never printed. Requires PERSISTENCE=postgres, OMNIROUTE_BASE_URL/API_KEY.
 *
 * Usage: pnpm compute:register [capability ...]   (default: code_editing documentation analysis review)
 */
import { loadEnv } from "@/config/env";
import { createContainer } from "@/server/container";
import {
  candidateRegistration,
  classifyModels,
  listOmniRouteModels,
  representativeModels,
} from "@/server/workers/compute-fleet";

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.PERSISTENCE !== "postgres") throw new Error("PERSISTENCE=postgres est requis.");
  if (!env.OMNIROUTE_BASE_URL || !env.OMNIROUTE_API_KEY) {
    throw new Error("OMNIROUTE_BASE_URL/OMNIROUTE_API_KEY requis pour découvrir le compute.");
  }
  const capabilities =
    process.argv.length > 2
      ? process.argv.slice(2)
      : ["code_editing", "documentation", "analysis", "review"];

  const container = await createContainer({ env });
  try {
    const served = await listOmniRouteModels({
      baseUrl: env.OMNIROUTE_BASE_URL,
      credential: env.OMNIROUTE_API_KEY,
    });
    const discovered = representativeModels(classifyModels(served));
    const registered: string[] = [];
    for (const model of discovered) {
      const entry = candidateRegistration(model, { runtime: "binary", capabilities });
      await container.workerRegistration.register(entry);
      registered.push(entry.id);
    }
    const probed = await container.workerHealthProber.probeAll();
    console.log(
      JSON.stringify(
        {
          served: served.length,
          registered,
          probed: probed.map((r) => ({
            workerId: r.workerId,
            outcome: r.outcome,
            health: r.health,
            error: r.error ? String(r.error).split("\n")[0].slice(0, 160) : undefined,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await container.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

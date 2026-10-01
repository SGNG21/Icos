/**
 * The compute fleet bootstrap, as an operator command (live-worker bootstrap lane).
 *
 * Thin CLI over the canonical path, no business logic here:
 *   discoverComputeFleet  → planComputeBootstrap   [PURE: what WOULD change]
 *   applyComputeBootstrap → workerRegistration     [fail-closed: unknown/unknown]
 *   workerHealthProber.probeAll()                  [health is probed, never asserted]
 *
 * DRY RUN IS THE DEFAULT. Without `--apply` nothing is written: the report below is
 * computed by the same planner the write replays, so it cannot disagree with it.
 * Registering the fleet of a live deployment is a deliberate act, and "no explicit
 * permission -> deny" applies to an operator command as much as to an agent.
 *
 * Idempotent and restart-safe: a candidate whose declaration has not changed is not
 * rewritten at all, so re-running this (or a restart) preserves probe evidence instead
 * of resetting the whole fleet to unproven. Nothing is marked healthy here; a candidate
 * routes only once its own probe (ICOS_WORKER_PROBE_COMMANDS) answered.
 *
 * Credentials are never printed. Requires PERSISTENCE=postgres, OMNIROUTE_BASE_URL/API_KEY.
 *
 * Usage:
 *   pnpm compute:register                        # dry run, writes nothing
 *   pnpm compute:register --apply                # register + probe
 *   pnpm compute:register [--apply] cap1 cap2    # override declared capabilities
 */
import { loadEnv } from "@/config/env";
import { createContainer } from "@/server/container";
import {
  applyComputeBootstrap,
  DEFAULT_COMPUTE_CAPABILITIES,
  discoverComputeFleet,
} from "@/server/workers/compute-bootstrap";

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.PERSISTENCE !== "postgres") throw new Error("PERSISTENCE=postgres est requis.");
  if (!env.OMNIROUTE_BASE_URL || !env.OMNIROUTE_API_KEY) {
    throw new Error("OMNIROUTE_BASE_URL/OMNIROUTE_API_KEY requis pour découvrir le compute.");
  }
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const capabilities = args.filter((a) => !a.startsWith("--"));

  const container = await createContainer({ env });
  try {
    /* THROWS if the provider is unreachable: no plan, hence no write, hence no fleet
     * reported as "no longer served" because a gateway was down for ten seconds. */
    const plan = await discoverComputeFleet({
      baseUrl: env.OMNIROUTE_BASE_URL,
      credential: env.OMNIROUTE_API_KEY,
      options: {
        runtime: "binary",
        capabilities: capabilities.length > 0 ? capabilities : [...DEFAULT_COMPUTE_CAPABILITIES],
      },
      workers: container.workerRegistryStore,
    });

    const report = {
      mode: apply ? "APPLY" : "DRY_RUN",
      source: plan.source,
      listed: plan.listed,
      /* EMPTY means the gateway told us nothing, not that every model was withdrawn:
       * orphan detection is suspended for it, so nothing is reported as withdrawn. */
      discovery: plan.discovery,
      wouldRegister: plan.register.map((p) => ({ id: p.id, model: p.model, family: p.family })),
      wouldUpdate: plan.update.map((p) => ({ id: p.id, model: p.model, family: p.family })),
      alreadyPresent: plan.unchanged.map((p) => ({ id: p.id, model: p.model })),
      /* REPORT ONLY — this command never writes a worker's status. */
      noLongerServed: plan.orphan,
      disabledLeftAlone: plan.disabled,
      unavailable: plan.unavailable,
      pools: plan.pools,
    };

    if (!apply) {
      console.log(
        JSON.stringify(
          {
            ...report,
            writes: 0,
            note: "DRY RUN — nothing written. Re-run with --apply to register.",
          },
          null,
          2,
        ),
      );
      return;
    }

    const applied = await applyComputeBootstrap(container.workerRegistration, plan);
    const probed = await container.workerHealthProber.probeAll();
    console.log(
      JSON.stringify(
        {
          ...report,
          applied,
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

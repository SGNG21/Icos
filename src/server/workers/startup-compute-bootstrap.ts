import type { Env } from "@/config/env";
import type { Container } from "@/server/container";
import {
  applyComputeBootstrap,
  DEFAULT_COMPUTE_CAPABILITIES,
  discoverComputeFleet,
  type ComputeBootstrapResult,
} from "@/server/workers/compute-bootstrap";

/**
 * Startup fleet registration (live-worker bootstrap lane).
 *
 * `startProductionServices` already IGNITED the probe sweep; this is the step before
 * it that never existed — the declared fleet reaching the registry at boot instead of
 * only when an operator happened to run `pnpm compute:register --apply`.
 *
 * THREE REASONS IT IS SHAPED LIKE THIS
 *
 * 1. OFF BY DEFAULT. Registration writes rows. A deployment must OPT IN
 *    (`ICOS_COMPUTE_BOOTSTRAP`) rather than acquire a database write by being
 *    upgraded.
 * 2. SAFE TO RUN UNCONDITIONALLY ONCE ON. Every boot and every replica computes the
 *    same deterministic candidate ids and the same declaration, and the canonical
 *    registration service does not rewrite an unchanged one — so a restart adds no
 *    duplicate row and, crucially, does not reset the fleet's probe evidence. A
 *    bootstrap that reset evidence on each boot would make every restart silently
 *    unroute a proven fleet.
 * 3. FAILS SAFE, NOT CLOSED-AND-FATAL. A provider outage throws before a plan exists,
 *    so the registry is untouched; that is reported and startup continues. Aborting the
 *    whole runtime because a gateway was down would trade an unregistered fleet for no
 *    runtime at all — and the registry's previous contents still route.
 *
 * It registers; it never marks anything healthy. Every candidate lands `unknown` and
 * routes nothing until the durable `probe_workers` sweep gets a real answer from it.
 */

export type StartupComputeBootstrapOutcome =
  | { status: "DISABLED" }
  | { status: "UNCONFIGURED"; missing: string[] }
  | { status: "APPLIED"; source: string; result: ComputeBootstrapResult }
  | { status: "PROVIDER_UNAVAILABLE"; error: string };

/**
 * Only the outcomes an operator must ACT on are logged, and as a warning.
 *
 * A successful bootstrap is silent on purpose: the registry rows are the evidence, the
 * cockpit reads them, and dumping results into stdout is exactly what this repository
 * forbids. A bootstrap that is enabled and did NOT register the fleet, however, is
 * invisible otherwise — that is the defect-16 failure mode (fail-closed and
 * undiagnosable), so it says so.
 */
function warnOnAttention(outcome: StartupComputeBootstrapOutcome): void {
  if (outcome.status === "UNCONFIGURED" || outcome.status === "PROVIDER_UNAVAILABLE") {
    console.warn(`COMPUTE_BOOTSTRAP ${JSON.stringify(outcome)}`);
  }
}

export async function bootstrapComputeFleetAtStartup(
  container: Container,
  env: Env,
  log: (outcome: StartupComputeBootstrapOutcome) => void = warnOnAttention,
): Promise<StartupComputeBootstrapOutcome> {
  if (!env.ICOS_COMPUTE_BOOTSTRAP) {
    return { status: "DISABLED" };
  }

  /*
   * Say which variable is missing rather than booting a runtime that will never
   * register anything — the defect-16 lesson: fail-closed and undiagnosable is worse
   * than fail-closed and loud.
   */
  const absent = [
    ...(env.OMNIROUTE_BASE_URL ? [] : ["OMNIROUTE_BASE_URL"]),
    ...(env.OMNIROUTE_API_KEY ? [] : ["OMNIROUTE_API_KEY"]),
  ];
  if (absent.length > 0) {
    const outcome = { status: "UNCONFIGURED", missing: absent } as const;
    log(outcome);
    return outcome;
  }

  try {
    const plan = await discoverComputeFleet({
      baseUrl: env.OMNIROUTE_BASE_URL!,
      credential: env.OMNIROUTE_API_KEY!,
      options: { runtime: "binary", capabilities: [...DEFAULT_COMPUTE_CAPABILITIES] },
      workers: container.workerRegistryStore,
    });
    const result = await applyComputeBootstrap(container.workerRegistration, plan);
    const outcome = { status: "APPLIED", source: plan.source, result } as const;
    log(outcome);
    return outcome;
  } catch (error) {
    /* One line, and never the credential: the gateway's own error text is not logged whole. */
    const outcome = {
      status: "PROVIDER_UNAVAILABLE",
      error: (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200),
    } as const;
    log(outcome);
    return outcome;
  }
}

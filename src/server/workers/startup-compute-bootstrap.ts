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
  | { status: "PROVIDER_UNAVAILABLE"; error: string }
  /**
   * The registry refused the write. Reported SEPARATELY from a provider outage,
   * because the two need opposite responses and are indistinguishable otherwise: a
   * provider outage leaves the registry exactly as it was, while a write failure can
   * leave it PARTIALLY reconciled — `applyComputeBootstrap` registers row by row and
   * `WorkerRegistryStore` exposes no transaction. Pointing an operator at the gateway
   * when the database is the problem is the kind of misdirection that costs an hour.
   */
  | { status: "WRITE_FAILED"; source: string; error: string; registered: number };

/**
 * Only the outcomes an operator must ACT on are logged, and as a warning.
 *
 * A successful bootstrap is silent on purpose: the registry rows are the evidence, the
 * cockpit reads them, and dumping results into stdout is exactly what this repository
 * forbids. A bootstrap that is enabled and did NOT register the fleet, however, is
 * invisible otherwise — that is the defect-16 failure mode (fail-closed and
 * undiagnosable), so it says so.
 */
export function warnOnAttention(outcome: StartupComputeBootstrapOutcome): void {
  if (
    outcome.status === "UNCONFIGURED" ||
    outcome.status === "PROVIDER_UNAVAILABLE" ||
    outcome.status === "WRITE_FAILED"
  ) {
    console.warn(`COMPUTE_BOOTSTRAP ${JSON.stringify(outcome)}`);
  }
}

/**
 * One bounded, REDACTED line of an error, for a log an operator reads at boot.
 *
 * Three separate things, each for its own reason:
 *
 * BOUNDED — the text can be the gateway's own. A 200 with an HTML body makes
 * `response.json()` throw a SyntaxError carrying a body snippet, so this keeps the
 * first line and 200 characters: enough to diagnose, never a whole response body.
 *
 * REDACTED — this code does not build the credential into any message, but it does not
 * author every message it logs either. An HTTP library, an agent or a proxy may embed a
 * request header or a URL with userinfo in ITS error, and "we never put it there" is
 * not a guarantee about text we did not write. So the credential is struck from the
 * line before it is logged, whatever produced it. Cheap, and it fails safe.
 *
 * LONGEST-FIRST — a short secret that is a substring of a longer one must not leave the
 * longer one partly intact.
 */
function oneLine(error: unknown, secrets: readonly (string | undefined)[] = []): string {
  const line = (error instanceof Error ? error.message : String(error))
    .split("\n")[0]!
    .slice(0, 200);
  return [...secrets]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.split(secret).join("***REDACTED***"), line);
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

  let plan;
  try {
    plan = await discoverComputeFleet({
      baseUrl: env.OMNIROUTE_BASE_URL!,
      credential: env.OMNIROUTE_API_KEY!,
      options: { runtime: "binary", capabilities: [...DEFAULT_COMPUTE_CAPABILITIES] },
      workers: container.workerRegistryStore,
    });
  } catch (error) {
    const outcome = {
      status: "PROVIDER_UNAVAILABLE",
      error: oneLine(error, [env.OMNIROUTE_API_KEY]),
    } as const;
    log(outcome);
    return outcome;
  }

  try {
    const result = await applyComputeBootstrap(container.workerRegistration, plan);
    const outcome = { status: "APPLIED", source: plan.source, result } as const;
    log(outcome);
    return outcome;
  } catch (error) {
    const outcome = {
      status: "WRITE_FAILED",
      source: plan.source,
      error: oneLine(error, [env.OMNIROUTE_API_KEY]),
      /* How far it got, so a partial reconciliation is visible rather than guessed at. */
      registered: (await container.workerRegistryStore.list()).length,
    } as const;
    log(outcome);
    return outcome;
  }
}

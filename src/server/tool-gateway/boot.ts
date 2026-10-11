import type { AutonomyRecoverySweepResult } from "@/server/autonomy/autonomy-recovery-sweeper";
import type { Container } from "@/server/container";

import { getToolGatewayRuntime } from "./app";
import type { ToolGatewayRuntime, ToolReconciliationReport } from "./composition";
import { ensureRuntimeAgent, isAgentRegistration } from "./runtime-agent";

/**
 * TOOL GATEWAY AT PRODUCTION BOOT (decision 0059 §6: "It runs at boot").
 *
 * Before this, the runtime was composed lazily by the first `/api/tool-gateway/*` request:
 * a deployment nobody administered had no health evidence at all, and nothing reconciled
 * orphaned executions. `startProductionServices` now calls this once.
 *
 *   1. registers the runtime's tool identity (`agent-icos-runtime`, level 0) — insert-only,
 *      NO grant (decision 0058: nothing is granted implicitly);
 *   2. builds THE process runtime through `getToolGatewayRuntime` — the same memo the admin
 *      routes use, so there is never a second gateway — whose build runs the boot
 *      reconciliation (health probes written to `tool_connector_health`, in-flight effects
 *      settled).
 *
 * Fail-soft by design: the tool plane is not on the critical path of missions, so an
 * unreadable `ICOS_TOOL_GATEWAY_CONFIG` must not stop the autonomy runtime. The failure is
 * reported with its cause (no secret: config values never hold one, decision 0059 §1) and
 * the self-model keeps reporting tools as not connected, which is then the truth.
 */
export interface ToolGatewayBootReport {
  runtimeAgent: "created" | "present" | "unavailable";
  reconciled: boolean;
  error?: string;
}

export async function bootToolGateway(
  container: Container,
  getRuntime: (c: Container) => Promise<ToolGatewayRuntime> = getToolGatewayRuntime,
): Promise<ToolGatewayBootReport> {
  let runtimeAgent: ToolGatewayBootReport["runtimeAgent"] = "unavailable";
  try {
    if (isAgentRegistration(container.agents)) {
      runtimeAgent = await ensureRuntimeAgent(container.agents);
    }
    await getRuntime(container);
    return { runtimeAgent, reconciled: true };
  } catch (error) {
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`TOOL_GATEWAY_BOOT_FAILED ${cause.slice(0, 300)}`);
    return { runtimeAgent, reconciled: false, error: cause.slice(0, 300) };
  }
}

/** How often the periodic pass re-probes health and settles orphans (well under the 15 min TTL). */
export const DEFAULT_TOOL_RECONCILIATION_INTERVAL_MS = 5 * 60_000;

/**
 * PERIODIC RECONCILIATION on the EXISTING production tick.
 *
 * Why not a durable scheduler job: `scheduled_jobs.kind` is closed by a DB CHECK, and adding
 * `reconcile_tools` needs a migration and the scheduler lane's enum — for work that is
 * idempotent, per-process by nature (connector health and quota windows are per process,
 * decision 0058 "Consequences") and cheap to repeat. So this rides `sweepAll` in
 * `createRecoveryScheduler`, the same timer every other recovery pass uses, throttled here
 * so the 30 s tick does not probe providers every 30 s. Failures are reported under the
 * entry's name by `sweepAll`, never swallowed.
 *
 * The runtime is resolved through the same memo as the routes and the boot.
 */
export function toolReconciliationSweeper(
  container: Container,
  options: {
    intervalMs?: number;
    now?: () => number;
    getRuntime?: (c: Container) => Promise<ToolGatewayRuntime>;
  } = {},
): { sweep(): Promise<AutonomyRecoverySweepResult> } {
  const intervalMs = options.intervalMs ?? DEFAULT_TOOL_RECONCILIATION_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const getRuntime = options.getRuntime ?? getToolGatewayRuntime;
  // Boot already reconciled (`bootToolGateway`): the first periodic pass is one interval later.
  let lastRunAt = now();
  return {
    async sweep() {
      const at = now();
      if (at - lastRunAt < intervalMs) {
        return { discovered: 0, attempted: 0, succeeded: 0, failed: 0, failures: [] };
      }
      lastRunAt = at;
      const report: ToolReconciliationReport = await (
        await getRuntime(container)
      ).reconciliation.runOnce();
      const settled = report.tenants.reduce((n, t) => n + t.settledExecutions, 0);
      return {
        discovered: report.tenants.length,
        attempted: settled,
        succeeded: settled,
        failed: 0,
        failures: [],
      };
    },
  };
}

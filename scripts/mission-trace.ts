/**
 * Mission trace (P0 traceability): the ordered decision history of ONE mission and the cost
 * the spend ledger attributes to it.
 *
 * READ-ONLY. A thin CLI over `getMissionTrace` (src/server/mission/mission-trace.ts), which only
 * reads the existing repositories: audit journal, dispatch ledger, execution results, review
 * decisions, QC jobs, workspace registry, spend ledger. Nothing is written, nothing is started.
 * No secret is read or printed (ledger rows carry token counts and model ids only).
 *
 * Requires PERSISTENCE=postgres.
 *
 * Usage:
 *   pnpm mission:trace <missionId>          # human-readable timeline + cost
 *   pnpm mission:trace <missionId> --json   # the full trace as JSON
 */
import { loadEnv } from "@/config/env";
import { createContainer } from "@/server/container";
import {
  formatMissionTrace,
  getMissionTrace,
  missionTraceDepsFromContainer,
} from "@/server/mission/mission-trace";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a.startsWith("-") && a !== "--json");
  const ids = args.filter((a) => !a.startsWith("-"));
  if (unknown.length > 0 || ids.length !== 1) {
    throw new Error("Usage: pnpm mission:trace <missionId> [--json]");
  }
  const env = loadEnv();
  if (env.PERSISTENCE !== "postgres") throw new Error("PERSISTENCE=postgres est requis.");

  const container = await createContainer({ env });
  try {
    const trace = await getMissionTrace(missionTraceDepsFromContainer(container), ids[0]!);
    if (!trace) throw new Error(`MISSION_NOT_FOUND: ${ids[0]}`);
    console.log(
      args.includes("--json") ? JSON.stringify(trace, null, 2) : formatMissionTrace(trace),
    );
  } finally {
    await container.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "MISSION_TRACE_FAILED");
  process.exit(1);
});

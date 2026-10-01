/**
 * Explicit launch-recovery lever — a THIN CLI adapter around the SAME
 * `cognitiveLaunchRecoverySweeper` the production recovery tick runs. No second recovery
 * engine, no business logic here.
 *
 * Why it exists: launch recovery used to fire while `cognitiveRuntimeFor(...)` was composed,
 * so a mere GET could relaunch an approved proposal. That is fixed, and the sweeper now runs
 * only on the production timer (NODE_ENV=production + PERSISTENCE=postgres). Outside
 * production — `next dev`, `scripts/voice-server.ts` — nothing would recover an interrupted
 * launch and there would be no way to ask for it. This is that way.
 *
 * Usage: pnpm cognitive:recover-launches
 * Requires PERSISTENCE=postgres (fail closed: there is nothing to recover in memory mode).
 */
import { loadEnv } from "@/config/env";
import { cognitiveLaunchRecoverySweeper } from "@/server/cognitive/launch-recovery-sweeper";
import { createContainer } from "@/server/container";

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.PERSISTENCE !== "postgres") throw new Error("PERSISTENCE=postgres est requis.");

  const container = await createContainer({ env });
  try {
    const result = await cognitiveLaunchRecoverySweeper(container).sweep();
    console.log(JSON.stringify(result));
  } finally {
    await container.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "échec de la récupération");
  process.exit(1);
});

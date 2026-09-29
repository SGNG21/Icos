/**
 * Compute availability snapshot (decision 0054) — printed before any real self-build run.
 *
 * Reads OmniRoute's live model list through ICOS's own configuration (OMNIROUTE_BASE_URL,
 * OMNIROUTE_API_KEY) and reports, per logical family, whether a model is served and which ids.
 * The credential is sent to OmniRoute and never printed. Read-only: registers nothing.
 *
 * Usage: pnpm compute:snapshot
 */
import { loadEnv } from "@/config/env";
import { computeSnapshot, listOmniRouteModels } from "@/server/workers/compute-fleet";

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.OMNIROUTE_BASE_URL || !env.OMNIROUTE_API_KEY) {
    throw new Error(
      "COMPUTE_SNAPSHOT_UNCONFIGURED: OMNIROUTE_BASE_URL and OMNIROUTE_API_KEY are required",
    );
  }
  const ids = await listOmniRouteModels({
    baseUrl: env.OMNIROUTE_BASE_URL,
    credential: env.OMNIROUTE_API_KEY,
  });
  /* The ORIGIN only: a configured URL could carry userinfo or a key in its query string. */
  const source = new URL(env.OMNIROUTE_BASE_URL).origin;
  console.log(JSON.stringify(computeSnapshot(source, ids), null, 2));
}

main().catch((error: unknown) => {
  /* The message only: a stack or a request object could carry the credential. */
  console.error(error instanceof Error ? error.message : "COMPUTE_SNAPSHOT_FAILED");
  process.exit(1);
});

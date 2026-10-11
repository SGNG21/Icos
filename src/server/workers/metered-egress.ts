/**
 * THE METER A WORKER'S EGRESS SPENDS THROUGH, composed for the Temporal worker process.
 *
 * The web container composes `composeSpendMeters` once for ICOS's own calls; the execution
 * worker is a separate process with no container, so it composes the SAME function here, over
 * the same `DATABASE_URL`, the same `ICOS_GOAL_MAX_TOTAL_TOKENS` default and the same
 * `ICOS_MAX_OUTPUT_TOKENS` ceiling. One ledger, one reservation store, one cap policy: a
 * worker's model calls and the reviewer's draw on the same goal window.
 *
 * No database means nothing to meter against, and an unmetered worker is exactly what this
 * exists to prevent — so it refuses (`WORKER_EGRESS_UNMETERABLE`) rather than falling back.
 */
import { DEFAULT_GOAL_MAX_TOTAL_TOKENS, composeSpendMeters } from "@/server/budget/compose-spend";
import { createDatabase } from "@/server/database/client";

let composed: { url: string; mission: typeof fetch } | null = null;

function positiveInt(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The goal-capped, reserving `fetch` for worker egress. Throws when it cannot be metered. */
export function workerEgressFetch(env: NodeJS.ProcessEnv = process.env): typeof fetch {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error("WORKER_EGRESS_UNMETERABLE: DATABASE_URL absent, worker model spend cannot be capped");
  }
  if (composed?.url !== url) {
    const maxOutputTokens = positiveInt(env.ICOS_MAX_OUTPUT_TOKENS);
    const meters = composeSpendMeters({
      /* A small pool: one proxy per running execution, a handful of ledger writes each. */
      db: createDatabase(url, { max: 4 }).db,
      maxTotalTokensPerGoal:
        positiveInt(env.ICOS_GOAL_MAX_TOTAL_TOKENS) ?? DEFAULT_GOAL_MAX_TOTAL_TOKENS,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    });
    composed = { url, mission: meters.mission };
  }
  return composed.mission;
}

/** Where the gateway is. Required: an executor with metered egress has no other road out. */
export function workerEgressUpstream(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: string;
  apiKey?: string;
} {
  const baseUrl = env.OMNIROUTE_BASE_URL;
  if (!baseUrl) {
    throw new Error("WORKER_EGRESS_UNMETERABLE: OMNIROUTE_BASE_URL absent");
  }
  return { baseUrl, ...(env.OMNIROUTE_API_KEY ? { apiKey: env.OMNIROUTE_API_KEY } : {}) };
}

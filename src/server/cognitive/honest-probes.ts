import { and, count as sqlCount, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";

import { decideExecutable, type ExecutableDecision } from "@/core/execution/executable-policy";
import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import { DISPATCHABLE_STATUSES } from "@/core/tool-gateway/model";
import type { Database } from "@/server/database/client";
import { toolConnectorHealth, toolGrants } from "@/server/database/tool-gateway-schema";
import { declaredRealtimeInstanceIds } from "@/server/tool-gateway/realtime";
import { REALTIME_TOOL_PERMISSIONS, RUNTIME_AGENT_ID } from "@/server/tool-gateway/runtime-agent";
import { parseWorkerExecCommands } from "@/server/workers/execution/exec-command-config";
import type { SandboxBackendDetection } from "@/server/workers/process/sandbox-backend";

/**
 * HONEST PROBES (decision 0062: the self-model is measured, not declared).
 *
 * The probes wired today over-count: every `tool_grants` row (revoked and expired
 * included), every `tool_connector_health` row (DISABLED / AUTH_FAILED included), realtime
 * connectors without asking whether anyone may call them, and every DECLARED executor
 * whether or not the executable policy and a sandbox would let it launch. Each function
 * below measures what the gateway / execution path would actually ALLOW right now.
 *
 * Exported for the cognitive composition to wire; nothing here is wired by this module.
 * Tenant: the single-tenant shim, as everywhere in the tool plane (COMPLIANCE-1).
 */

const DISPATCHABLE = [...DISPATCHABLE_STATUSES];

/** Grants the gateway would honour now: not revoked, not expired (`grantCovers`). */
export async function countLiveToolGrants(db: Database, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sqlCount() })
    .from(toolGrants)
    .where(
      and(
        eq(toolGrants.tenantId, CURRENT_SINGLE_TENANT_ID),
        isNull(toolGrants.revokedAt),
        or(isNull(toolGrants.expiresAt), gt(toolGrants.expiresAt, now)),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Connector instances whose CURRENT probe evidence allows dispatch: a dispatchable status
 * (`DISPATCHABLE_STATUSES`), unexpired evidence, and no live provider throttle — the same
 * reading as `effectiveConnectorStatus`. Missing or stale evidence counts as nothing.
 */
export async function countDispatchableConnectors(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const [row] = await db
    .select({ n: sqlCount() })
    .from(toolConnectorHealth)
    .where(
      and(
        eq(toolConnectorHealth.tenantId, CURRENT_SINGLE_TENANT_ID),
        inArray(toolConnectorHealth.status, DISPATCHABLE),
        gt(toolConnectorHealth.expiresAt, now),
        or(
          isNull(toolConnectorHealth.rateLimitedUntil),
          lte(toolConnectorHealth.rateLimitedUntil, now),
        ),
      ),
    );
  return Number(row?.n ?? 0);
}

// ── realtime ────────────────────────────────────────────────────────────────

let realtimeCallerWired = false;

/**
 * Set by `buildRealtimeContextSource`: a realtime source exists in this process only when
 * the cognitive composition built one. Before that, nothing in ICOS would ever call the
 * web tools, whatever is configured or granted.
 */
export function markRealtimeCallerWired(): void {
  realtimeCallerWired = true;
}

/** Test seam only. */
export function resetRealtimeCallerWiredForTests(): void {
  realtimeCallerWired = false;
}

export interface RealtimeMeasurement {
  /** Enabled web/search instances in `ICOS_TOOL_GATEWAY_CONFIG`; undefined = unreadable. */
  declared: number | undefined;
  /** Declared instances with CURRENT dispatchable probe evidence; undefined = unmeasurable. */
  healthy: number | undefined;
  /** A LIVE grant exists for `agent-icos-runtime` on `web-search:SEARCH` or `web-fetch:READ`. */
  runtimeAgentGranted: boolean;
  /** A realtime context source was built in this process (see `markRealtimeCallerWired`). */
  callerWired: boolean;
}

/**
 * Realtime access is real only when ALL hold: a web/search instance is declared and probed
 * usable, the runtime identity holds a live grant for it, and a caller exists. Each part is
 * reported separately so the self-model can say WHICH is missing. Fail closed: a failing
 * query yields `undefined` counts and `false` booleans, never an optimistic answer.
 */
export async function measureRealtime(
  db: Database,
  env: Readonly<Record<string, string | undefined>>,
  now: Date = new Date(),
): Promise<RealtimeMeasurement> {
  const callerWired = realtimeCallerWired;
  const ids = declaredRealtimeInstanceIds(env.ICOS_TOOL_GATEWAY_CONFIG);
  let healthy: number | undefined;
  if (ids === undefined) healthy = undefined;
  else if (ids.length === 0) healthy = 0;
  else {
    try {
      const [row] = await db
        .select({ n: sqlCount() })
        .from(toolConnectorHealth)
        .where(
          and(
            eq(toolConnectorHealth.tenantId, CURRENT_SINGLE_TENANT_ID),
            inArray(toolConnectorHealth.instanceId, ids),
            inArray(toolConnectorHealth.status, DISPATCHABLE),
            gt(toolConnectorHealth.expiresAt, now),
            or(
              isNull(toolConnectorHealth.rateLimitedUntil),
              lte(toolConnectorHealth.rateLimitedUntil, now),
            ),
          ),
        );
      healthy = Number(row?.n ?? 0);
    } catch {
      healthy = undefined;
    }
  }

  let runtimeAgentGranted = false;
  try {
    const rows = await db
      .select({ toolId: toolGrants.toolId, action: toolGrants.action })
      .from(toolGrants)
      .where(
        and(
          eq(toolGrants.tenantId, CURRENT_SINGLE_TENANT_ID),
          eq(toolGrants.agentId, RUNTIME_AGENT_ID),
          isNull(toolGrants.revokedAt),
          or(isNull(toolGrants.expiresAt), gt(toolGrants.expiresAt, now)),
        ),
      );
    runtimeAgentGranted = rows.some((r) =>
      REALTIME_TOOL_PERMISSIONS.some((p) => p.toolId === r.toolId && p.action === r.action),
    );
  } catch {
    runtimeAgentGranted = false;
  }

  return { declared: ids?.length, healthy, runtimeAgentGranted, callerWired };
}

// ── executors ───────────────────────────────────────────────────────────────

/**
 * Runtimes the Execution Gateway could actually LAUNCH: declared in
 * `ICOS_WORKER_EXEC_COMMANDS`, whose command passes the executable allowlist
 * (`decideExecutable`, default deny), and only when a confinement backend was PROVEN on this
 * host (`sandboxBackend()`). No sandbox → 0: an executor that would be refused at launch is
 * not a capability. Malformed configuration → undefined (unmeasurable, fail closed).
 *
 * `decide` is injectable because the real allowlist is frozen at module load.
 */
export function countLaunchableExecutors(
  env: Readonly<Record<string, string | undefined>>,
  sandboxDetection: SandboxBackendDetection,
  decide: (command: string, args: readonly string[]) => ExecutableDecision = decideExecutable,
): number | undefined {
  let commands: ReturnType<typeof parseWorkerExecCommands>;
  try {
    commands = parseWorkerExecCommands(env.ICOS_WORKER_EXEC_COMMANDS);
  } catch {
    return undefined;
  }
  if (!sandboxDetection.backend) return 0;
  return Object.values(commands).filter((c) => c !== undefined && decide(c.command, c.args).allowed)
    .length;
}

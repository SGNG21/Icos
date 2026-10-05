import { and, eq, gt, inArray } from "drizzle-orm";

import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import type { Database } from "@/server/database/client";
import { toolConnectorHealth } from "@/server/database/tool-gateway-schema";

import { toolGatewayConfigSchema } from "./composition";

/**
 * WHAT COUNTS AS REALTIME ACCESS (decision 0067 item 5, self-model `external.realtime`).
 *
 * Only a connector that reaches the live web or a search provider. `http` (one base URL),
 * `local-files`, and above all a model provider do NOT count: a model answers from weights.
 */
export const REALTIME_CONNECTOR_IDS: ReadonlySet<string> = new Set(["web", "search"]);

/** Health statuses that mean "do not claim this instance". */
const DEAD = ["AUTH_FAILED", "DISABLED"] as const;

/**
 * Declared, enabled web/search instances from `ICOS_TOOL_GATEWAY_CONFIG`. `undefined` when
 * the config is unreadable: an unmeasurable count must fail closed, never read as zero.
 */
export function declaredRealtimeInstanceIds(raw: string | undefined): string[] | undefined {
  if (!raw) return [];
  try {
    const parsed = toolGatewayConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    return parsed.data.instances
      .filter((i) => i.enabled && REALTIME_CONNECTOR_IDS.has(i.connectorId))
      .map((i) => i.instanceId);
  } catch {
    return undefined;
  }
}

/**
 * Declared instances minus those whose last non-expired health probe says they cannot be
 * used. A declared instance with NO health row yet still counts: the web connector needs no
 * provider, and the gateway probes at its own boot, which may not have happened in this
 * process. Measured per call, so installing an instance changes the answer at once.
 */
export async function countRealtimeConnectors(
  db: Database,
  env: Readonly<Record<string, string | undefined>>,
  now: () => Date = () => new Date(),
): Promise<number | undefined> {
  const declared = declaredRealtimeInstanceIds(env.ICOS_TOOL_GATEWAY_CONFIG);
  if (declared === undefined) return undefined;
  if (declared.length === 0) return 0;
  const dead = await db
    .select({ instanceId: toolConnectorHealth.instanceId })
    .from(toolConnectorHealth)
    .where(
      and(
        eq(toolConnectorHealth.tenantId, CURRENT_SINGLE_TENANT_ID),
        inArray(toolConnectorHealth.instanceId, declared),
        inArray(toolConnectorHealth.status, [...DEAD]),
        gt(toolConnectorHealth.expiresAt, now()),
      ),
    );
  const unusable = new Set(dead.map((r) => r.instanceId));
  return declared.filter((id) => !unusable.has(id)).length;
}

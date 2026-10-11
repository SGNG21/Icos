import type { Role } from "@/core/identity";
import type { ActionClass } from "@/core/tool-gateway/model";
import type { AdminHumanUser, AgentRegistration } from "@/server/repositories/ports";

import type { ToolGateway } from "./gateway";
import { toolTenantOf } from "./app";
import { REALTIME_TOOL_PERMISSIONS, RUNTIME_AGENT_ID, ensureRuntimeAgent } from "./runtime-agent";

/**
 * THE OWNER'S ACT of enabling realtime access (decision 0058: nothing is granted implicitly).
 *
 * Run by a human, never at boot: `pnpm tools:grant-realtime --reason "…"`. It goes through the
 * gateway's own `setGrant` — the exact path behind `POST /api/tool-gateway/grants` — so the
 * owner's permission (`agentCapabilities.write`) is checked, the grantor and the mandatory
 * reason are recorded, and every grant (or refusal) is audited as `tool.grant.changed` /
 * `tool.request.denied`. Idempotent: re-running re-affirms the same two exact grants.
 */
export interface RealtimeGrantRequest {
  /** The human performing the act, resolved from the user registry (never a literal). */
  readonly owner: Pick<AdminHumanUser, "id" | "status" | "role">;
  readonly reason: string;
  readonly expiresAt?: string;
  /** Default: both `web-search:SEARCH` and `web-fetch:READ`. */
  readonly only?: "search" | "fetch";
}

export interface RealtimeGrantResult {
  agentId: string;
  runtimeAgent: "created" | "present";
  grants: { toolId: string; action: ActionClass; ok: boolean; message?: string }[];
}

export async function grantRealtimeToRuntime(
  deps: { gateway: Pick<ToolGateway, "setGrant">; agents: AgentRegistration },
  request: RealtimeGrantRequest,
): Promise<RealtimeGrantResult> {
  if (!request.reason?.trim()) throw new Error("REALTIME_GRANT_REASON_REQUIRED");
  if (request.owner.status !== "active") throw new Error("REALTIME_GRANT_OWNER_NOT_ACTIVE");
  const runtimeAgent = await ensureRuntimeAgent(deps.agents);
  const roles: Role[] = request.owner.role ? [request.owner.role] : [];
  const wanted = REALTIME_TOOL_PERMISSIONS.filter(
    (p) =>
      !request.only ||
      (request.only === "search" ? p.toolId === "web-search" : p.toolId === "web-fetch"),
  );
  const grants: RealtimeGrantResult["grants"] = [];
  for (const p of wanted) {
    const r = await deps.gateway.setGrant(
      { kind: "human", id: request.owner.id, roles },
      {
        tenantId: toolTenantOf(),
        agentId: RUNTIME_AGENT_ID,
        toolId: p.toolId,
        action: p.action,
        reason: request.reason.trim(),
        expiresAt: request.expiresAt,
      },
      "grant",
    );
    grants.push(
      r.ok ? { ...p, ok: true } : { ...p, ok: false, message: `${r.failureClass}: ${r.message}` },
    );
  }
  return { agentId: RUNTIME_AGENT_ID, runtimeAgent, grants };
}

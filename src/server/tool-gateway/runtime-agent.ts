import { agentSchema, type Agent } from "@/core/contracts";
import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import type { ActionClass, ToolCaller } from "@/core/tool-gateway/model";
import type { AgentRegistration } from "@/server/repositories/ports";

/**
 * THE RUNTIME'S OWN TOOL IDENTITY.
 *
 * The gateway resolves every caller in the `agents` registry (`ToolGateway.resolveAgent`,
 * `decideToolRequest`: unknown agent → deny). The cognitive runtime is a trusted system
 * component (`RUNTIME_COMPONENTS` in workforce/principals.ts) but had no agent record, so
 * nothing it asked for could ever be decided — not even refused with a useful reason.
 *
 * This is that record, deliberately weak:
 *   - `authorizationLevel: 0` — the kernel floor admits `read_only` (LOW) tools only; any
 *     MEDIUM+ tool is refused as `insufficient_authorization` whatever is granted;
 *   - NO GRANT is created here or at boot (decision 0058: nothing is granted implicitly).
 *     The owner grants `web-search:SEARCH` / `web-fetch:READ` explicitly, with a reason,
 *     through `POST /api/tool-gateway/grants` or `pnpm tools:grant-realtime`.
 *
 * Registering the identity at boot grants nothing: without a grant every call is a
 * `PERMISSION_DENIED`, audited, which is exactly what the self-model must then report.
 */
export const RUNTIME_AGENT_ID = "agent-icos-runtime";

export const RUNTIME_AGENT: Agent = agentSchema.parse({
  id: RUNTIME_AGENT_ID,
  name: "ICOS runtime",
  role: "Système — runtime cognitif (outils gouvernés en lecture)",
  status: "available",
  authorizationLevel: 0,
  description:
    "Identité système du runtime cognitif auprès de la Tool Gateway. Niveau 0 (lecture seule) ; " +
    "aucune permission sans accord explicite du propriétaire.",
});

/** The only permissions realtime context asks for. Exact (tool, action) pairs, no wildcard. */
export const REALTIME_TOOL_PERMISSIONS: readonly { toolId: string; action: ActionClass }[] = [
  { toolId: "web-search", action: "SEARCH" },
  { toolId: "web-fetch", action: "READ" },
];

/** The trusted caller the runtime presents. Tenant: the single-tenant shim (COMPLIANCE-1). */
export function runtimeToolCaller(tenantId: string = CURRENT_SINGLE_TENANT_ID): ToolCaller {
  return { tenantId, agentId: RUNTIME_AGENT_ID };
}

/** Idempotent, insert-only registration through the canonical agents repository. */
export function ensureRuntimeAgent(agents: AgentRegistration): Promise<"created" | "present"> {
  return agents.ensureRegistered(RUNTIME_AGENT);
}

export function isAgentRegistration(value: unknown): value is AgentRegistration {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<AgentRegistration>).ensureRegistered === "function"
  );
}

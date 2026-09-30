import { loadEnv } from "@/config/env";
import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import type { Container } from "@/server/container";
import { createDatabase } from "@/server/database/client";
import { PersistenceUnavailableError } from "@/server/database/errors";
import { resolvePersistence } from "@/server/persistence";

import { composeToolGateway, type ToolGatewayRuntime } from "./composition";

/**
 * Application accessor used by the Tool Gateway route handlers, so this lane
 * wires itself WITHOUT editing the shared `container.ts`. It reuses the
 * container's agent lookup and audit repository.
 *
 * INTEGRATION: when the central integrator adds the runtime to the container,
 * it should call `composeToolGateway` with the container's own database handle
 * and replace this accessor; this module then only keeps `toolTenantOf`.
 *
 * ponytail: under PERSISTENCE=postgres this opens a small dedicated pool (max 3)
 * because the container does not expose its handle yet.
 */
/** Same memo convention as the container (`__icosContainerPromise__`): one per process, test-injectable. */
export const TOOL_GATEWAY_RUNTIME_KEY = "__icosToolGatewayRuntime__";
const slot = globalThis as Record<string, unknown>;

export function getToolGatewayRuntime(container: Container): Promise<ToolGatewayRuntime> {
  const existing = slot[TOOL_GATEWAY_RUNTIME_KEY] as Promise<ToolGatewayRuntime> | undefined;
  if (existing) return existing;
  const created = build(container).catch((e) => {
    delete slot[TOOL_GATEWAY_RUNTIME_KEY];
    throw e;
  });
  slot[TOOL_GATEWAY_RUNTIME_KEY] = created;
  return created;
}

async function build(container: Container): Promise<ToolGatewayRuntime> {
  const env = loadEnv();
  const backend = resolvePersistence(env);
  let config: unknown = {};
  const raw = process.env.ICOS_TOOL_GATEWAY_CONFIG;
  if (raw) {
    try {
      config = JSON.parse(raw);
    } catch {
      throw new Error("ICOS_TOOL_GATEWAY_CONFIG is not valid JSON");
    }
  }
  let db;
  if (backend === "postgres") {
    if (!env.DATABASE_URL) throw new PersistenceUnavailableError("DATABASE_URL absent");
    db = createDatabase(env.DATABASE_URL, { max: 3 }).db;
  }
  const rt = composeToolGateway({
    backend,
    db,
    agents: container.agents,
    audit: container.audit,
    config,
  });
  // Boot reconciliation: health evidence before any dispatch, in-flight effects settled.
  await rt.reconciliation.runOnce();
  return rt;
}

/**
 * The tenant a request acts in. ICOS has no TenantContext yet (COMPLIANCE-1):
 * this is the single-tenant shim, NOT a membership check. When COMPLIANCE-1
 * lands, resolve it from the session and verify membership here.
 */
export function toolTenantOf(): string {
  return CURRENT_SINGLE_TENANT_ID;
}

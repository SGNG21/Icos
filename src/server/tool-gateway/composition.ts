import { z } from "zod";

import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import { containsSecret } from "@/core/memory/rules";
import {
  duplicatePolicySchema,
  type ConnectorInstance,
  type DuplicatePolicy,
} from "@/core/tool-gateway/model";
import {
  decideToolRequest,
  effectiveApproval,
  effectiveConnectorStatus,
  effectiveDuplicatePolicy,
  grantCovers,
} from "@/core/tool-gateway/policy";
import type { Database } from "@/server/database/client";
import type { AgentLookup, AuditRepository } from "@/server/repositories/ports";
import type { JobHandler } from "@/server/scheduler/durable-scheduler";

import { NOT_CONNECTED_DEFINITIONS, notConnected } from "./connectors/catalog";
import { httpConnector } from "./connectors/http";
import { localFilesConnector } from "./connectors/local-files";
import { searchConnector } from "./connectors/search";
import { webConnector } from "./connectors/web";
import { ToolGateway, type InstanceHealthView } from "./gateway";
import {
  ConnectorRegistry,
  EnvCredentialResolver,
  InMemoryConnectorHealthStore,
  InMemoryToolApprovalStore,
  InMemoryToolExecutionStore,
  InMemoryToolGrantStore,
} from "./in-memory";
import {
  PostgresConnectorHealthStore,
  PostgresToolApprovalStore,
  PostgresToolExecutionStore,
  PostgresToolGrantStore,
} from "./postgres-stores";
import type {
  Connector,
  ConnectorHealthStore,
  CredentialResolver,
  ToolApprovalStore,
  ToolAuditPort,
  ToolExecutionStore,
  ToolGrantStore,
} from "./ports";

/**
 * Canonical composition of the Tool Gateway (decision 0059). The central
 * integrator calls `composeToolGateway` once with the SHARED services it
 * already owns (agent lookup, audit repository, database) — nothing here
 * creates a second audit log or a second agent registry.
 */

/**
 * Deployment configuration. Holds NO secret: credentials are bound by the NAME
 * of an environment variable; the value is read only by the resolver, at use.
 */
export const toolGatewayConfigSchema = z
  .object({
    instances: z
      .array(
        z
          .object({
            instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]+$/),
            connectorId: z.string().min(1),
            config: z
              .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
              .default({}),
            credentialRef: z
              .string()
              .regex(/^cred_[a-z0-9_-]{3,}$/)
              .optional(),
            credentialKind: z.string().min(1).default("api_key"),
            enabled: z.boolean().default(true),
          })
          .strict(),
      )
      .default([]),
    credentials: z
      .record(
        z.string().regex(/^cred_[a-z0-9_-]{3,}$/),
        z
          .object({
            // A dedicated namespace: a tool credential can never bind DATABASE_URL, auth secrets, …
            envVar: z.string().regex(/^ICOS_TOOL_CRED_[A-Z0-9_]+$/),
            expiresAt: z.iso.datetime({ offset: true }).optional(),
          })
          .strict(),
      )
      .default({}),
    /** `toolId:ACTION` → duplicate policy override. */
    duplicatePolicies: z.record(z.string(), duplicatePolicySchema).default({}),
    healthTtlSeconds: z
      .number()
      .int()
      .positive()
      .max(24 * 3600)
      .default(900),
  })
  .strict()
  .superRefine((c, ctx) => {
    // Connector config is free-form: it must not smuggle a secret (credentials go by env NAME).
    if (c.instances.some((i) => containsSecret(i.config))) {
      ctx.addIssue({ code: "custom", message: "tool gateway config must not contain secrets" });
    }
  });
export type ToolGatewayConfig = z.infer<typeof toolGatewayConfigSchema>;

export interface ToolGatewayRuntime {
  gateway: ToolGateway;
  registry: ConnectorRegistry;
  credentials: CredentialResolver;
  approvals: ToolApprovalStore;
  executions: ToolExecutionStore;
  grants: ToolGrantStore;
  health: ConnectorHealthStore;
  audit: ToolAuditPort;
  /** The pure authorization functions (the kernel floor is inside `decideToolRequest`). */
  policy: {
    decideToolRequest: typeof decideToolRequest;
    effectiveApproval: typeof effectiveApproval;
    effectiveDuplicatePolicy: typeof effectiveDuplicatePolicy;
    effectiveConnectorStatus: typeof effectiveConnectorStatus;
    grantCovers: typeof grantCovers;
  };
  reconciliation: ToolReconciliationService;
}

export interface ToolReconciliationReport {
  ranAt: string;
  tenants: { tenantId: string; health: InstanceHealthView[]; settledExecutions: number }[];
}

/**
 * The one reconciliation entry point: health evidence refresh + settlement of
 * orphaned/unknown side effects, for every configured tenant. Call it at boot,
 * from the EXISTING durable scheduler (see `jobHandler`), and after an
 * ambiguous execution. It schedules nothing itself.
 */
export class ToolReconciliationService {
  constructor(
    private readonly gateway: ToolGateway,
    private readonly registry: ConnectorRegistry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce(
    tenants: readonly string[] = this.registry.tenants(),
  ): Promise<ToolReconciliationReport> {
    const report: ToolReconciliationReport = { ranAt: this.now().toISOString(), tenants: [] };
    for (const tenantId of tenants) {
      const health = await this.gateway.probeHealth(tenantId);
      const settled = await this.gateway.reconcile(tenantId);
      report.tenants.push({ tenantId, health, settledExecutions: settled.length });
    }
    return report;
  }

  /**
   * A `JobHandler` for the existing Durable Scheduler. Registering it needs a
   * new `ScheduledJobKind` (e.g. `reconcile_tools`) — that enum and its CHECK
   * belong to the scheduler lane, so the integrator adds the kind and maps it here.
   */
  readonly jobHandler: JobHandler = async () => this.runOnce();
}

export interface ComposeToolGatewayDeps {
  backend: "memory" | "postgres";
  /** Required for `postgres`: the integrator's existing handle (no second pool needed). */
  db?: Database;
  agents: AgentLookup;
  audit: AuditRepository;
  config?: unknown;
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Test/extension seam: replaces the default connector set. */
  connectors?: readonly Connector[];
}

export function defaultConnectors(fetchImpl?: typeof fetch): Connector[] {
  return [
    localFilesConnector,
    httpConnector(fetchImpl),
    // Governed web read and search (decision 0067 item 5): READ/SEARCH, LOW, no approval.
    webConnector(fetchImpl),
    searchConnector(fetchImpl),
    ...NOT_CONNECTED_DEFINITIONS.map(notConnected),
  ];
}

export function composeToolGateway(deps: ComposeToolGatewayDeps): ToolGatewayRuntime {
  const config = toolGatewayConfigSchema.parse(deps.config ?? {});
  // ICOS is single-tenant until COMPLIANCE-1 provides a TenantContext: every
  // configured instance and credential belongs to the one shim tenant.
  const tenantId = CURRENT_SINGLE_TENANT_ID;

  const registry = new ConnectorRegistry();
  for (const i of config.instances) {
    const instance: ConnectorInstance = {
      instanceId: i.instanceId,
      connectorId: i.connectorId,
      tenantId,
      config: i.config,
      credential: i.credentialRef
        ? { ref: i.credentialRef, tenantId, kind: i.credentialKind }
        : undefined,
      enabled: i.enabled,
    };
    registry.register(instance);
  }
  const credentials = new EnvCredentialResolver(
    new Map(Object.entries(config.credentials).map(([ref, b]) => [ref, { tenantId, ...b }])),
    deps.env ?? process.env,
    deps.now,
  );

  let stores: {
    executions: ToolExecutionStore;
    approvals: ToolApprovalStore;
    grants: ToolGrantStore;
    health: ConnectorHealthStore;
  };
  if (deps.backend === "postgres") {
    if (!deps.db)
      throw new Error("composeToolGateway: postgres backend requires the shared db handle");
    stores = {
      executions: new PostgresToolExecutionStore(deps.db),
      approvals: new PostgresToolApprovalStore(deps.db),
      grants: new PostgresToolGrantStore(deps.db),
      health: new PostgresConnectorHealthStore(deps.db),
    };
  } else {
    stores = {
      // Same audit port as Postgres mode: one audit log, whatever the backend.
      executions: new InMemoryToolExecutionStore(deps.audit),
      approvals: new InMemoryToolApprovalStore(deps.audit),
      grants: new InMemoryToolGrantStore(deps.audit),
      health: new InMemoryConnectorHealthStore(),
    };
  }

  const gateway = new ToolGateway({
    connectors: deps.connectors ?? defaultConnectors(deps.fetchImpl),
    registry,
    agents: deps.agents,
    credentials,
    audit: deps.audit,
    duplicatePolicies: config.duplicatePolicies as Record<string, DuplicatePolicy>,
    healthTtlMs: config.healthTtlSeconds * 1000,
    now: deps.now,
    ...stores,
  });

  return {
    gateway,
    registry,
    credentials,
    audit: deps.audit,
    ...stores,
    policy: {
      decideToolRequest,
      effectiveApproval,
      effectiveDuplicatePolicy,
      effectiveConnectorStatus,
      grantCovers,
    },
    reconciliation: new ToolReconciliationService(gateway, registry, deps.now),
  };
}

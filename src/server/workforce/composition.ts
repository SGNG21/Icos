import { randomUUID } from "node:crypto";

import { loadWorkforceBootstrap, type OrganizationBounds } from "@/core/workforce/bootstrap";
import type { Database } from "@/server/database/client";

import { WorkforceAuthorityPort } from "./authority-port";
import { WorkforceComputePort } from "./compute-port";
import { InMemoryWorkforceStore } from "./in-memory-workforce-store";
import type { WorkforceStore } from "./ports";
import { PostgresWorkforceStore } from "./postgres-workforce-store";
import {
  createPrincipalAuthority,
  type PrincipalAuthority,
  type RuntimePrincipals,
  type SessionPrincipals,
} from "./principals";
import { WorkforceReadModel } from "./read-model";
import { WorkforceService } from "./workforce-service";

/**
 * COMPOSITION of the digital workforce (decision 0057 §integration). One call builds every
 * collaborator from one store, one clock, one id source and ONE principal authority — so a
 * principal issued here is the only kind the service, the ports and the read model accept.
 *
 * Integrator (container.ts, not edited by lane D):
 *   const workforce = createWorkforceRuntime({ store: createWorkforceStore(backend) });
 *   routes / cockpit   ← workforce.service, workforce.readModel, workforce.sessions
 *   CORE3 dispatch     ← workforce.compute,   workforce.runtime.system("core3-dispatch")
 *   Tool Gateway       ← workforce.authority, workforce.runtime.system("tool-gateway")
 *   Cognitive Runtime  ← workforce.authority, workforce.runtime.system("cognitive-runtime")
 * `workforce.runtime` must NEVER reach a route handler.
 */

export type WorkforceBackend = { kind: "memory" } | { kind: "postgres"; db: Database };

/** Explicit backend selection; no silent fallback from postgres to memory. */
export function createWorkforceStore(backend: WorkforceBackend): WorkforceStore {
  return backend.kind === "postgres"
    ? new PostgresWorkforceStore(backend.db)
    : new InMemoryWorkforceStore();
}

export interface WorkforceRuntimeOptions {
  store: WorkforceStore;
  bounds?: OrganizationBounds;
  now?: () => string;
  newId?: (prefix: string) => string;
  authority?: PrincipalAuthority;
}

export interface WorkforceRuntime {
  service: WorkforceService;
  readModel: WorkforceReadModel;
  compute: WorkforceComputePort;
  authority: WorkforceAuthorityPort;
  sessions: SessionPrincipals;
  runtime: RuntimePrincipals;
}

export function createWorkforceRuntime(options: WorkforceRuntimeOptions): WorkforceRuntime {
  const principals = options.authority ?? createPrincipalAuthority();
  const now = options.now ?? (() => new Date().toISOString());
  const store = options.store;
  const service = new WorkforceService({
    store,
    principals,
    bounds: options.bounds ?? loadWorkforceBootstrap().bounds,
    now,
    newId: options.newId ?? ((prefix) => `${prefix}-${randomUUID()}`),
  });
  return {
    service,
    readModel: new WorkforceReadModel({ store, principals, now }),
    compute: new WorkforceComputePort({ store, principals, service }),
    authority: new WorkforceAuthorityPort({ store, principals, now }),
    sessions: principals.sessions,
    runtime: principals.runtime,
  };
}

import { randomUUID } from "node:crypto";

import { loadWorkforceBootstrap, type OrganizationBounds } from "@/core/workforce/bootstrap";
import type { Database } from "@/server/database/client";

import { WorkforceAuthorityPort } from "./authority-port";
import { WorkforceComputePort } from "./compute-port";
import { workforceTaskCompute, type WorkforceTaskCompute } from "./core3-task-compute";
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
import { bootstrapWorkforce, type WorkforceBootstrapReport } from "./bootstrap-workforce";
import type { Principal } from "@/core/workforce/governance";

import { brainRegistry } from "./brain-registry";
import { chiefDelegation, reviewAssignmentTaskId, type ChiefDelegation } from "./chief-delegation";
import { WorkforceService } from "./workforce-service";

/**
 * COMPOSITION of the digital workforce (decision 0057 §integration). One call builds every
 * collaborator from one store, one clock, one id source and ONE principal authority — so a
 * principal issued here is the only kind the service, the ports and the read model accept.
 *
 * Integrator (container.ts, not edited by lane D):
 *   const workforce = createWorkforceRuntime({ store: createWorkforceStore(backend) });
 *   routes / cockpit   ← workforce.service, workforce.readModel, workforce.sessions
 *   CORE3 dispatch     ← workforce.core3Compute (SupervisorService's last argument)
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
  /**
   * The compute port ALREADY bound to the `core3-dispatch` system principal and this store —
   * what CORE3's dispatcher takes (`SupervisorService`'s last argument). Composed here so the
   * integrator needs neither the store nor `runtime`, which must never leave this root.
   */
  core3Compute: WorkforceTaskCompute;
  authority: WorkforceAuthorityPort;
  sessions: SessionPrincipals;
  runtime: RuntimePrincipals;
  /**
   * L'AMORÇAGE CANONIQUE des douze cerveaux, déjà lié à ce magasin (verrou C6).
   *
   * Composé ICI, et exposé comme une opération plutôt qu'en sortant le `store`, parce que
   * le magasin ne doit jamais quitter cette racine. Un acte d'administration, lancé par le
   * propriétaire : il ne s'exécute jamais au démarrage du runtime.
   */
  bootstrap: (admin: Principal, certifier: Principal) => Promise<WorkforceBootstrapReport>;
  /**
   * GOAL → CHIEF → CERVEAU → AFFECTATION, déjà lié à ce magasin (verrou C6). Le `chief` est
   * le principal qui délègue ; la gouvernance vérifie qu'il supervise bien les cerveaux
   * qu'il affecte, donc un autre principal ne pourrait rien accorder.
   */
  chiefDelegation: (chief: Principal) => ChiefDelegation;
  /**
   * LE RELECTEUR de la mission, tel que le Chief l'a affecté (décision 0070). Lu par le
   * `ReviewerService` au moment de la relecture LLM pour imputer la dépense au cerveau
   * relecteur ; `null` quand la mission n'a pas été déléguée.
   */
  reviewAssignmentFor: (
    missionId: string,
  ) => Promise<{ assignmentId: string; agentId: string } | null>;
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
  const compute = new WorkforceComputePort({ store, principals, service });
  return {
    service,
    readModel: new WorkforceReadModel({ store, principals, now }),
    compute,
    core3Compute: workforceTaskCompute({
      compute,
      store,
      system: principals.runtime.system("core3-dispatch"),
    }),
    authority: new WorkforceAuthorityPort({ store, principals, now }),
    sessions: principals.sessions,
    runtime: principals.runtime,
    bootstrap: (admin, certifier) => bootstrapWorkforce({ service, store, now }, admin, certifier),
    chiefDelegation: (chief) =>
      chiefDelegation({ registry: brainRegistry(store), service, store, chief }),
    reviewAssignmentFor: async (missionId) => {
      const tenantId = principals.runtime.system("core3-dispatch").tenantId;
      const taskId = reviewAssignmentTaskId(missionId);
      const live = (await store.listAssignments(tenantId)).find(
        (a) => a.missionId === missionId && a.taskId === taskId && a.status !== "cancelled",
      );
      return live ? { assignmentId: live.assignmentId, agentId: live.assigneeAgentId } : null;
    },
  };
}

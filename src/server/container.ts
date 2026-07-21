import { agentSchema, agentActionSchema, taskSchema } from "@/core/contracts";
import type { Agent, AgentAction, Task } from "@/core/contracts";
import { loadEnv, type Env } from "@/config/env";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryActionDecisionStore } from "@/server/services/in-memory/action-decision-store";
import { InMemoryActionRepository } from "@/server/services/in-memory/action-repository";
import { InMemoryAgentRepository } from "@/server/services/in-memory/agent-repository";
import { InMemoryApprovalRepository } from "@/server/services/in-memory/approval-repository";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import type {
  ActionRepository,
  AgentRepository,
  ApprovalRepository,
  AuditRepository,
  TaskRepository,
} from "@/server/repositories/ports";
import type { ActionDecisionUnitOfWork } from "@/server/uow/ports";
import { InMemoryActionDecisionUnitOfWork } from "@/server/uow/in-memory-action-decision-uow";
import { BackendNotImplementedError, resolvePersistence } from "@/server/persistence";
import { demoActions } from "@/features/actions/data";
import { demoAgents } from "@/features/agents/data";
import { demoTasks } from "@/features/tasks/data";

import { assertReferentialIntegrity } from "./referential-integrity";

export interface Container {
  agents: AgentRepository;
  tasks: TaskRepository;
  actions: ActionRepository;
  approvals: ApprovalRepository;
  audit: AuditRepository;
  decisionUow: ActionDecisionUnitOfWork;
}

export interface ContainerSeeds {
  agents: readonly Agent[];
  tasks: readonly Task[];
  actions: readonly AgentAction[];
}

const defaultSeeds: ContainerSeeds = {
  agents: demoAgents,
  tasks: demoTasks,
  actions: demoActions,
};

/**
 * Assemble un container in-memory neuf. Les seeds sont validés puis contrôlés en
 * intégrité référentielle : une incohérence lève, faisant échouer explicitement
 * la composition plutôt que de laisser passer un état incohérent.
 */
export function buildMemoryContainer(seeds: ContainerSeeds = defaultSeeds): Container {
  const agents = seeds.agents.map((agent) => agentSchema.parse(agent));
  const tasks = seeds.tasks.map((task) => taskSchema.parse(task));
  const actions = seeds.actions.map((action) => agentActionSchema.parse(action));

  assertReferentialIntegrity({ agents, tasks, actions });

  const auditLog = new InMemoryAuditLog();
  const store = new InMemoryActionDecisionStore(actions);

  return {
    agents: new InMemoryAgentRepository(agents),
    tasks: new InMemoryTaskRepository(auditLog, tasks),
    actions: new InMemoryActionRepository(store),
    approvals: new InMemoryApprovalRepository(store),
    audit: new InMemoryAuditRepository(auditLog),
    // L'UoW mémoire dépend des collaborateurs SYNCHRONES internes (store +
    // journal), afin de préserver sa section critique non interruptible.
    decisionUow: new InMemoryActionDecisionUnitOfWork(store, auditLog),
  };
}

export interface CreateContainerOptions {
  env?: Env;
  seeds?: ContainerSeeds;
}

/**
 * Crée un container selon le backend résolu depuis l'environnement.
 *
 * - `memory` : container in-memory (Lot 2A-1) ;
 * - `postgres` : lève `BackendNotImplementedError` (Lot 2A-2), sans jamais
 *   basculer silencieusement vers `memory`.
 *
 * Asynchrone par contrat : le backend PostgreSQL nécessitera une initialisation
 * réellement asynchrone derrière cette même fonction.
 */
export async function createContainer(options: CreateContainerOptions = {}): Promise<Container> {
  const env = options.env ?? loadEnv();
  const backend = resolvePersistence(env);

  if (backend === "postgres") {
    throw new BackendNotImplementedError(backend);
  }

  return buildMemoryContainer(options.seeds);
}

/**
 * Singleton mémoïsé sur `globalThis` sous forme de `Promise<Container>`.
 *
 * - les appels concurrents partagent une seule initialisation ;
 * - une initialisation réussie reste mémorisée ;
 * - une initialisation échouée LIBÈRE le cache (la promesse rejetée n'est pas
 *   figée), de sorte qu'un appel ultérieur puisse réussir après correction de
 *   la configuration.
 *
 * Comportement — état VOLATIL, jamais persistant :
 * - peut survivre à certains rechargements de modules en développement (HMR),
 *   sans garantie contractuelle ;
 * - réinitialisé au redémarrage, au déploiement, au démarrage à froid
 *   serverless ; chaque instance possède son propre état (aucune cohérence
 *   multi-instances) ;
 * - réservé au runtime Node.js ;
 * - backend `postgres` non encore implémenté (Lot 2A-2).
 */
const CONTAINER_KEY = "__icosContainerPromise__";

type GlobalWithContainer = typeof globalThis & { [CONTAINER_KEY]?: Promise<Container> };

export function getContainer(): Promise<Container> {
  const globalRef = globalThis as GlobalWithContainer;
  globalRef[CONTAINER_KEY] ??= createContainer().catch((error: unknown) => {
    // Ne pas figer une promesse rejetée : purge du cache pour permettre une
    // nouvelle tentative après correction.
    delete globalRef[CONTAINER_KEY];
    throw error;
  });
  return globalRef[CONTAINER_KEY];
}

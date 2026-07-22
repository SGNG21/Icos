import { sql } from "drizzle-orm";

import { agentSchema, agentActionSchema, taskSchema } from "@/core/contracts";
import type { Agent, AgentAction, Task } from "@/core/contracts";
import { loadEnv, type Env } from "@/config/env";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { createDatabase } from "@/server/database/client";
import { PersistenceUnavailableError } from "@/server/database/errors";
import { agents as agentsTable } from "@/server/database/schema";
import { InMemoryActionDecisionStore } from "@/server/services/in-memory/action-decision-store";
import { InMemoryActionRepository } from "@/server/services/in-memory/action-repository";
import { InMemoryAgentRepository } from "@/server/services/in-memory/agent-repository";
import { InMemoryApprovalRepository } from "@/server/services/in-memory/approval-repository";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { PostgresActionRepository } from "@/server/repositories/postgres/action-repository";
import { PostgresAgentRepository } from "@/server/repositories/postgres/agent-repository";
import { PostgresApprovalRepository } from "@/server/repositories/postgres/approval-repository";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import type {
  ActionRepository,
  AgentRepository,
  ApprovalRepository,
  AuditRepository,
  TaskRepository,
} from "@/server/repositories/ports";
import type { ActionDecisionUnitOfWork } from "@/server/uow/ports";
import { InMemoryActionDecisionUnitOfWork } from "@/server/uow/in-memory-action-decision-uow";
import { PostgresActionDecisionUnitOfWork } from "@/server/uow/postgres-action-decision-uow";
import { PersistenceConfigError, resolvePersistence } from "@/server/persistence";
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
  /** Libère les ressources (pool PostgreSQL). No-op pour le backend mémoire. */
  close: () => Promise<void>;
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
    close: async () => {},
  };
}

/**
 * Assemble le container PostgreSQL : un unique client partagé par les cinq
 * repositories et l'UoW. La connexion est vérifiée et le schéma sondé ; toute
 * indisponibilité lève (aucun fallback mémoire) après fermeture du pool
 * éventuellement ouvert. Les migrations ne sont PAS appliquées ici : elles
 * relèvent d'une commande explicite (`pnpm db:migrate`).
 */
export async function buildPostgresContainer(url: string): Promise<Container> {
  const handle = createDatabase(url);
  try {
    // Connectivité + présence du schéma en une sonde (échoue si la table
    // `agents` n'existe pas → schéma non migré).
    await handle.db
      .select({ probe: sql<number>`1` })
      .from(agentsTable)
      .limit(1);
  } catch {
    await handle.close().catch(() => {});
    throw new PersistenceUnavailableError("connexion impossible ou schéma absent");
  }

  return {
    agents: new PostgresAgentRepository(handle.db),
    tasks: new PostgresTaskRepository(handle.db),
    actions: new PostgresActionRepository(handle.db),
    approvals: new PostgresApprovalRepository(handle.db),
    audit: new PostgresAuditRepository(handle.db),
    decisionUow: new PostgresActionDecisionUnitOfWork(handle.db),
    close: handle.close,
  };
}

export interface CreateContainerOptions {
  env?: Env;
  seeds?: ContainerSeeds;
}

/**
 * Crée un container selon le backend résolu depuis l'environnement.
 *
 * - `memory` : container in-memory ;
 * - `postgres` : client PostgreSQL + repositories + UoW, après sonde de
 *   connexion et de schéma. Toute indisponibilité lève ; **aucun fallback
 *   mémoire**.
 *
 * `loadEnv()` est réellement invoqué pour la composition PostgreSQL.
 */
export async function createContainer(options: CreateContainerOptions = {}): Promise<Container> {
  const env = options.env ?? loadEnv();
  const backend = resolvePersistence(env);

  if (backend === "postgres") {
    if (!env.DATABASE_URL) {
      throw new PersistenceConfigError("DATABASE_URL est requis lorsque PERSISTENCE=postgres.");
    }
    return buildPostgresContainer(env.DATABASE_URL);
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
 * - pour le backend PostgreSQL, le pool est partagé via ce container ; une
 *   initialisation rejetée purge le cache.
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

/**
 * Ferme le container global mémoïsé (le cas échéant) et purge le cache. Destiné
 * aux tests pour éviter toute fuite de pool entre suites ; sans effet si aucun
 * container n'a été initialisé.
 */
export async function resetContainer(): Promise<void> {
  const globalRef = globalThis as GlobalWithContainer;
  const pending = globalRef[CONTAINER_KEY];
  delete globalRef[CONTAINER_KEY];
  if (!pending) {
    return;
  }
  try {
    const container = await pending;
    await container.close();
  } catch {
    // Une initialisation ayant échoué n'a pas de ressource à libérer.
  }
}

import { sql } from "drizzle-orm";

import { agentSchema, agentActionSchema, taskSchema } from "@/core/contracts";
import type { Agent, AgentAction, Task } from "@/core/contracts";
import { loadEnv, resolveAuthConfig, type AuthConfig, type Env } from "@/config/env";
import { AuthenticationService } from "@/server/auth/authentication-service";
import { createBetterAuth, type IcosBetterAuth } from "@/server/auth/better-auth";
import { BetterAuthHttpGateway } from "@/server/auth/http-gateway";
import { HumanAdministrationService } from "@/server/administration/human-administration-service";
import { OperationalAccessService } from "@/server/administration/operational-access-service";
import type { AuthGateway, AuthHttpGateway, RoleRepository } from "@/server/auth/ports";
import { PostgresHumanUserRepository } from "@/server/repositories/postgres/human-user-repository";
import { PostgresRoleRepository } from "@/server/repositories/postgres/role-repository";
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
import { InMemoryCapabilityRepository } from "@/server/services/in-memory/capability-repository";
import { InMemoryAgentCapabilityRepository } from "@/server/services/in-memory/agent-capability-repository";
import { PostgresActionRepository } from "@/server/repositories/postgres/action-repository";
import { PostgresAgentRepository } from "@/server/repositories/postgres/agent-repository";
import { PostgresApprovalRepository } from "@/server/repositories/postgres/approval-repository";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";
import { PostgresCapabilityRepository } from "@/server/repositories/postgres/capability-repository";
import { PostgresAgentCapabilityRepository } from "@/server/repositories/postgres/agent-capability-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import type {
  ActionRepository,
  AgentRepository,
  ApprovalRepository,
  AuditRepository,
  HumanAgentLinkRepository,
  HumanUserAdministrationRepository,
  TaskRepository,
} from "@/server/repositories/ports";
import type {
  CapabilityRepository,
  AgentCapabilityRepository,
} from "@/server/repositories/capability-ports";
import { PostgresHumanAgentLinkRepository } from "@/server/repositories/postgres/human-agent-link-repository";
import { PostgresHumanAdministrationUnitOfWork } from "@/server/uow/postgres-human-administration-uow";
import type {
  HumanAdministrationUnitOfWork,
  ActionDecisionUnitOfWork,
  CapabilityUnitOfWork,
} from "@/server/uow/ports";
import { InMemoryActionDecisionUnitOfWork } from "@/server/uow/in-memory-action-decision-uow";
import { PostgresActionDecisionUnitOfWork } from "@/server/uow/postgres-action-decision-uow";
import { InMemoryCapabilityUnitOfWork } from "@/server/uow/in-memory-capability-uow";
import { PostgresCapabilityUnitOfWork } from "@/server/uow/postgres-capability-uow";
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
  capabilities: CapabilityRepository;
  agentCapabilities: AgentCapabilityRepository;
  capabilityUow: CapabilityUnitOfWork;
  decisionUow: ActionDecisionUnitOfWork;
  /**
   * Façade d'authentification humaine (Better Auth). Présente uniquement avec le
   * backend PostgreSQL ET une configuration d'auth valide ; `undefined` sinon
   * (backend mémoire ou secret absent). L'auth réelle exige PostgreSQL.
   */
  auth?: AuthGateway;
  /** Façade login/logout, présente avec la même instance Better Auth que `auth`. */
  authHttp?: AuthHttpGateway;
  /** Rôles applicatifs ICOS (présent avec le backend PostgreSQL). */
  roles?: RoleRepository;
  /** Utilisateurs humains administrables (présent avec le backend PostgreSQL). */
  users?: HumanUserAdministrationRepository;
  /** Rattachements humains-agents (présent avec le backend PostgreSQL). */
  agentLinks?: HumanAgentLinkRepository;
  /** Administration humaine, composée uniquement lorsqu'une auth est disponible. */
  humanAdministration?: HumanAdministrationService;
  /** Résolution de la portée opérationnelle par rattachements. */
  operationalAccess?: OperationalAccessService;
  /** Mutations d'administration humaine transactionnelles. */
  humanAdministrationUow?: HumanAdministrationUnitOfWork;
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
  const capabilities = new InMemoryCapabilityRepository();
  const agentCapabilities = new InMemoryAgentCapabilityRepository();

  return {
    agents: new InMemoryAgentRepository(agents),
    tasks: new InMemoryTaskRepository(auditLog, tasks),
    actions: new InMemoryActionRepository(store),
    approvals: new InMemoryApprovalRepository(store),
    audit: new InMemoryAuditRepository(auditLog),
    capabilities,
    agentCapabilities,
    // L'UoW mémoire dépend des collaborateurs SYNCHRONES internes (store +
    // journal), afin de préserver sa section critique non interruptible.
    capabilityUow: new InMemoryCapabilityUnitOfWork(capabilities, agentCapabilities, auditLog),
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
export function composeAuthentication(
  db: ReturnType<typeof createDatabase>["db"],
  roles: RoleRepository,
  config: AuthConfig,
  createAuth: (
    db: ReturnType<typeof createDatabase>["db"],
    config: AuthConfig,
  ) => IcosBetterAuth = createBetterAuth,
): { auth: AuthGateway; authHttp: AuthHttpGateway } {
  const betterAuth = createAuth(db, config);
  return {
    auth: new AuthenticationService(betterAuth, new PostgresHumanUserRepository(db), roles, db),
    authHttp: new BetterAuthHttpGateway(betterAuth),
  };
}

interface AdministrationDependencies {
  auth?: AuthGateway;
  users: HumanUserAdministrationRepository;
  agentLinks: HumanAgentLinkRepository;
  agents: AgentRepository;
  audit: AuditRepository;
  humanAdministrationUow: HumanAdministrationUnitOfWork;
}

export function composeAdministration(
  input: AdministrationDependencies,
): Pick<
  Container,
  "users" | "agentLinks" | "humanAdministration" | "operationalAccess" | "humanAdministrationUow"
> {
  return {
    users: input.users,
    agentLinks: input.agentLinks,
    humanAdministration: input.auth
      ? new HumanAdministrationService({
          auth: input.auth,
          users: input.users,
          links: input.agentLinks,
          agents: input.agents,
          audit: input.audit,
          uow: input.humanAdministrationUow,
        })
      : undefined,
    operationalAccess: new OperationalAccessService(input.agentLinks),
    humanAdministrationUow: input.humanAdministrationUow,
  };
}

export async function buildPostgresContainer(
  url: string,
  authConfig?: AuthConfig,
): Promise<Container> {
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

  // Rôles ICOS + auth humaine (construite uniquement si config valide fournie).
  const roles = new PostgresRoleRepository(handle.db);
  const authentication = authConfig
    ? composeAuthentication(handle.db, roles, authConfig)
    : undefined;
  const agents = new PostgresAgentRepository(handle.db);
  const audit = new PostgresAuditRepository(handle.db);
  const administration = composeAdministration({
    auth: authentication?.auth,
    users: new PostgresHumanUserRepository(handle.db),
    agentLinks: new PostgresHumanAgentLinkRepository(handle.db),
    agents,
    audit,
    humanAdministrationUow: new PostgresHumanAdministrationUnitOfWork(handle.db),
  });

  return {
    agents,
    tasks: new PostgresTaskRepository(handle.db),
    actions: new PostgresActionRepository(handle.db),
    approvals: new PostgresApprovalRepository(handle.db),
    audit,
    capabilities: new PostgresCapabilityRepository(handle.db),
    agentCapabilities: new PostgresAgentCapabilityRepository(handle.db),
    capabilityUow: new PostgresCapabilityUnitOfWork(handle.db),
    decisionUow: new PostgresActionDecisionUnitOfWork(handle.db),
    auth: authentication?.auth,
    authHttp: authentication?.authHttp,
    roles,
    ...administration,
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
    // Auth composée seulement si le secret/URL Better Auth sont fournis.
    const authConfig =
      env.BETTER_AUTH_SECRET !== undefined && env.BETTER_AUTH_URL !== undefined
        ? resolveAuthConfig(env)
        : undefined;
    return buildPostgresContainer(env.DATABASE_URL, authConfig);
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

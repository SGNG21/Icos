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
import type { Database } from "@/server/database/client";
import { PersistenceUnavailableError } from "@/server/database/errors";
import { InMemoryDurableMemory, type DurableMemory } from "@/core/context/durable-memory";
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
import { PostgresTaskExecutionResultRepository } from "@/server/repositories/postgres/task-execution-result-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import type { ScheduledJobRepository } from "@/core/contracts/scheduler";
import { InMemoryScheduledJobRepository } from "@/server/scheduler/in-memory-scheduled-job-repository";
import { PostgresScheduledJobRepository } from "@/server/scheduler/postgres-scheduled-job-repository";
import { SchedulerService } from "@/server/scheduler/scheduler-service";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { PostgresReviewerService } from "@/server/repositories/postgres/postgres-reviewer-service";
import { PostgresReviewDecisionRepository } from "@/server/repositories/postgres/review-decision-repository";
import { PostgresQualityControlRepository } from "@/server/repositories/postgres/quality-control-repository";
import { PostgresAutonomousMissionRuntimeRepository } from "@/server/repositories/postgres/autonomous-mission-runtime-repository";
import {
  PostgresConversationRepository,
  PostgresMessageRepository,
} from "@/server/repositories/postgres/ceo-repository";
import type {
  ActionRepository,
  AgentRepository,
  ApprovalRepository,
  AuditRepository,
  GoalRepository,
  HumanAgentLinkRepository,
  HumanUserAdministrationRepository,
  TaskExecutionResultRepository,
  TaskRepository,
} from "@/server/repositories/ports";
import type {
  CapabilityRepository,
  AgentCapabilityRepository,
} from "@/server/repositories/capability-ports";
import type {
  SkillRepository,
  SkillSecurityScanRepository,
  SkillEvaluationRepository,
} from "@/server/repositories/skill-ports";
import { PostgresHumanAgentLinkRepository } from "@/server/repositories/postgres/human-agent-link-repository";
import { PostgresHumanAdministrationUnitOfWork } from "@/server/uow/postgres-human-administration-uow";
import type {
  HumanAdministrationUnitOfWork,
  ActionDecisionUnitOfWork,
  CapabilityUnitOfWork,
  SkillUnitOfWork,
} from "@/server/uow/ports";
import { InMemoryActionDecisionUnitOfWork } from "@/server/uow/in-memory-action-decision-uow";
import { PostgresActionDecisionUnitOfWork } from "@/server/uow/postgres-action-decision-uow";
import { InMemoryCapabilityUnitOfWork } from "@/server/uow/in-memory-capability-uow";
import { PostgresCapabilityUnitOfWork } from "@/server/uow/postgres-capability-uow";
import { SkillService } from "@/server/services/skill-service";
import { InMemorySkillRepository, InMemorySkillSecurityScanRepository, InMemorySkillEvaluationRepository } from "@/server/services/in-memory/skill-repository";
import { InMemoryDispatchAttemptRepository } from "@/server/services/in-memory/dispatch-attempt-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryTaskExecutionDispatcher } from "@/server/execution/in-memory-task-execution-dispatcher";
import { TemporalTaskExecutionDispatcher } from "@/server/execution/temporal-task-execution-dispatcher";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import { InMemoryTaskExecutionResultRepository } from "@/server/services/in-memory/task-execution-result-repository";
import { InMemoryGoalRepository } from "@/server/services/in-memory/goal-repository";
import { PostgresGoalRepository } from "@/server/repositories/postgres/goal-repository";
import { InMemoryReviewerService } from "@/server/review/in-memory-reviewer-service";
import type { ReviewerService } from "@/server/review/ports";
import { createOmniRouteReviewer } from "@/server/review/omniroute-reviewer";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";
import { InMemoryReviewDecisionRepository } from "@/server/services/in-memory/review-decision-repository";
import { InMemoryQualityControlRepository } from "@/server/services/in-memory/quality-control-repository";
import { InMemoryAutonomousMissionRuntimeRepository } from "@/server/services/in-memory/autonomous-mission-runtime-repository";
import { InMemoryConversationRepository, InMemoryMessageRepository } from "@/server/services/in-memory/ceo-repository";
import { ConversationService } from "@/server/services/conversation-service";
import { CeoApplicationService } from "@/server/services/ceo-service";
import { MissionService } from "@/server/mission/mission-service";
import { GoalNormalizer } from "./services/goal-normalizer";
import { GoalPlanner } from "./services/goal-planner";
import { GoalPreviewStore } from "./services/goal-preview-store";
import { AIResourceCatalog } from "./services/ai-selection/ai-resource-catalog";
import { AISelectionEngine } from "./services/ai-selection/ai-selection-engine";
import type { MissionRepository } from "@/server/mission/ports";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { QualityControlRepository } from "@/core/contracts/quality-control";
import type { AutonomousMissionRuntimeRepository } from "@/server/autonomy/runtime";
import type { AutonomousMissionPlanner } from "@/server/autonomy/autonomous-mission-runner";
import { createOmniRouteAutonomousMissionPlanner } from "@/server/autonomy/omniroute-autonomous-mission-planner";
import { PostgresSkillRepository, PostgresSkillSecurityScanRepository, PostgresSkillEvaluationRepository } from "@/server/repositories/postgres/skill-repository";
import { InMemorySkillUnitOfWork } from "@/server/uow/in-memory-skill-uow";
import { PostgresSkillUnitOfWork } from "@/server/uow/postgres-skill-uow";
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
  // C2 — Skill Registry
  skills?: SkillRepository;
  skillSecurityScans?: SkillSecurityScanRepository;
  skillEvaluations?: SkillEvaluationRepository;
  skillService?: SkillService;
  skillUow?: SkillUnitOfWork;
  /** Goal intake services */
  goalNormalizer: GoalNormalizer;
  goalPlanner: GoalPlanner;
  goalPreviewStore: GoalPreviewStore;
  /** AI Selection Engine (Phase 8B) */
  aiResourceCatalog: AIResourceCatalog;
  aiSelectionEngine: AISelectionEngine;
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
  mission: MissionRepository;
  missionService: MissionService;
  taskExecution: TaskExecutionDispatcher;
  executionCallbackSecret?: string;
  executionResults: TaskExecutionResultRepository;
  durableMemory: DurableMemory;
  dispatchAttempts: DispatchAttemptRepository;
  reviewer: ReviewerService;
  reviewDecisions: ReviewDecisionRepository;
  qualityControlJobs: QualityControlRepository;
  /** Durable Scheduler (ADR-0025) : file de jobs différés + point d'entrée applicatif. */
  scheduledJobs: ScheduledJobRepository;
  scheduler: SchedulerService;
  autonomousRuntime: AutonomousMissionRuntimeRepository;
  autonomousPlanner?: AutonomousMissionPlanner;
  conversationService: ConversationService;
  ceoService: CeoApplicationService;
  db?: Database;
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

  // C2 — Skill Registry
  const skills = new InMemorySkillRepository();
  const skillSecurityScans = new InMemorySkillSecurityScanRepository();
  const skillEvaluations = new InMemorySkillEvaluationRepository();
  const skillUow = new InMemorySkillUnitOfWork(skills, auditLog);
  const skillService = new SkillService(skills, skillSecurityScans, skillEvaluations, new InMemoryAuditRepository(auditLog), skillUow);

  const tasksRepository = new InMemoryTaskRepository(auditLog, tasks);
  const mission = new InMemoryMissionRepository(tasksRepository);
  const dispatchAttempts = new InMemoryDispatchAttemptRepository(mission, tasksRepository);
  const executionResults = new InMemoryTaskExecutionResultRepository(auditLog, tasksRepository);
  const reviewDecisions = new InMemoryReviewDecisionRepository();
  const autonomousRuntime = new InMemoryAutonomousMissionRuntimeRepository();
  const scheduledJobs = new InMemoryScheduledJobRepository();
  const conversationService = new ConversationService(
    new InMemoryConversationRepository(),
    new InMemoryMessageRepository(),
  );
  const missionService = new MissionService(mission);

  // Goal intake services
  const goalNormalizer = new GoalNormalizer();
  const goalPlanner = new GoalPlanner();
  const goalRepository = new InMemoryGoalRepository(auditLog);
  const goalPreviewStore = new GoalPreviewStore(goalRepository);
  
  // AI Selection Engine (Phase 8B)
  const aiResourceCatalog = new AIResourceCatalog();
  const aiSelectionEngine = new AISelectionEngine(aiResourceCatalog);

  return {
    agents: new InMemoryAgentRepository(agents),
    tasks: tasksRepository,
    actions: new InMemoryActionRepository(store),
    approvals: new InMemoryApprovalRepository(store),
    audit: new InMemoryAuditRepository(auditLog),
    capabilities,
    agentCapabilities,
    // L'UoW mémoire dépend des collaborateurs SYNCHRONES internes (store +
    // journal), afin de préserver sa section critique non interruptible.
    capabilityUow: new InMemoryCapabilityUnitOfWork(capabilities, agentCapabilities, auditLog),
    decisionUow: new InMemoryActionDecisionUnitOfWork(store, auditLog),
    skills,
    skillSecurityScans,
    skillEvaluations,
    skillService,
    skillUow,
    mission,
    missionService,
    taskExecution: new InMemoryTaskExecutionDispatcher(),
    executionCallbackSecret: undefined,
    executionResults,
    durableMemory: new InMemoryDurableMemory(),
    dispatchAttempts,
    reviewer: new InMemoryReviewerService(),
    reviewDecisions,
    qualityControlJobs: new InMemoryQualityControlRepository(
      mission,
      tasksRepository,
      executionResults,
      reviewDecisions,
      dispatchAttempts,
      autonomousRuntime,
    ),
    scheduledJobs,
    scheduler: new SchedulerService(scheduledJobs),
    autonomousRuntime,
    autonomousPlanner: undefined,
    conversationService,
    ceoService: new CeoApplicationService(conversationService, missionService),
    db: undefined,
    close: async () => {},
    // Goal intake services
    goalNormalizer,
    goalPlanner,
    goalPreviewStore,
    // AI Selection Engine (Phase 8B)
    aiResourceCatalog,
    aiSelectionEngine,
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
  env: Env = loadEnv(),
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
  const tasks = new PostgresTaskRepository(handle.db);
  const mission = new PostgresMissionRepository(handle.db, tasks);
  const missionService = new MissionService(mission);
  const goalNormalizer = new GoalNormalizer();
  const goalPlanner = new GoalPlanner();
  const goalRepository = new PostgresGoalRepository(handle.db);
  const goalPreviewStore = new GoalPreviewStore(goalRepository);
  const dispatchAttempts = new PostgresDispatchAttemptRepository(handle.db);
  const executionResults = new PostgresTaskExecutionResultRepository(handle.db);
  const reviewDecisions = new PostgresReviewDecisionRepository(handle.db);
  const autonomousRuntime = new PostgresAutonomousMissionRuntimeRepository(handle.db);
  const scheduledJobs = new PostgresScheduledJobRepository(handle.db);
  const llmReviewer = createOmniRouteReviewer(env);
  if (!llmReviewer) {
    await handle.close().catch(() => {});
    throw new PersistenceConfigError("Le reviewer OmniRoute est requis pour le backend PostgreSQL.");
  }
  const reviewer = new PostgresReviewerService(handle.db, llmReviewer);
  const conversationService = new ConversationService(
    new PostgresConversationRepository(handle.db),
    new PostgresMessageRepository(handle.db),
  );

  return {
    agents,
    tasks,
    actions: new PostgresActionRepository(handle.db),
    approvals: new PostgresApprovalRepository(handle.db),
    audit,
    capabilities: new PostgresCapabilityRepository(handle.db),
    agentCapabilities: new PostgresAgentCapabilityRepository(handle.db),
    capabilityUow: new PostgresCapabilityUnitOfWork(handle.db),
    decisionUow: new PostgresActionDecisionUnitOfWork(handle.db),
    ...(() => {
      const skills = new PostgresSkillRepository(handle.db);
      const skillSecurityScans = new PostgresSkillSecurityScanRepository(handle.db);
      const skillEvaluations = new PostgresSkillEvaluationRepository(handle.db);
      const skillUow = new PostgresSkillUnitOfWork(handle.db);
      const skillService = new SkillService(skills, skillSecurityScans, skillEvaluations, audit, skillUow);
      return { skills, skillSecurityScans, skillEvaluations, skillUow, skillService };
    })(),
    auth: authentication?.auth,
    authHttp: authentication?.authHttp,
    roles,
    ...administration,
    mission,
    missionService,
    taskExecution: new TemporalTaskExecutionDispatcher(
      env.TEMPORAL_ADDRESS,
      env.TEMPORAL_TASK_QUEUE,
      env.TEMPORAL_WORKFLOW_TYPE,
      true,
      undefined,
      env.TEMPORAL_DISPATCH_TIMEOUT_MS,
    ),
    executionCallbackSecret: env.ICOS_EXECUTION_CALLBACK_SECRET,
    executionResults,
    durableMemory: new PostgresDurableMemory(handle.db),
    dispatchAttempts,
    reviewer,
    reviewDecisions,
    qualityControlJobs: new PostgresQualityControlRepository(handle.db),
    scheduledJobs,
    scheduler: new SchedulerService(scheduledJobs),
    autonomousRuntime,
    autonomousPlanner: createOmniRouteAutonomousMissionPlanner(env),
    conversationService,
    ceoService: new CeoApplicationService(conversationService, missionService),
    db: handle.db,
    close: handle.close,
    // Goal intake services
    goalNormalizer,
    goalPlanner,
    goalPreviewStore,
    // AI Selection Engine (Phase 8B)
    aiResourceCatalog: new AIResourceCatalog(),
    aiSelectionEngine: new AISelectionEngine(new AIResourceCatalog()),
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
    return buildPostgresContainer(env.DATABASE_URL, authConfig, env);
  }

  return buildMemoryContainer(options.seeds);
}

const CONTAINER_KEY = "__icosContainerPromise__";

type GlobalWithContainer = typeof globalThis & { [CONTAINER_KEY]?: Promise<Container> };

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
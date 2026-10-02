import { composeControlPlane, type ControlPlane } from "@/server/control/compose";
import {
  createWorkforceRuntime,
  createWorkforceStore,
  type WorkforceRuntime,
} from "@/server/workforce/composition";
import { InMemoryControlStore } from "@/server/control/in-memory-control-store";
import { PostgresControlStore } from "@/server/control/postgres-control-store";
import { installDispatchBackstop, RuntimeControlGuard } from "@/server/control/runtime-control";
import { WORK_CLASSES } from "@/core/supervisor/contracts";
import { ObjectiveCoordinator } from "@/server/supervisor/objective-coordinator";
import { sql } from "drizzle-orm";

import { agentSchema, agentActionSchema, taskSchema } from "@/core/contracts";
import { AIResourceCatalogPort } from "@/core/contracts/ai-selection";
import { AIResourceCatalog } from "@/server/services/ai-selection/ai-resource-catalog";
import type { Agent, AgentAction, Task } from "@/core/contracts";
import {
  loadEnv,
  resolveAuthConfig,
  resolveAutonomyBounds,
  resolveSystemModelAllowlist,
  type AuthConfig,
  type Env,
} from "@/config/env";
import type { AutonomyCompositionPolicy } from "@/server/usecases/start-autonomous-mission";
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
import { MirroringWorkerRegistryStore } from "@/server/services/worker-registry/mirroring-worker-registry-store";
import { InMemoryWorkerRegistry } from "@/server/services/worker-registry/in-memory-worker-registry";
import { AdaptedAIResourceCatalog } from "@/server/services/ai-selection/adapted-ai-resource-catalog";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { WorkerHealthProber } from "@/server/services/worker-registry/worker-health-prober";
import { CommandWorkerProbe } from "@/server/workers/probes/command-worker-probe";
import { OmniRouteHttpWorkerProbe, probeModelOf } from "@/server/workers/probes/omniroute-http-worker-probe";
import { isComputeCandidate } from "@/server/workers/compute-bootstrap";
import {
  createWorkerProbeResolver,
  parseWorkerProbeCommands,
  probeableRuntimes,
} from "@/server/workers/probes/probe-command-config";
import {
  CommandWorkerExecutor,
  DEFAULT_EXECUTION_TIMEOUT_MS,
} from "@/server/workers/execution/command-worker-executor";
import { budgetFitsLease, SETTLEMENT_MARGIN_MS } from "@/core/workers/compute-routing";
import {
  createWorkerExecResolver,
  executableRuntimes,
  parseWorkerExecCommands,
} from "@/server/workers/execution/exec-command-config";
import { parseWorkerFailureConfig } from "@/server/workers/execution/failure-classifier";
import { WorkerExecutor } from "@/server/workers/execution/worker-executor";
import {
  DEFAULT_EXECUTION_LEASE_MS,
  ExternalWorkerTaskExecutionDispatcher,
} from "@/server/execution/external-worker-task-execution-dispatcher";
import { RuntimeDispatchRouter } from "@/server/execution/runtime-dispatch-router";
import type { WorkerRuntimeDescriptor } from "@/core/contracts/worker-registry";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";
import type { GoalRepository } from "@/server/repositories/ports";
import type { WorkerRegistryPort } from "@/core/contracts/worker-registry";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { WorkspaceManager } from "@/server/workspace-manager/manager";
import { InMemoryWorkspaceRegistry } from "@/server/workspace-manager/registry";
import { InMemoryGit } from "@/server/workspace-manager/in-memory-git";
import { InMemoryTestDatabaseProvisioner } from "@/server/workspace-manager/in-memory-test-database-provisioner";
import { IntegrationGate, parseGateCommands } from "@/server/workspace-manager/integration-gate";
import { IntegrationApplier } from "@/server/workspace-manager/integration-applier";
import { InMemoryCommandRunner } from "@/server/workspace-manager/in-memory-gate-deps";
import { InMemoryGateDatabase } from "@/server/workspace-manager/in-memory-gate-deps";
import { WorkspaceExecutionCoordinator } from "@/server/workspace-manager/workspace-execution-coordinator";
import { PostgresTestDatabaseProvisioner } from "@/server/workspace-manager/test-database";
import { PostgresWorkspaceRegistry } from "@/server/workspace-manager/postgres-workspace-registry";
import { PostgresGit } from "@/server/workspace-manager/postgres-git";
import { PostgresCommandRunner } from "@/server/workspace-manager/postgres-gate-deps";
import { PostgresGateDatabase } from "@/server/workspace-manager/postgres-gate-deps";
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
import { WorkspaceIntegrationSettlement } from "@/server/workspace-manager/integration-settlement";
import { requiresGovernedWorkspace } from "@/server/supervisor/workspace-allocation-policy";
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
import type { ReviewerPort, ReviewerService } from "@/server/review/ports";
import { createOmniRouteReviewer } from "@/server/review/omniroute-reviewer";
import { CommandReviewer, parseReviewerCommand } from "@/server/review/command-reviewer";
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

import { AISelectionEngine } from "./services/ai-selection/ai-selection-engine";
import type { MissionRepository } from "@/server/mission/ports";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { QualityControlRepository } from "@/core/contracts/quality-control";
import type { AutonomousMissionRuntimeRepository } from "@/server/autonomy/runtime";
import { createOmniRouteAutonomousMissionPlanner } from "@/server/autonomy/omniroute-autonomous-mission-planner";
import { composeSpendMeters } from "@/server/budget/compose-spend";
import {
  CanonicalAutonomousMissionPlanner,
  type PlannerCompletionProvider,
} from "@/server/autonomy/canonical-mission-planner";
import {
  CommandPlannerProvider,
  parsePlannerCommand,
} from "@/server/autonomy/command-planner-provider";
import type { AutonomousMissionPlanner } from "@/server/autonomy/autonomous-mission-runner";
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
  /** The canonical goal store. Self-development creates its goals through it (M11). */
  goalRepository: GoalRepository;
  /** Read model over the durable registry; reviewer independence resolves identities here. */
  workerRegistry: WorkerRegistryPort;
  /**
   * Durable worker registry (M4, decision 0031). Registering or probing a
   * worker here is what makes capability routing authoritative — see
   * `capabilityRouter`.
   */
  workerRegistryStore: WorkerRegistryStore;
  /**
   * Write side of the worker registry (M5): registration, probing,
   * deactivation. Registration is NOT a health claim — a registered worker
   * routes nothing until a probe proves it healthy AND available.
   */
  workerRegistration: WorkerRegistrationService;
  /**
   * Autonomous health probing (M5.2, defect 14). `probeAll()` refreshes
   * evidence for active workers; `expireStaleEvidence()` durably invalidates
   * evidence nothing refreshed, which is what makes a crashed worker or a dead
   * session fail CLOSED instead of leaving a stale `healthy` behind.
   *
   * Wired with the REAL command probe (M6): it runs each worker's runtime
   * non-interactively, with no stdin and a hard timeout, and reports what
   * actually happened. Adapters are keyed by RUNTIME, so a new worker KIND needs
   * no adapter at all.
   *
   * Out of the box only the `node` runtime is probeable — it is the runtime this
   * process already executes in, so the check needs no configured path. Every
   * other runtime must be declared in ICOS_WORKER_PROBE_COMMANDS; an
   * unconfigured runtime is recorded `unsupported` and routes nothing, which is
   * the honest "we have no way to check this" state rather than a silent pass.
   */
  workerHealthProber: WorkerHealthProber;
  /**
   * Capability routing over the worker registry hydrated at container build
   * (M4, decision 0031). With an empty registry it reports
   * ROUTING_UNCONFIGURED and dispatch behaves exactly as before M4.
   */
  capabilityRouter: CapabilityRouter;
  /** AI Selection Engine (Phase 8B) */
  aiResourceCatalog: AIResourceCatalogPort;
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
  /**
   * Objective admission (decision 0065): scores a goal and consults the portfolio before
   * the existing `start_mission` job is enqueued. Thin — it owns no loop and no state.
   */
  objectiveCoordinator: ObjectiveCoordinator;
  /** READ-ONLY for projections; the canonical authority over running work. */
  controlGuard: RuntimeControlGuard;
  autonomousRuntime: AutonomousMissionRuntimeRepository;
  autonomousPlanner?: AutonomousMissionPlanner;
  /**
   * POLITIQUE BORNÉE d'une mission autonome (P0-E/P0-F) : le plafond du déploiement et
   * le pool de compute que le système autorise, résolus UNE fois ici et transportés tels
   * quels jusqu'à l'allumage (`igniteAutonomousMission` -> `startAutonomousMission`).
   *
   * Requis, et `{}` est une valeur légitime qui signifie « les valeurs par défaut
   * historiques » : sans ce champ, les modules de politique n'auraient toujours aucun
   * appelant, et une politique sans appelant n'applique rien.
   */
  autonomyPolicy: AutonomyCompositionPolicy;
  /**
   * The COMPUTE behind proposing an improvement (M14), configured exactly like the planner's.
   * Kept separate from the planner itself because a proposer runs INSIDE the repository it is
   * proposing about, and a planner does not.
   */
  improvementProposalProvider?: PlannerCompletionProvider;
  conversationService: ConversationService;
  ceoService: CeoApplicationService;
  db?: Database;
  /** Workspace Manager (Phase 8D) */
  workspaceManager?: WorkspaceManager;
  /** Integration Gate (Phase 8D) */
  integrationGate?: IntegrationGate;
  /**
   * APPLIES an accepted worker result to the integration target (M8, defect 19).
   *
   * Separate from the gate because the responsibilities are genuinely different: the gate
   * DECIDES, the applier ACTS, and only on a decision the gate already granted. Sharing the
   * same manager, Git port and lease keeps it one authority rather than two.
   */
  integrationApplier?: IntegrationApplier;
  /**
   * Control plane (decision 0055): the ONE command authority (BR-10), durable
   * runtime flags and mission holds (BR-12), versions (BR-11), re-auth (BR-18).
   * Optional only so hand-built test containers compile; the control routes
   * refuse to act without it.
   */
  control?: ControlPlane;
  /**
   * Digital workforce (decision 0057): roles, skills, Mini-ICOS, governed delegation. Composed
   * from the lane's own entry point; routes only ever receive `workforce.sessions.fromSession`.
   * Optional only so hand-built test containers compile.
   */
  workforce?: WorkforceRuntime;
  /** Workspace Execution Coordinator (Phase 8D) */
  workspaceExecutionCoordinator?: WorkspaceExecutionCoordinator;
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
  const workerRegistry = new InMemoryWorkerRegistry([]);
  /* Same live view as the durable container (defect 31): one fleet, not two. */
  const workerRegistryStore = new MirroringWorkerRegistryStore(
    new InMemoryWorkerRegistryStore(),
    workerRegistry,
  );
  const dispatchAttempts = new InMemoryDispatchAttemptRepository(
    mission,
    tasksRepository,
    workerRegistryStore,
  );
  const executionResults = new InMemoryTaskExecutionResultRepository(auditLog, tasksRepository);
  const reviewDecisions = new InMemoryReviewDecisionRepository();
  const autonomousRuntime = new InMemoryAutonomousMissionRuntimeRepository();
  const scheduledJobs = new InMemoryScheduledJobRepository();
  const schedulerService = new SchedulerService(scheduledJobs);
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

  // Worker Registry (Phase 8C) — durable store + hydrated read model (M4).
  // buildMemoryContainer is synchronous by contract, and a fresh in-memory
  // store is empty by construction, so there is nothing to hydrate.
  const capabilityRouter = new CapabilityRouter(workerRegistryStore, {
    /*
     * M5.3: durable load, derived from the dispatch ledger. Passing the reader
     * (not a snapshot) means every decision counts the rows as they are now,
     * and a restart recounts them identically.
     */
    activeAssignments: () => dispatchAttempts.listActiveWorkerAssignments(),
  });
  /*
   * COMPTEUR DE DÉPENSE — conteneur EN MÉMOIRE. Aucune base, donc aucun `goals.budget`
   * persisté à appliquer : le journal en mémoire est choisi, et ce qu'il signifie est
   * assumé — la dépense est oubliée au redémarrage. C'est cohérent avec ce conteneur, qui
   * est en mémoire de bout en bout, et ce n'est PAS un repli d'une base indisponible.
   * Seule la couture des frais opérationnels est câblée ici : ce conteneur ne monte aucun
   * planificateur OmniRoute (`autonomousPlanner: undefined`), donc aucune dépense de mission.
   */
  const spend = composeSpendMeters();
  const workerRegistration = new WorkerRegistrationService(workerRegistryStore);
  const workerHealthProber = new WorkerHealthProber(
    workerRegistryStore,
    workerRegistration,
    { adapters: buildWorkerProbeAdapters(), selectProbe: buildModelProbeSelector(spend.overhead) },
  );
  // AI Selection Engine (Phase 8B) - now uses worker registry via adapter
  const baseCatalog = new AIResourceCatalog();
  const aiResourceCatalog = new AdaptedAIResourceCatalog(workerRegistry, baseCatalog);
  const aiSelectionEngine = new AISelectionEngine(aiResourceCatalog);

  // Workspace Manager (Phase 8D)
  const git = new InMemoryGit();
  const workspaceRegistry = new InMemoryWorkspaceRegistry();
  const provisioner = new InMemoryTestDatabaseProvisioner();
  const workspaceManager = new WorkspaceManager({ git, registry: workspaceRegistry, provisioner });
  // Control plane (decision 0055): one guard shared by every enforcement point.
  const controlStore = new InMemoryControlStore();
  const controlGuard = new RuntimeControlGuard(controlStore);
  const integrationGate = new IntegrationGate({
    git,
    manager: workspaceManager,
    runner: new InMemoryCommandRunner(),
    database: new InMemoryGateDatabase(),
    control: controlGuard,
  });
  const integrationApplier = new IntegrationApplier({ git, manager: workspaceManager, control: controlGuard });
  const workspaceExecutionCoordinator = new WorkspaceExecutionCoordinator({
    git,
    manager: workspaceManager,
    integrationGate,
    integrationApplier,
    dispatcher: installDispatchBackstop(new InMemoryTaskExecutionDispatcher(), controlGuard),
    missions: mission,
    tasks: tasksRepository,
    durableMemory: new InMemoryDurableMemory(),
  });

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
    taskExecution: installDispatchBackstop(new InMemoryTaskExecutionDispatcher(), controlGuard),
    control: composeControlPlane({
      store: controlStore,
      guard: controlGuard,
      effects: { missions: mission, tasks: tasksRepository, workers: workerRegistryStore, registration: workerRegistration },
    }),
    workforce: createWorkforceRuntime({ store: createWorkforceStore({ kind: "memory" }) }),
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
      new WorkspaceIntegrationSettlement(
        workspaceManager,
        git,
        governedWorkflow(dispatchAttempts, tasksRepository),
      ),
    ),
    scheduledJobs,
    scheduler: schedulerService,
    objectiveCoordinator: new ObjectiveCoordinator({
      scheduler: schedulerService,
      goals: goalRepository,
      missions: mission,
      pendingLaunches: {
        /*
         * Conservative on purpose: an enqueued `start_mission` has no mission row yet and
         * its payload's class is not resolvable without loading each goal, so the whole
         * pending queue is charged to the class being admitted. That can defer a launch
         * that another class's backlog would not really have blocked — the wrong side to
         * be wrong on, since the alternative is a cap that stops capping under a burst.
         * Upgrade path: resolve each pending payload's goalId to its class.
         */
        countByWorkClass: async () => {
          const pending = await scheduledJobs.countScheduledByKind("start_mission");
          return Object.fromEntries(WORK_CLASSES.map((c) => [c, pending]));
        },
      },
    }),
    controlGuard,
    autonomousRuntime,
    autonomousPlanner: undefined,
    /* Backend mémoire : aucun env résolu, donc exactement les valeurs par défaut. */
    autonomyPolicy: {},
    improvementProposalProvider: undefined,
    conversationService,
    ceoService: new CeoApplicationService(conversationService, missionService),
    db: undefined,
    close: async () => {},
    workspaceManager,
    integrationGate,
    integrationApplier,
    workspaceExecutionCoordinator,
    // Goal intake services
    goalNormalizer,
    goalPlanner,
    goalPreviewStore,
    goalRepository,
    workerRegistry,
    // AI Selection Engine (Phase 8B)
    workerRegistryStore,
    workerRegistration,
    workerHealthProber,
    capabilityRouter,
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
  const schedulerService = new SchedulerService(scheduledJobs);
  const llmReviewer = buildLlmReviewer(env);
  if (!llmReviewer) {
    await handle.close().catch(() => {});
    throw new PersistenceConfigError(
      "Un reviewer LLM est requis pour le backend PostgreSQL (ICOS_REVIEWER_COMMAND ou OmniRoute).",
    );
  }
  const reviewer = new PostgresReviewerService(handle.db, llmReviewer);
  const conversationService = new ConversationService(
    new PostgresConversationRepository(handle.db),
    new PostgresMessageRepository(handle.db),
  );

  /*
   * M4: the registry read model is HYDRATED FROM POSTGRES at container build.
   * That is what makes routing survive a process restart — a new process reads
   * the same `workers` rows and reaches the same routing decision.
   */
  const durableWorkerRegistryStore = new PostgresWorkerRegistryStore(handle.db);
  /*
   * A LIVE fleet view, not a boot-time snapshot (defect 31). `WorkerRegistryPort` is
   * synchronous, so this view is seeded from the durable store and then kept in step by
   * mirroring every write back into it — otherwise a worker that registers after the runtime
   * boots is invisible to the reviewer-independence rule, which then fails closed for ever.
   */
  const workerRegistry = new InMemoryWorkerRegistry(await durableWorkerRegistryStore.list());
  const workerRegistryStore = new MirroringWorkerRegistryStore(
    durableWorkerRegistryStore,
    workerRegistry,
  );
  const capabilityRouter = new CapabilityRouter(workerRegistryStore, {
    /*
     * M5.3: durable load, derived from the dispatch ledger. Passing the reader
     * (not a snapshot) means every decision counts the rows as they are now,
     * and a restart recounts them identically.
     */
    activeAssignments: () => dispatchAttempts.listActiveWorkerAssignments(),
    /* Decision 0054: compute history and the budget/lease facts come from the same authority. */
    computeHistory: (since) => dispatchAttempts.listRecentComputeOutcomes(since),
    executionLeaseMs: env.ICOS_WORKER_EXECUTION_LEASE_MS ?? DEFAULT_EXECUTION_LEASE_MS,
    defaultBudgetMs: runtimeDefaultBudgetMs(env),
    steersModel: (runtime) =>
      Boolean(
        parseWorkerExecCommands(env.ICOS_WORKER_EXEC_COMMANDS)[runtime]?.args.some((arg) =>
          arg.includes("{{model}}"),
        ),
      ),
  });
  /*
   * COMPTEUR DE DÉPENSE — conteneur POSTGRESQL. C'est ICI que `goals.budget` devient une
   * contrainte exécutée : journal durable `spend_ledger` (migration 0055) et plafonds lus
   * dans `goals`. Deux coutures, deux politiques (voir `budget/compose-spend.ts`) :
   * `spend.mission` plafonne les complétions de mission par le budget du goal imputé,
   * `spend.overhead` mesure les sondes SANS plafond, par choix nommé.
   *
   * `maxTotalTokensPerGoal` vient de `ICOS_GOAL_MAX_TOTAL_TOKENS`. La table de prix étant
   * vide, c'est le SEUL plafond réellement applicable aujourd'hui.
   *
   * Variable ABSENTE = aucun plafond de tokens, et le résultat est alors fermé et visible,
   * jamais silencieux : un goal sans budget est refusé (`NO_ENFORCEABLE_CAP`) et un goal à
   * budget monétaire est refusé dès que sa fenêtre contient un appel non chiffré
   * (`UNPRICED_USAGE_IN_WINDOW`). Autrement dit : tant que le propriétaire n'a pas fourni
   * soit un plafond de tokens, soit de vrais prix, une mission autonome ne dépense RIEN.
   * C'est la contrepartie assumée d'un plafond qu'on refuse de simuler.
   */
  const spend = composeSpendMeters({
    db: handle.db,
    ...(env.ICOS_GOAL_MAX_TOTAL_TOKENS === undefined
      ? {}
      : { maxTotalTokensPerGoal: env.ICOS_GOAL_MAX_TOTAL_TOKENS }),
  });
  const workerRegistration = new WorkerRegistrationService(workerRegistryStore);
  const workerHealthProber = new WorkerHealthProber(
    workerRegistryStore,
    workerRegistration,
    { adapters: buildWorkerProbeAdapters(), selectProbe: buildModelProbeSelector(spend.overhead) },
  );
  const baseCatalog = new AIResourceCatalog();
  const aiResourceCatalog = new AdaptedAIResourceCatalog(workerRegistry, baseCatalog);

  // Workspace Manager (Phase 8D) - PostgreSQL
  const pgWorkspaceRegistry = new PostgresWorkspaceRegistry(env.DATABASE_URL);
  await pgWorkspaceRegistry.initialize();
  const pgProvisioner = new PostgresTestDatabaseProvisioner(env.DATABASE_URL);
  /*
   * The canonical repository the workspace manager branches from (M9, defect 23).
   *
   * `WorkspaceManager` otherwise falls back to DEFAULT_MASTER_REPO / DEFAULT_WORKTREE_ROOT,
   * which are one developer's absolute paths — so any deployment elsewhere, and any test,
   * would create worktrees against a repository it does not own. `ICOS_REPO_PATH` is
   * already the declared canonical repository for external execution; the same declaration
   * governs workspaces, so there is one answer to "which repo" rather than two.
   */
  const pgGit = new PostgresGit(env.DATABASE_URL, env.ICOS_REPO_PATH);
  const workspaceManager = new WorkspaceManager({
    git: pgGit,
    registry: pgWorkspaceRegistry,
    provisioner: pgProvisioner,
    masterRepo: env.ICOS_REPO_PATH,
    worktreeRoot: env.ICOS_WORKER_WORKSPACE_ROOT,
  });
  // Control plane (decision 0055): one durable store, one guard shared by every enforcement point.
  const controlStore = new PostgresControlStore(handle.db);
  const controlGuard = new RuntimeControlGuard(controlStore);
  const integrationGate = new IntegrationGate({
    git: pgGit,
    manager: workspaceManager,
    runner: new PostgresCommandRunner(),
    database: new PostgresGateDatabase(),
    control: controlGuard,
    /* A deployment may verify with something other than pnpm; omitted keys keep defaults. */
    commands: parseGateCommands(env.ICOS_GATE_COMMANDS),
  });
  /*
   * TASK EXECUTION (M8, defect 22).
   *
   * Until now this was unconditionally Temporal, so a production process could never
   * launch an external worker however much of M6.3/M7 was certified. It is now chosen by
   * RUNTIME: a worker whose runtime this process has an executor adapter for is launched
   * here; everything else still goes to Temporal, unchanged.
   *
   * With no `ICOS_WORKER_EXEC_COMMANDS` configured, `buildWorkerExecutor()` returns null,
   * the router is never built, and `taskExecution` IS the Temporal dispatcher exactly as
   * before. Opting in cannot regress a deployment that has not.
   */
  const temporalDispatcher = new TemporalTaskExecutionDispatcher(
    env.TEMPORAL_ADDRESS,
    env.TEMPORAL_TASK_QUEUE,
    env.TEMPORAL_WORKFLOW_TYPE,
    true,
    undefined,
    env.TEMPORAL_DISPATCH_TIMEOUT_MS,
  );
  const externalExecution = buildWorkerExecutor(env);
  assertExecutionLeaseOutlivesWorkers(env);
  /*
   * CONTROL BACKSTOP (control command bus decision): every admission point holds work before
   * it gets here; this wrapper only refuses a dispatch that slipped past its admission guard.
   */
  const taskExecution: TaskExecutionDispatcher = installDispatchBackstop(
    externalExecution
    ? new RuntimeDispatchRouter({
        dispatchAttempts,
        workers: workerRegistryStore,
        external: new ExternalWorkerTaskExecutionDispatcher({
          executor: externalExecution.executor,
          workers: workerRegistryStore,
          dispatchAttempts,
          executionResults,
          missions: mission,
          tasks,
          durableMemory: new PostgresDurableMemory(handle.db),
          repoPath: externalExecution.repoPath,
          workspaceRoot: env.ICOS_WORKER_WORKSPACE_ROOT,
          leaseMs: env.ICOS_WORKER_EXECUTION_LEASE_MS,
          /*
           * Prefer the GOVERNED workspace when one is registered for this workflow (M8,
           * defect 19). The manager already indexes workspaces by `workflowId`, so this
           * needs no reference to the coordinator and creates no composition cycle.
           * Falls back to an ad-hoc worktree when nothing governed exists, which keeps
           * a bare dispatch working exactly as it did.
           */
          workspaceFor: async (dispatch) => {
            if (!dispatch.workflowId) return null;
            const registered = (await workspaceManager.list()).find(
              (w) => w.workflowId === dispatch.workflowId && w.releasedAt === null,
            );
            if (!registered) return null;
            return {
              path: registered.worktreePath,
              mode: "writer",
              branch: registered.branch,
              baseCommit: registered.baseCommit,
              /* The WorkspaceManager owns this worktree's lifecycle, not the executor. */
              dispose: async () => {},
            };
          },
        }),
        fallback: temporalDispatcher,
        externalRuntimes: externalExecution.runtimes,
      })
    : temporalDispatcher,
    controlGuard,
  );

  const integrationApplier = new IntegrationApplier({
    git: pgGit,
    manager: workspaceManager,
    control: controlGuard,
  });
  const workspaceExecutionCoordinator = new WorkspaceExecutionCoordinator({
    git: pgGit,
    manager: workspaceManager,
    integrationGate,
    integrationApplier,
    /* The CANONICAL review decisions feed the gate: one reviewer, not two. */
    reviewDecisions,
    /* The writer's effective model, for the gate's same-model refusal (0054). */
    writerAttempts: dispatchAttempts,
    /* The same dispatcher the rest of the runtime uses: one execution authority. */
    dispatcher: taskExecution,
    missions: mission,
    tasks: tasks,
    durableMemory: new PostgresDurableMemory(handle.db),
  });

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
    taskExecution,
    executionCallbackSecret: env.ICOS_EXECUTION_CALLBACK_SECRET,
    executionResults,
    durableMemory: new PostgresDurableMemory(handle.db),
    dispatchAttempts,
    reviewer,
    reviewDecisions,
    /* DEFECT 36: governed work completes on its INTEGRATION, not on its review (0049). */
    qualityControlJobs: new PostgresQualityControlRepository(
      handle.db,
      new WorkspaceIntegrationSettlement(workspaceManager, pgGit, governedWorkflow(dispatchAttempts, tasks)),
    ),
    scheduledJobs,
    scheduler: schedulerService,
    objectiveCoordinator: new ObjectiveCoordinator({
      scheduler: schedulerService,
      goals: goalRepository,
      missions: mission,
      pendingLaunches: {
        /*
         * Conservative on purpose: an enqueued `start_mission` has no mission row yet and
         * its payload's class is not resolvable without loading each goal, so the whole
         * pending queue is charged to the class being admitted. That can defer a launch
         * that another class's backlog would not really have blocked — the wrong side to
         * be wrong on, since the alternative is a cap that stops capping under a burst.
         * Upgrade path: resolve each pending payload's goalId to its class.
         */
        countByWorkClass: async () => {
          const pending = await scheduledJobs.countScheduledByKind("start_mission");
          return Object.fromEntries(WORK_CLASSES.map((c) => [c, pending]));
        },
      },
    }),
    controlGuard,
    autonomousRuntime,
    autonomousPlanner: buildAutonomousPlanner(env, spend.mission),
    autonomyPolicy: buildAutonomyCompositionPolicy(env),
    improvementProposalProvider: buildImprovementProposalProvider(env),
    conversationService,
    ceoService: new CeoApplicationService(conversationService, missionService),
    db: handle.db,
    /*
     * CLOSE EVERY CLIENT THIS CONTAINER OPENED, not just the shared handle (D1).
     *
     * `buildPostgresContainer` opens THREE PostgreSQL clients: the shared drizzle handle,
     * and one each for the workspace registry and the git port (both need a connection
     * outside the drizzle schema). Only the handle was closed, so two `postgres.js` pools
     * — and their sockets — outlived `close()` and kept the Node event loop alive.
     *
     * For a long-lived server that is invisible. For a CLI it is fatal: `scripts/
     * auth-bootstrap.ts` completed its work, printed its result, and then never exited,
     * so the process that spawned it waited until the test timeout. That is defect D1 —
     * three "failures" that were one leaked lifecycle, not an auth bug.
     *
     * Failures are collected rather than short-circuited: one client refusing to close
     * must not leave the others open.
     */
    close: async () => {
      const results = await Promise.allSettled([
        handle.close(),
        pgWorkspaceRegistry.close(),
        pgGit.close(),
      ]);
      const failed = results.find((r) => r.status === "rejected");
      if (failed && failed.status === "rejected") throw failed.reason;
    },
    // Goal intake services
    goalNormalizer,
    goalPlanner,
    goalPreviewStore,
    goalRepository,
    workerRegistry,
    // AI Selection Engine (Phase 8B)
    workerRegistryStore,
    workerRegistration,
    workerHealthProber,
    capabilityRouter,
    aiResourceCatalog,
    aiSelectionEngine: new AISelectionEngine(aiResourceCatalog),
    // Workspace Manager (Phase 8D)
    workspaceManager,
    integrationGate,
    integrationApplier,
    workspaceExecutionCoordinator,
    control: composeControlPlane({
      store: controlStore,
      guard: controlGuard,
      effects: {
        missions: mission,
        tasks,
        operationalAccess: administration.operationalAccess,
        workers: workerRegistryStore,
        registration: workerRegistration,
      },
      auth: authentication?.auth,
    }),
    workforce: createWorkforceRuntime({ store: createWorkforceStore({ kind: "postgres", db: handle.db }) }),
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

/**
 * Builds the runtime-keyed probe adapters from configuration (M6, defect 16).
 *
 * ONE adapter instance serves every probeable runtime: the resolver, not the
 * adapter, decides what a given runtime's check is. Registering an adapter per
 * runtime name would be the first step towards a hardcoded list of them.
 *
 * A runtime that is NOT probeable is deliberately left OUT of the map rather than
 * mapped to something permissive. The prober then records `unsupported` — "we
 * have no way to check this" — which is a different and more useful fact than
 * "we checked and it failed".
 */
/**
 * Composes the EXTERNAL worker executor from configuration (M8, defect 22).
 *
 * Returns null when nothing is configured, and that is the default: with no
 * `ICOS_WORKER_EXEC_COMMANDS`, no runtime has an adapter, the router's external set is
 * empty, and every dispatch behaves exactly as it did before. Opting in is a deployment
 * decision, not a code change — the same rule decision 0036 set for probe commands.
 *
 * `ICOS_REPO_PATH` is required alongside it: a writer worker needs a canonical repository
 * to branch a worktree FROM, and guessing one (process.cwd()) could point an autonomous
 * agent at whatever directory the server happened to start in.
 */
/**
 * Selects the planner BACKEND (M12, defect 27).
 *
 * There is one planning authority; this only chooses which compute answers it. OmniRoute is
 * preferred when configured, because it is the backend the planner was certified against; a
 * local-process backend is used otherwise. Configuring BOTH is refused rather than silently
 * ranked, because "which model plans ICOS's own work" must be a stated decision, not an
 * accident of precedence.
 *
 * Returns undefined when autonomous planning was never requested — the pre-existing
 * behaviour. If it WAS requested and no backend is usable, the underlying factories throw:
 * fail closed, never a stub.
 */
/**
 * Selects the REVIEWER COMPUTE (M13). Mirrors `buildAutonomousPlanner` exactly, including its
 * refusal to boot when two backends are configured: which model reviewed a change is
 * audit-relevant, so it must never be decided by which environment variable happened to win.
 */
function buildLlmReviewer(env: Env): ReviewerPort | undefined {
  const command = parseReviewerCommand(env.ICOS_REVIEWER_COMMAND);
  /*
   * `ICOS_REVIEWER_MODEL` is what SELECTS the OmniRoute reviewer — not the timeout, which is
   * shared configuration, and not the OmniRoute credentials, which other components need too.
   */
  const omniRouteSelected = env.ICOS_REVIEWER_MODEL !== undefined;

  if (command && omniRouteSelected) {
    throw new Error(
      "QUALITY_REVIEWER_BACKEND_AMBIGUOUS: both ICOS_REVIEWER_COMMAND and OmniRoute are configured; choose one",
    );
  }

  if (command) {
    return new CommandReviewer({
      command: command.command,
      args: command.args,
      timeoutMs: env.ICOS_REVIEWER_TIMEOUT_MS ?? 300_000,
    });
  }

  return createOmniRouteReviewer(env);
}

/**
 * The proposer's compute (M14). Same configured backend as the planner's, run INSIDE the
 * canonical repository so a proposal is grounded in what is actually there — the opposite of
 * the reviewer, which is confined to an empty directory (decision 0047), and for the opposite
 * reason: a proposal is a suggestion everything downstream verifies.
 */
function buildImprovementProposalProvider(env: Env): PlannerCompletionProvider | undefined {
  const command = parsePlannerCommand(env.ICOS_PLANNER_COMMAND);
  if (!command || !env.ICOS_REPO_PATH) return undefined;

  return new CommandPlannerProvider({
    command: command.command,
    args: command.args,
    cwd: env.ICOS_REPO_PATH,
    timeoutMs: env.ICOS_PLANNER_TIMEOUT_MS ?? 300_000,
  });
}

/**
 * `missionFetch` est le `fetch` MESURÉ de la couture « mission » (compteur de dépense,
 * verrou B1) : plafonné par `goals.budget` du goal imputé par la portée d'allumage. Il ne
 * concerne que le planificateur OmniRoute ; un planificateur de commande est un processus
 * local, il n'émet aucun appel facturé.
 */
function buildAutonomousPlanner(
  env: Env,
  missionFetch?: typeof fetch,
): AutonomousMissionPlanner | undefined {
  const command = parsePlannerCommand(env.ICOS_PLANNER_COMMAND);
  /*
   * `ICOS_PLANNER_MODEL` is what SELECTS the OmniRoute planner — the OmniRoute base URL and
   * key alone mean nothing here, because the reviewer requires them too. Treating their mere
   * presence as "a planner backend is configured" would make every deployment ambiguous.
   */
  const omniRouteSelected = env.ICOS_PLANNER_MODEL !== undefined;

  if (command && omniRouteSelected) {
    throw new Error(
      "AUTONOMY_PLANNER_BACKEND_AMBIGUOUS: both ICOS_PLANNER_COMMAND and OmniRoute are configured; choose one",
    );
  }

  if (command) {
    return new CanonicalAutonomousMissionPlanner({
      provider: new CommandPlannerProvider({
        command: command.command,
        args: command.args,
        timeoutMs: env.ICOS_PLANNER_TIMEOUT_MS ?? 300_000,
      }),
      timeoutMs: env.ICOS_PLANNER_TIMEOUT_MS ?? 300_000,
    });
  }

  return createOmniRouteAutonomousMissionPlanner(env, missionFetch);
}

/**
 * Résout la POLITIQUE BORNÉE du déploiement (P0-E/P0-F).
 *
 * Le conteneur est le seul endroit qui connaisse à la fois la configuration et le compute
 * réellement composé ; c'est donc ici que la politique est arrêtée, puis transportée
 * sans être reconstruite nulle part ailleurs.
 *
 * `plannerCompute.modelId` est `ICOS_PLANNER_MODEL` et rien d'autre : c'est la variable
 * qui SÉLECTIONNE le planificateur OmniRoute (voir `buildAutonomousPlanner`), donc le
 * modèle que la planification utilisera vraiment. Un planificateur de PROCESSUS LOCAL
 * n'annonce aucun modèle : sous un goal au pool restreint, il est alors irrésoluble et
 * REFUSÉ — fermé par défaut, jamais un laissez-passer.
 *
 * Le fournisseur est la passerelle configurée, nommée comme le transport se nomme
 * lui-même (`OmniRouteCompletionProvider.name === "omniroute"`).
 */
export function buildAutonomyCompositionPolicy(env: Env): AutonomyCompositionPolicy {
  return {
    options: resolveAutonomyBounds(env),
    systemModelAllowlist: resolveSystemModelAllowlist(env),
    plannerCompute: {
      ...(env.ICOS_PLANNER_MODEL !== undefined ? { modelId: env.ICOS_PLANNER_MODEL } : {}),
      providerId: "omniroute",
    },
  };
}

function buildWorkerExecutor(env: Env): {
  executor: WorkerExecutor;
  runtimes: WorkerRuntimeDescriptor[];
  repoPath: string;
} | null {
  const configured = parseWorkerExecCommands(env.ICOS_WORKER_EXEC_COMMANDS);
  const runtimes = executableRuntimes(configured);
  if (runtimes.length === 0) return null;

  if (!env.ICOS_REPO_PATH) {
    /* Refuse to boot rather than guess where an autonomous writer may commit. */
    throw new Error(
      "ICOS_REPO_PATH_REQUIRED: ICOS_WORKER_EXEC_COMMANDS configures external worker execution, so the canonical repository must be declared explicitly",
    );
  }

  const adapter = new CommandWorkerExecutor(createWorkerExecResolver(configured), {
    failureConfig: parseWorkerFailureConfig(env.ICOS_WORKER_FAILURE_CONFIG),
  });

  return {
    executor: new WorkerExecutor(Object.fromEntries(runtimes.map((r) => [r, adapter]))),
    runtimes,
    repoPath: env.ICOS_REPO_PATH,
  };
}

/**
 * Selects the HTTP probe for a worker that IS a model (M6.1 + live-worker bootstrap).
 *
 * The decision is made from CANONICAL METADATA — `metadata.model`, which
 * `candidateRegistration` sets for every compute candidate — and never from a provider
 * name, so adding a provider stays configuration. A worker without a model is declined
 * (`undefined`) and the runtime-keyed command adapters answer for it, exactly as before.
 *
 * Returns undefined for EVERY worker when OmniRoute is not configured. That is fail-closed
 * and deliberate: a model worker then has no adapter at all, is recorded `unsupported`, and
 * routes nothing. It must NOT quietly inherit the command probe instead — that is the host
 * authority the HTTP probe exists to remove, and a missing gateway credential is not a
 * reason to hand a model probe the server's environment and an agent's toolset.
 */
function buildModelProbeSelector(
  overheadFetch?: typeof fetch,
): (worker: WorkerRegistryEntry) => OmniRouteHttpWorkerProbe | null | undefined {
  const env = loadEnv();
  const probe =
    env.OMNIROUTE_BASE_URL && env.OMNIROUTE_API_KEY
      ? new OmniRouteHttpWorkerProbe({
          baseUrl: env.OMNIROUTE_BASE_URL,
          credential: env.OMNIROUTE_API_KEY,
          timeoutMs: env.ICOS_WORKER_PROBE_HTTP_TIMEOUT_MS,
          /*
           * Mesuré, et SANS PLAFOND par choix nommé (`UNCAPPED_OVERHEAD`) : sonder la santé
           * d'un worker n'est pas de la dépense de mission. Ces appels partent d'un minuteur,
           * sans goal, et les plafonner sous le budget d'un goal ferait d'un budget épuisé
           * une panne de flotte. La ligne est quand même écrite au journal, non imputée.
           */
          ...(overheadFetch ? { fetch: overheadFetch } : {}),
        })
      : null;

  return (worker) => {
    /* Not model compute: the runtime-keyed command adapters answer, exactly as before. */
    if (!isModelWorker(worker)) return undefined;
    /*
     * Model compute. The HTTP probe when it exists, and otherwise `null` — explicitly
     * NOTHING, recorded `unsupported`. It must never fall through to the runtime map:
     * a model worker declares `runtime: "binary"`, so an absent gateway credential would
     * otherwise put all 15 candidates back on the agent CLI, which answers `ok` from
     * starting a runtime and tells us nothing about the model. The whole point of this
     * adapter is that a missing credential loses health, not that it borrows authority.
     */
    return probe;
  };
}

/**
 * Whether a worker IS a model, from canonical metadata only — no provider name.
 *
 * `metadata.model` is what `candidateRegistration` writes and what the probe needs. The
 * `compute:` display-name check is the second door: a compute row whose model metadata was
 * lost (a hand-edited row, a partial reconcile) is still model compute, and must still be
 * refused the command probe rather than quietly inheriting it. It then reaches the HTTP
 * probe's own `WORKER_PROBE_NO_MODEL` guard, which is a diagnosable failure.
 */
function isModelWorker(worker: WorkerRegistryEntry): boolean {
  return probeModelOf(worker) !== null || isComputeCandidate(worker);
}

function buildWorkerProbeAdapters(): Record<string, CommandWorkerProbe> {
  const configured = parseWorkerProbeCommands(loadEnv().ICOS_WORKER_PROBE_COMMANDS);
  const probe = new CommandWorkerProbe(createWorkerProbeResolver(configured));

  return Object.fromEntries(probeableRuntimes(configured).map((runtime) => [runtime, probe]));
}

/** Whether a workflow's task may only run governed — the supervisor's own definition (0052). */
function governedWorkflow(
  attempts: Pick<DispatchAttemptRepository, "getByWorkflowId">,
  taskRepository: Pick<TaskRepository, "getById">,
): (workflowId: string) => Promise<boolean> {
  return async (workflowId) => {
    const attempt = await attempts.getByWorkflowId(workflowId);
    const task = attempt ? await taskRepository.getById(attempt.taskId) : null;
    return (
      task !== null &&
      requiresGovernedWorkspace({
        taskId: task.id,
        title: task.title,
        riskClass: task.riskClass,
        allowedFileScope: task.allowedFileScope,
      })
    );
  };
}

/**
 * A worker allowed to run as long as (or longer than) its execution lease is fenced every time it
 * uses its budget: the lease is not renewed while it runs, so the result is discarded as stale
 * (self-build run 3). Refused at boot rather than discovered twenty minutes into a run.
 *
 * ONE invariant (decision 0054), shared with per-candidate routing: budget + settlement margin
 * <= lease. Equality was already refused; a budget that ends seconds before the lease lapses
 * leaves no time to collect evidence and settle, and is refused now too.
 */
function assertExecutionLeaseOutlivesWorkers(env: Env): void {
  const leaseMs = env.ICOS_WORKER_EXECUTION_LEASE_MS ?? DEFAULT_EXECUTION_LEASE_MS;
  for (const [runtime, command] of Object.entries(parseWorkerExecCommands(env.ICOS_WORKER_EXEC_COMMANDS))) {
    if (command?.timeoutMs !== undefined && !budgetFitsLease(command.timeoutMs, leaseMs)) {
      throw new Error(
        `WORKER_TIMEOUT_EXCEEDS_EXECUTION_LEASE: ${runtime} timeoutMs=${command.timeoutMs} + settlement margin ${SETTLEMENT_MARGIN_MS} > ICOS_WORKER_EXECUTION_LEASE_MS=${leaseMs}`,
      );
    }
  }
}

/**
 * The budget a candidate that declares none will actually run with: ITS runtime's configured
 * timeout, else the executor's default — exactly what the executor would use.
 */
function runtimeDefaultBudgetMs(env: Env): (runtime: WorkerRuntimeDescriptor) => number {
  const commands = parseWorkerExecCommands(env.ICOS_WORKER_EXEC_COMMANDS);
  return (runtime) => commands[runtime]?.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
}

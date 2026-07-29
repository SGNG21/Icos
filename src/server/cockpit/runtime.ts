import { z } from "zod";

import {
  PERMISSION_SUPERVISOR_WORKER_EXECUTE,
  type SystemAgent,
} from "@/core/policy";
import type { RuntimeExecutionPort } from "@/server/runtime/ports";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryMissionContextRepository } from "@/server/context/in-memory/mission-context-repository";
import { GlobalGates } from "@/server/integration/global-gates";
import { IntegrationOrchestrator } from "@/server/integration/integration-orchestrator";
import { MissionService } from "@/server/mission/mission-service";
import { InMemoryMissionRepository } from "@/server/mission/in-memory/mission-repository";
import { InMemoryMissionUnitOfWork } from "@/server/mission/in-memory/mission-uow";
import { PreviewDelivery } from "@/server/preview/preview-delivery";
import { CorrectionWorker, ReviewerWorker } from "@/server/review/reviewer-worker";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import { InMemoryCapabilityRepository } from "@/server/services/in-memory/capability-repository";
import { InMemorySupervisorRepository } from "@/server/supervisor/in-memory/supervisor-repository";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import {
  createMissionFromUserRequest,
  type CreateMissionFromUserRequestDeps,
} from "@/server/usecases/create-mission-from-user-request";
import {
  planAndExecuteMission,
  type PlanAndExecuteMissionDeps,
  type PlanAndExecuteMissionResult,
} from "@/server/usecases/plan-and-execute-mission";
import { DeterministicPatchWorker, type DeterministicPatchCatalog } from "@/server/worker/deterministic-patch-worker";
import { WorkerManager } from "@/server/worker/worker-manager";
import { WorktreeManager } from "@/server/worktree/worktree-manager";
import { D1PolicyService } from "@/server/policy/d1-policy-service";

import {
  COCKPIT_MAX_ITEMS,
  CockpitJobRegistry,
  type CockpitJobProjection,
  type CockpitJobUpdate,
  type CockpitRuntime,
  type CockpitTaskProjection,
  type CreateCockpitJobInput,
} from "./job-registry";
import { projectCockpitJob } from "./projection";

const LOCAL_TENANT_ID = "default";
const RUNTIME_KEY = "__icosCockpitRuntime__";

const createInputSchema = z
  .object({
    tenantId: z.string().min(1).max(128),
    idempotencyKey: z.string().min(1).max(256),
    objective: z.string().min(1).max(2_000),
    requester: z
      .object({
        kind: z.literal("human"),
        id: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();

export type CockpitExecutionResult =
  | ({ status: "SUCCEEDED" } & CockpitJobUpdate)
  | ({ status: "BLOCKED" } & CockpitJobUpdate)
  | ({
      status: "FAILED";
      failure: { code: string; message: string };
    } & CockpitJobUpdate);

export interface CockpitExecutionInput {
  tenantId: string;
  objective: string;
  requester: {
    kind: "human";
    id: string;
  };
  executor: SystemAgent;
}

type ExecuteCockpitJob = (input: CockpitExecutionInput) => Promise<CockpitExecutionResult>;

export interface CockpitRuntimeComponents {
  missionService: MissionService;
  missionContexts: InMemoryMissionContextRepository;
  supervisorRepository: InMemorySupervisorRepository;
  workerManager: WorkerManager;
  supervisorService: SupervisorService;
  deterministicWorkerCatalog: DeterministicPatchCatalog;
  worktreeManager: WorktreeManager;
  integrationOrchestrator: IntegrationOrchestrator;
  jobRegistry: CockpitJobRegistry;
  planAndExecuteMissionDependencies: PlanAndExecuteMissionDeps;
}

interface CockpitRuntimeOptions {
  registry?: CockpitJobRegistry;
  executorIdentity: SystemAgent;
  execute: ExecuteCockpitJob;
  components?: CockpitRuntimeComponents;
}

class ProcessLocalCockpitRuntime implements CockpitRuntime {
  readonly components?: CockpitRuntimeComponents;

  constructor(private readonly options: CockpitRuntimeOptions) {
    this.components = options.components;
  }

  async submitJob(input: CreateCockpitJobInput): Promise<CockpitJobProjection> {
    const parsed = createInputSchema.safeParse(input);
    if (!parsed.success || parsed.data.tenantId !== this.options.executorIdentity.tenantId) {
      throw new Error("Invalid trusted Cockpit submission context.");
    }

    const registry = this.options.registry ?? this.options.components?.jobRegistry;
    if (!registry) throw new Error("Cockpit registry is unavailable.");
    const created = registry.createOrGet(parsed.data);

    if (created.created) {
      queueMicrotask(() => {
        void this.executeAcceptedJob(parsed.data, created.record.jobId).catch(() => {
          try {
            registry.markFailed(
              parsed.data.tenantId,
              created.record.jobId,
              {
                code: "execution_rejected",
                message: "Cockpit execution failed safely.",
              },
            );
          } catch {
            // The promise is intentionally contained; terminal registry state wins.
          }
        });
      });
    }

    return projectCockpitJob(created.record);
  }

  getJob(tenantId: string, jobId: string): CockpitJobProjection | null {
    const registry = this.options.registry ?? this.options.components?.jobRegistry;
    if (!registry) return null;
    const record = registry.get(tenantId, jobId);
    return record ? projectCockpitJob(record) : null;
  }

  private async executeAcceptedJob(
    input: CreateCockpitJobInput,
    jobId: string,
  ): Promise<void> {
    const registry = this.options.registry ?? this.options.components?.jobRegistry;
    if (!registry) return;
    registry.markRunning(input.tenantId, jobId);
    const result = await this.options.execute({
      tenantId: input.tenantId,
      objective: input.objective,
      requester: { ...input.requester },
      executor: structuredClone(this.options.executorIdentity),
    });

    const update = withoutExecutionDiscriminator(result);
    if (result.status === "SUCCEEDED") {
      registry.markSucceeded(input.tenantId, jobId, update);
    } else if (result.status === "BLOCKED") {
      registry.markBlocked(input.tenantId, jobId, update);
    } else {
      registry.markFailed(input.tenantId, jobId, result.failure, update);
    }
  }
}

function withoutExecutionDiscriminator(result: CockpitExecutionResult): CockpitJobUpdate {
  return {
    ...(result.missionId === undefined ? {} : { missionId: result.missionId }),
    ...(result.missionState === undefined ? {} : { missionState: result.missionState }),
    ...(result.planLabel === undefined ? {} : { planLabel: result.planLabel }),
    ...(result.tasks === undefined ? {} : { tasks: result.tasks }),
    ...(result.workers === undefined ? {} : { workers: result.workers }),
    ...(result.blockers === undefined ? {} : { blockers: result.blockers }),
    ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
    ...(result.sanitizedError === undefined
      ? {}
      : { sanitizedError: result.sanitizedError }),
    ...(result.finalResult === undefined ? {} : { finalResult: result.finalResult }),
    ...(result.mergePerformed === undefined
      ? {}
      : { mergePerformed: result.mergePerformed }),
  };
}

function mapTaskStatus(status: string): CockpitTaskProjection["status"] {
  if (status === "SUCCEEDED") return "SUCCEEDED";
  if (status === "FAILED" || status === "CANCELLED") return "FAILED";
  if (status === "RUNNING" || status === "ASSIGNED" || status === "READY") return "RUNNING";
  return "QUEUED";
}

function safeTasks(result: PlanAndExecuteMissionResult): CockpitTaskProjection[] {
  const dag = "dag" in result ? result.dag : undefined;
  if (!dag) return [];
  return Object.values(dag.nodes)
    .slice(0, COCKPIT_MAX_ITEMS)
    .map((node) => ({
      taskId: node.id,
      label: "Bounded local task",
      status: mapTaskStatus(node.status),
    }));
}

function defaultResultMapper(result: PlanAndExecuteMissionResult): CockpitExecutionResult {
  const common: CockpitJobUpdate = {
    ...("missionId" in result && result.missionId ? { missionId: result.missionId } : {}),
    ...("mission" in result && result.mission
      ? { missionState: result.mission.status }
      : {}),
    planLabel: "Bounded local mission plan",
    tasks: safeTasks(result),
    mergePerformed: false,
  };
  if (!result.ok) {
    return {
      status: "FAILED",
      failure: {
        code: result.reason,
        message: "The bounded mission execution failed.",
      },
      ...common,
    };
  }
  if (result.outcome !== "EXECUTED") {
    return {
      status: "BLOCKED",
      blockers: result.blockers.map((blocker) => blocker.reason),
      finalResult: "The bounded mission is blocked.",
      ...common,
    };
  }
  return {
    status: "SUCCEEDED",
    missionState: result.mission.status,
    finalResult: "The bounded local mission completed successfully.",
    evidence: ["Canonical mission and Supervisor state report success."],
    ...common,
  };
}

function createDefaultComposition(): {
  options: CockpitRuntimeOptions;
  components: CockpitRuntimeComponents;
} {
  const audit = new InMemoryAuditRepository(new InMemoryAuditLog());
  const missionRepository = new InMemoryMissionRepository();
  const missionService = new MissionService(
    missionRepository,
    audit,
    new InMemoryMissionUnitOfWork(missionRepository, audit),
  );
  const missionContexts = new InMemoryMissionContextRepository();
  const supervisorRepository = new InMemorySupervisorRepository();
  const policy = new D1PolicyService();
  const deterministicWorkerCatalog: DeterministicPatchCatalog = Object.freeze({
    get: () => undefined,
  });
  const worktreeManager = new WorktreeManager();
  const gates = new GlobalGates();
  const integrationOrchestrator = new IntegrationOrchestrator(gates, worktreeManager);
  const deterministicWorker = new DeterministicPatchWorker(
    policy,
    deterministicWorkerCatalog,
    { taskWorktreeRoot: process.cwd() },
  );
  const unavailableGeneralRuntime: RuntimeExecutionPort = {
    async execute() {
      return {
        ok: false,
        state: "FAILED",
        error: {
          code: "INTERNAL_ERROR",
          message: "No composition-owned general executable behavior is configured.",
          retryable: false,
        },
        latencyMs: 0,
        artifacts: [],
      };
    },
  };
  const workerManager = new WorkerManager(unavailableGeneralRuntime, policy);
  const executorIdentity: SystemAgent = Object.freeze({
    id: "cockpit-supervisor",
    tenantId: LOCAL_TENANT_ID,
    roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
    authorizationLevel: 2,
    justification: "Composition-owned executor for reviewed bounded local work.",
  });
  const supervisorService = new SupervisorService(
    supervisorRepository,
    deterministicWorker,
    worktreeManager,
    new ReviewerWorker("cockpit-independent-reviewer"),
    new CorrectionWorker(3),
    gates,
    integrationOrchestrator,
    new PreviewDelivery({ allowExternalPreview: false }),
    { agentIdentity: executorIdentity },
  );
  const capabilities = new InMemoryCapabilityRepository();
  const planDependencies: PlanAndExecuteMissionDeps = {
    missionService,
    missionContexts,
    capabilitySnapshotDeps: {
      capabilities,
      policy,
    },
    supervisor: supervisorService,
    supervisorRepository,
    clock: () => new Date(),
  };
  const jobRegistry = new CockpitJobRegistry();
  const components: CockpitRuntimeComponents = {
    missionService,
    missionContexts,
    supervisorRepository,
    workerManager,
    supervisorService,
    deterministicWorkerCatalog,
    worktreeManager,
    integrationOrchestrator,
    jobRegistry,
    planAndExecuteMissionDependencies: planDependencies,
  };
  const missionEntryDependencies: CreateMissionFromUserRequestDeps = {
    missionService,
    missionContexts,
  };
  const execute: ExecuteCockpitJob = async (input) => {
    const trusted = {
      tenantId: input.tenantId,
      actorId: input.requester.id,
    };
    const entry = await createMissionFromUserRequest(
      missionEntryDependencies,
      { objective: input.objective },
      trusted,
    );
    if (!entry.ok) {
      return {
        status: "FAILED",
        failure: {
          code: entry.reason,
          message: "The bounded mission could not be created.",
        },
      };
    }
    const result = await planAndExecuteMission(
      planDependencies,
      { missionId: entry.missionId },
      trusted,
    );
    return defaultResultMapper(result);
  };
  return {
    components,
    options: {
      registry: jobRegistry,
      executorIdentity,
      execute,
      components,
    },
  };
}

export function createCockpitRuntimeForTests(input: {
  registry?: CockpitJobRegistry;
  executorIdentity?: SystemAgent;
  execute: ExecuteCockpitJob;
}): CockpitRuntime {
  return new ProcessLocalCockpitRuntime({
    registry: input.registry ?? new CockpitJobRegistry(),
    executorIdentity:
      input.executorIdentity ??
      ({
        id: "test-cockpit-executor",
        tenantId: "tenant-test",
        roles: [],
        authorizationLevel: 0,
        justification: "Explicit test-only composition identity.",
      } satisfies SystemAgent),
    execute: input.execute,
  });
}

type GlobalWithCockpitRuntime = typeof globalThis & {
  [RUNTIME_KEY]?: ProcessLocalCockpitRuntime;
};

export function getCockpitRuntime(): CockpitRuntime {
  const globalRef = globalThis as GlobalWithCockpitRuntime;
  if (!globalRef[RUNTIME_KEY]) {
    const composition = createDefaultComposition();
    globalRef[RUNTIME_KEY] = new ProcessLocalCockpitRuntime(composition.options);
  }
  return globalRef[RUNTIME_KEY];
}

export function resetCockpitRuntimeForTests(): void {
  const globalRef = globalThis as GlobalWithCockpitRuntime;
  delete globalRef[RUNTIME_KEY];
}

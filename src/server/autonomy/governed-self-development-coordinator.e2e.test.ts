import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createImprovementCandidate,
  InMemoryImprovementBacklog,
  type ImprovementCandidate,
} from "@/core/autonomy/improvement-backlog";
import type { SelfModificationPolicyInput } from "@/core/autonomy/self-modification-policy";
import { InMemoryDurableMemory } from "@/core/context/durable-memory";
import type { ReviewDecision, ReviewDecisionRecord } from "@/core/contracts/review";
import type { TaskExecutionResult, WorkerKind } from "@/core/contracts/task-execution";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryTaskExecutionDispatcher } from "@/server/execution/in-memory-task-execution-dispatcher";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { InMemoryDispatchAttemptRepository } from "@/server/services/in-memory/dispatch-attempt-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { InMemoryWorkerRegistry } from "@/server/services/worker-registry/in-memory-worker-registry";
import { Git } from "@/server/workspace-manager/git";
import { IntegrationGate } from "@/server/workspace-manager/integration-gate";
import { WorkspaceManager } from "@/server/workspace-manager/manager";
import { InMemoryWorkspaceRegistry } from "@/server/workspace-manager/registry";
import {
  FakeProvisioner,
  FakeRunner,
  makeRepoFixture,
  type RepoFixture,
} from "@/server/workspace-manager/test-fixtures";
import {
  GovernedSelfDevelopmentCoordinator,
  type CanonicalExecutionHandoff,
  type CanonicalExecutionRequest,
  type CanonicalExecutionResult,
  type CanonicalRepairRequest,
  type IndependentReviewHandoff,
  type IndependentReviewerSelection,
  type GovernedReviewRequest,
  type GovernedReviewResult,
} from "./governed-self-development-coordinator";

const NOW = "2026-09-23T10:00:00.000Z";
const WRITER_ID = "11111111-1111-4111-8111-111111111111";
const REVIEWER_ID = "22222222-2222-4222-8222-222222222222";
const REPAIR_A_ID = "33333333-3333-4333-8333-333333333333";
const REPAIR_B_ID = "44444444-4444-4444-8444-444444444444";
const CAPABILITY = "code.edit";

function worker(id: string, workerKind: WorkerKind): WorkerRegistryEntry {
  return {
    id,
    workerKind,
    displayName: id,
    capabilities: [CAPABILITY],
    features: [],
    supportsTools: true,
    supportsStructuredOutput: true,
    status: "active",
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
    health: "healthy",
    availability: "available",
    tags: [],
    metadata: { source: "phase8e-e2e-fixture" },
    updatedAt: NOW,
  };
}

const workers = [
  worker(REPAIR_A_ID, "agent"),
  worker(REPAIR_B_ID, "other"),
  worker(WRITER_ID, "openhands"),
  worker(REVIEWER_ID, "hermes"),
];

interface ExecutionScenario {
  initialStatus?: "COMPLETED" | "UNKNOWN";
  initialCandidateId?: string;
  repairStatus?: "COMPLETED" | "UNKNOWN";
  repairCandidateId?: string;
  repairWorkflowId?: string;
}

class DurableFixtureExecutionHandoff implements CanonicalExecutionHandoff {
  readonly executeCalls: CanonicalExecutionRequest[] = [];
  readonly repairCalls: CanonicalRepairRequest[] = [];

  constructor(
    private readonly dispatchAttempts: InMemoryDispatchAttemptRepository,
    private readonly dispatcher: TaskExecutionDispatcher,
    private readonly workspaceId: string,
    private readonly scenario: ExecutionScenario = {},
  ) {}

  async execute(input: CanonicalExecutionRequest): Promise<CanonicalExecutionResult> {
    this.executeCalls.push(input);
    if (this.scenario.initialStatus === "UNKNOWN") {
      return { status: "UNKNOWN", reason: "canonical execution availability unknown" };
    }

    const workflowId = workflowIdForAttempt(input.taskId, 1);
    const prepared = await this.dispatchAttempts.prepare({
      missionId: input.missionId,
      missionTaskId: input.missionTaskId,
      taskId: input.taskId,
      attempt: 1,
      workflowId,
      prompt: input.candidate.description,
      workerKind: "openhands",
      capability: CAPABILITY,
    });
    const dispatched = await this.dispatcher.dispatch({
      missionId: input.missionId,
      taskId: input.taskId,
      taskTitle: input.missionTask.title,
      prompt: input.candidate.description,
      workflowId: prepared.attempt.workflowId,
      workerKind: "openhands",
      capability: CAPABILITY,
    });
    await this.dispatchAttempts.markDispatched(prepared.attempt.id);

    return {
      status: "COMPLETED",
      candidateId: this.scenario.initialCandidateId ?? input.candidate.id,
      missionId: input.missionId,
      missionTaskId: input.missionTaskId,
      taskId: input.taskId,
      workspaceId: this.workspaceId,
      workspaceLease: { owner: WRITER_ID, fencingToken: 1 },
      producerWorkerId: WRITER_ID,
      executionResult: executionResult({
        id: "execution-initial",
        taskId: input.taskId,
        workflowId: dispatched.workflowId,
        workerKind: "openhands",
      }),
    };
  }

  async repair(input: CanonicalRepairRequest): Promise<CanonicalExecutionResult> {
    this.repairCalls.push(input);
    if (this.scenario.repairStatus === "UNKNOWN") {
      return { status: "UNKNOWN", reason: "repair execution availability unknown" };
    }

    return {
      status: "COMPLETED",
      candidateId: this.scenario.repairCandidateId ?? input.candidate.id,
      missionId: input.missionId,
      missionTaskId: input.missionTaskId,
      taskId: input.taskId,
      workspaceId: this.workspaceId,
      workspaceLease: { owner: WRITER_ID, fencingToken: 1 },
      producerWorkerId: input.repairCandidate.worker.id,
      executionResult: executionResult({
        id: `execution-repair-${input.repairCandidate.attemptNumber}`,
        taskId: input.taskId,
        workflowId: this.scenario.repairWorkflowId ?? input.canonicalWorkflowId,
        workerKind: input.repairCandidate.worker.workerKind,
      }),
    };
  }
}

function executionResult(input: {
  id: string;
  taskId: string;
  workflowId: string;
  workerKind: WorkerKind;
}): TaskExecutionResult {
  return {
    ...input,
    outcome: "success",
    capability: CAPABILITY,
    result: "factual execution result",
    completedAt: NOW,
    recordedAt: NOW,
    evidence: [],
    findings: [],
  };
}

interface ReviewScenario {
  decisions?: ReviewDecision[];
  reviewerIds?: string[];
  selectionUnknown?: boolean;
  decisionCandidateId?: string;
}

class ScriptedReviewHandoff implements IndependentReviewHandoff {
  readonly selectionCalls: Array<{ candidateId: string; producerWorkerId: string }> = [];
  readonly reviewCalls: GovernedReviewRequest[] = [];
  private selectionIndex = 0;
  private reviewIndex = 0;

  constructor(private readonly scenario: ReviewScenario = {}) {}

  async selectReviewer(input: {
    candidateId: string;
    producerWorkerId: string;
  }): Promise<IndependentReviewerSelection> {
    this.selectionCalls.push(input);
    if (this.scenario.selectionUnknown) {
      return {
        status: "UNKNOWN",
        candidateId: input.candidateId,
        reason: "reviewer availability unknown",
      };
    }
    const reviewerWorkerId = this.scenario.reviewerIds?.[this.selectionIndex++] ?? REVIEWER_ID;
    return {
      status: "SELECTED",
      candidateId: input.candidateId,
      reviewerWorkerId,
    };
  }

  async review(input: GovernedReviewRequest): Promise<GovernedReviewResult> {
    this.reviewCalls.push(input);
    const decision = this.scenario.decisions?.[this.reviewIndex] ?? "APPROVE";
    const index = ++this.reviewIndex;
    const record: ReviewDecisionRecord = {
      id: `review-${index}`,
      missionId: input.missionId,
      taskId: input.taskId,
      workflowId: input.executionResult.workflowId,
      decision,
      reviewerKind: "llm",
      severity: decision === "APPROVE" ? "info" : "warning",
      reasons: [decision === "APPROVE" ? "accepted" : "repair required"],
      requestedChanges:
        decision === "REQUEST_CHANGES"
          ? [{ field: "implementation", reason: "repair required" }]
          : [],
      evidenceRefs: [],
      createdAt: NOW,
      humanOverridden: false,
    };
    return {
      candidateId: this.scenario.decisionCandidateId ?? input.candidateId,
      reviewerWorkerId: input.reviewerWorkerId,
      decision: record,
    };
  }
}

interface HarnessOptions {
  candidate?: ImprovementCandidate;
  policy?: Partial<SelfModificationPolicyInput>;
  execution?: ExecutionScenario;
  review?: ReviewScenario;
  maxRepairAttempts?: number;
  gateReject?: boolean;
  gateUnknown?: boolean;
}

interface Harness {
  candidate: ImprovementCandidate;
  missionId: string;
  missionTaskId: string;
  taskId: string;
  request: {
    candidate: ImprovementCandidate;
    missionId: string;
    missionTaskId: string;
    taskId: string;
    policy: SelfModificationPolicyInput;
  };
  coordinator: GovernedSelfDevelopmentCoordinator;
  backlog: InMemoryImprovementBacklog;
  memory: InMemoryDurableMemory;
  execution: DurableFixtureExecutionHandoff;
  review: ScriptedReviewHandoff;
  integrate: ReturnType<typeof vi.fn>;
  runner: FakeRunner;
  cleanup(): void;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const audit = new InMemoryAuditLog();
  const tasks = new InMemoryTaskRepository(audit);
  const missions = new InMemoryMissionRepository(tasks);
  const mission = await missions.create({
    title: "Phase 8E mission",
    objective: "Wire governed self-development",
    tasks: [
      {
        title: "Implement candidate",
        description: "Implement the candidate change",
        dependsOn: [],
        workerKind: "openhands",
        capability: CAPABILITY,
      },
    ],
  });
  const missionTask = (await missions.listTasks(mission.id))[0];
  const dispatchAttempts = new InMemoryDispatchAttemptRepository(missions, tasks);

  const fx: RepoFixture = makeRepoFixture();
  cleanups.push(() => fx.cleanup());
  const git = new Git(fx.master);
  const provisioner = new FakeProvisioner();
  const manager = new WorkspaceManager({
    git,
    registry: new InMemoryWorkspaceRegistry(),
    provisioner,
    worktreeRoot: fx.root,
    masterRepo: fx.master,
  });
  const requested = await manager.request({
    slug: "phase8e",
    workerId: WRITER_ID,
    workflowId: "governed-self-development-fixture",
    missionId: mission.id,
    taskId: missionTask.taskId,
    fileScope: { owns: ["src/feature/**"], shared: [], forbidden: [] },
  });
  const lease = await manager.acquireLease(requested.workspaceId, WRITER_ID, 60_000);
  await manager.create(requested.workspaceId, WRITER_ID, lease.fencingToken);
  await manager.transition(requested.workspaceId, "working", WRITER_ID, lease.fencingToken);
  fx.write(requested.worktreePath, "src/feature/change.ts", "export const governed = true;\n");
  fx.commit(requested.worktreePath, "candidate implementation");
  await manager.transition(requested.workspaceId, "validating", WRITER_ID, lease.fencingToken);
  await manager.transition(requested.workspaceId, "ready_for_integration", WRITER_ID, lease.fencingToken);

  const runner = new FakeRunner();
  if (options.gateReject) runner.failing = ["typecheck"];
  const gate = new IntegrationGate({ git, manager, runner, database: provisioner });
  const integrate = vi.fn(async (...args: Parameters<IntegrationGate["integrate"]>) => {
    const report = await gate.integrate(...args);
    return options.gateUnknown ? { ...report, decision: "UNKNOWN" as never } : report;
  });

  const candidate =
    options.candidate ??
    createImprovementCandidate({
      title: "Improve test coverage",
      description: "Add a focused integration test",
      rationale: "Protect the governed self-development flow",
      category: "maintainability",
      targetComponent: "src/feature/change.ts",
      priority: "high",
      proposedBy: WRITER_ID,
    });
  const policy: SelfModificationPolicyInput = {
    targetPaths: [candidate.targetComponent],
    changeDescription: candidate.description,
    improvementCategory: "test-coverage",
    isSelfProposed: true,
    actor: candidate.proposedBy,
    ...options.policy,
  };

  const backlog = new InMemoryImprovementBacklog();
  const memory = new InMemoryDurableMemory();
  const registry = new InMemoryWorkerRegistry(workers);
  const execution = new DurableFixtureExecutionHandoff(
    dispatchAttempts,
    new InMemoryTaskExecutionDispatcher(),
    requested.workspaceId,
    options.execution,
  );
  const review = new ScriptedReviewHandoff(options.review);
  const coordinator = new GovernedSelfDevelopmentCoordinator(
    {
      backlog,
      missions,
      dispatchAttempts,
      workerRegistry: registry,
      execution,
      review,
      integrationGate: { integrate },
      durableMemory: memory,
    },
    {
      maxRepairAttempts: options.maxRepairAttempts,
      now: () => new Date(NOW),
    },
  );

  return {
    candidate,
    missionId: mission.id,
    missionTaskId: missionTask.id,
    taskId: missionTask.taskId,
    request: {
      candidate,
      missionId: mission.id,
      missionTaskId: missionTask.id,
      taskId: missionTask.taskId,
      policy,
    },
    coordinator,
    backlog,
    memory,
    execution,
    review,
    integrate,
    runner,
    cleanup: () => fx.cleanup(),
  };
}

describe("GovernedSelfDevelopmentCoordinator Phase 8E E2E", () => {
  it("runs candidate -> backlog -> policy -> canonical execution -> independent review -> gate -> learning -> merge-ready", async () => {
    const h = await createHarness();

    const outcome = await h.coordinator.process(h.request);

    expect(outcome).toMatchObject({
      candidateId: h.candidate.id,
      missionId: h.missionId,
      missionTaskId: h.missionTaskId,
      taskId: h.taskId,
      workflowId: workflowIdForAttempt(h.taskId, 1),
      finalState: "merge_ready",
      gateDecision: "ACCEPT",
      repairAttemptsUsed: 0,
    });
    expect((await h.backlog.get(h.candidate.id))?.status).toBe("approved");
    expect(h.execution.executeCalls).toHaveLength(1);
    expect(h.review.reviewCalls).toHaveLength(1);
    expect(h.integrate).toHaveBeenCalledWith(expect.any(String), {
      review: { verdict: "APPROVED", reviewer: REVIEWER_ID },
      lease: { owner: WRITER_ID, fencingToken: 1 },
    });
    const patterns = await h.memory.getPatterns({});
    expect(patterns.flatMap((pattern) => pattern.missionIds ?? [])).toContain(h.missionId);
    expect(patterns.reduce((count, pattern) => count + pattern.occurrenceCount, 0)).toBe(3);
  });

  it("denies protected policy before execution and never invokes the gate", async () => {
    const h = await createHarness({
      policy: {
        targetPaths: ["src/core/contracts/policy.ts"],
        improvementCategory: "test-coverage",
      },
    });

    const outcome = await h.coordinator.process(h.request);

    expect(outcome.finalState).toBe("policy_denied");
    expect(outcome.reason).toContain("protected");
    expect(h.execution.executeCalls).toHaveLength(0);
    expect(h.integrate).not.toHaveBeenCalled();
    expect((await h.backlog.get(h.candidate.id))?.status).toBe("rejected");
  });

  it("repairs a rejected review and preserves the canonical workflow lineage", async () => {
    const h = await createHarness({
      review: { decisions: ["REQUEST_CHANGES", "APPROVE"] },
    });

    const outcome = await h.coordinator.process(h.request);

    expect(outcome.finalState).toBe("merge_ready");
    expect(outcome.repairAttemptsUsed).toBe(1);
    expect(h.execution.repairCalls).toHaveLength(1);
    expect(h.execution.repairCalls[0].canonicalWorkflowId).toBe(workflowIdForAttempt(h.taskId, 1));
    expect(h.review.reviewCalls.map((call) => call.executionResult.workflowId)).toEqual([
      workflowIdForAttempt(h.taskId, 1),
      workflowIdForAttempt(h.taskId, 1),
    ]);
    expect(h.integrate).toHaveBeenCalledTimes(1);
    expect(
      (await h.memory.getPatterns({})).reduce(
        (count, pattern) => count + pattern.occurrenceCount,
        0,
      ),
    ).toBe(5);
  });

  it("escalates when bounded repair is exhausted and never invokes IntegrationGate", async () => {
    const h = await createHarness({
      maxRepairAttempts: 1,
      review: { decisions: ["REQUEST_CHANGES", "REQUEST_CHANGES"] },
    });

    const outcome = await h.coordinator.process(h.request);

    expect(outcome.finalState).toBe("human_decision_required");
    expect(outcome.reason).toContain("EXHAUSTED");
    expect(outcome.repairAttemptsUsed).toBe(1);
    expect(h.execution.repairCalls).toHaveLength(1);
    expect(h.integrate).not.toHaveBeenCalled();
  });

  it("fails closed on candidate correlation mismatch and never reaches acceptance", async () => {
    const h = await createHarness({ execution: { initialCandidateId: "candidate-mismatch" } });

    const outcome = await h.coordinator.process(h.request);

    expect(outcome.finalState).toBe("human_decision_required");
    expect(outcome.reason).toContain("CORRELATION_ERROR");
    expect(h.review.reviewCalls).toHaveLength(0);
    expect(h.integrate).not.toHaveBeenCalled();
  });

  it("fails closed before review when producer and reviewer identities conflict", async () => {
    const h = await createHarness({ review: { reviewerIds: [WRITER_ID] } });

    const outcome = await h.coordinator.process(h.request);

    expect(outcome.finalState).toBe("human_decision_required");
    expect(outcome.reason).toContain("REVIEWER_INDEPENDENCE_FAILED");
    expect(h.review.reviewCalls).toHaveLength(0);
    expect(h.integrate).not.toHaveBeenCalled();
  });

  it("keeps a real IntegrationGate rejection factual and does not return merge-ready", async () => {
    const h = await createHarness({ gateReject: true });

    const outcome = await h.coordinator.process(h.request);

    expect(outcome.finalState).toBe("gate_rejected");
    expect(outcome.gateDecision).toBe("REJECT");
    expect((await h.backlog.get(h.candidate.id))?.status).toBe("rejected");
    const gatePattern = (await h.memory.getPatterns({})).find(
      (pattern) => pattern.signature.findingCategory === "integration_gate",
    );
    expect(gatePattern).toMatchObject({ outcome: "failure", occurrenceCount: 1 });
    expect(gatePattern?.observations.join(" ")).toContain("REJECT");
  });

  it("persists each factual event once without synthetic scores and preserves mission identity", async () => {
    const h = await createHarness();

    const first = await h.coordinator.process(h.request);
    const firstPatterns = await h.memory.getPatterns({});
    const firstOccurrences = firstPatterns.reduce(
      (count, pattern) => count + pattern.occurrenceCount,
      0,
    );
    const second = await h.coordinator.process(h.request);
    const secondPatterns = await h.memory.getPatterns({});

    expect(first.finalState).toBe("merge_ready");
    expect(second.finalState).toBe("human_decision_required");
    expect(secondPatterns.reduce((count, pattern) => count + pattern.occurrenceCount, 0)).toBe(
      firstOccurrences,
    );
    expect(firstOccurrences).toBe(3);
    expect(h.integrate).toHaveBeenCalledTimes(1);
    for (const pattern of secondPatterns) {
      expect(pattern.missionIds).toEqual([h.missionId]);
      expect(pattern).not.toHaveProperty("confidence");
      expect(pattern).not.toHaveProperty("qualityScore");
      expect(pattern).not.toHaveProperty("reliabilityScore");
      expect(new Set(pattern.sourceOutcomeIds).size).toBe(pattern.sourceOutcomeIds?.length);
    }
  });

  it("fails closed when policy classification is UNKNOWN", async () => {
    const h = await createHarness({
      policy: { improvementCategory: "unclassified-autonomy-change" },
    });

    const outcome = await h.coordinator.process(h.request);

    expect(outcome.finalState).toBe("policy_denied");
    expect(outcome.reason).toContain("UNKNOWN");
    expect(h.execution.executeCalls).toHaveLength(0);
    expect(h.integrate).not.toHaveBeenCalled();
  });

  it("fails closed when canonical execution availability is UNKNOWN", async () => {
    const h = await createHarness({ execution: { initialStatus: "UNKNOWN" } });

    const outcome = await h.coordinator.process(h.request);

    expect(outcome.finalState).toBe("human_decision_required");
    expect(outcome.reason).toContain("EXECUTION_UNKNOWN");
    expect(h.review.reviewCalls).toHaveLength(0);
    expect(h.integrate).not.toHaveBeenCalled();
  });

  it("fails closed when reviewer availability is UNKNOWN", async () => {
    const h = await createHarness({ review: { selectionUnknown: true } });

    const outcome = await h.coordinator.process(h.request);

    expect(outcome.finalState).toBe("human_decision_required");
    expect(outcome.reason).toContain("REVIEWER_UNKNOWN");
    expect(h.review.reviewCalls).toHaveLength(0);
    expect(h.integrate).not.toHaveBeenCalled();
  });

  it("fails closed when IntegrationGate returns an unknown decision", async () => {
    const h = await createHarness({ gateUnknown: true });

    const outcome = await h.coordinator.process(h.request);

    expect(outcome.finalState).toBe("human_decision_required");
    expect(outcome.reason).toContain("UNKNOWN_GATE_DECISION");
    expect(outcome.finalState).not.toBe("merge_ready");
  });
});

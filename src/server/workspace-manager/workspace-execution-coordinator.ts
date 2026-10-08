import { randomUUID } from "node:crypto";

import type { Git } from "./git";
import type { WorkspaceManager } from "./manager";
import { WorkspaceError, type FileScope } from "./types";
import type { IntegrationGate } from "./integration-gate";
import type { IntegrationApplier, IntegrationApplyOutcome } from "./integration-applier";

/** The slice of a canonical review decision the gate needs. */
export interface ReviewLike {
  decision: string;
  reviewerKind?: string;
  providerMetadata?: { provider?: string; model?: string; routing?: Record<string, unknown> };
}
import type { IntegrationReport } from "./report";
import { reviewerEffectiveIdentity, writerEffectiveModel } from "@/core/workers/compute-routing";

import type { TaskExecutionDispatcher, TaskExecutionDispatchInput } from "@/server/execution/ports";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { DurableMemory } from "@/core/context/durable-memory";

export interface WorkspaceExecutionCoordinatorOptions {
  git: Git;
  manager: WorkspaceManager;
  integrationGate: IntegrationGate;
  /**
   * APPLIES an ACCEPTed result to the integration target (M8, defect 19).
   *
   * Optional, and absent means the pre-M8 behaviour EXACTLY: the gate decides and the
   * branch waits for a human. A deployment opts in to autonomous integration; it is never
   * switched on by upgrading.
   */
  integrationApplier?: IntegrationApplier;
  /**
   * The CANONICAL review decisions, looked up by workflowId (M8, defect 19).
   *
   * Without this the gate's `review` step never receives a verdict and always answers
   * NEEDS_HUMAN_APPROVAL — correct, and the reason an autonomous run could never reach
   * ACCEPT. Supplying it connects the EXISTING reviewer to the gate; it does not introduce
   * a second review authority, and the gate still refuses a reviewer that is the worker.
   */
  reviewDecisions?: { getByWorkflowId(workflowId: string): Promise<ReviewLike | null> };
  /**
   * The attempt ledger, read for the WRITER's effective model (decision 0054) so the gate can
   * refuse a same-model review. Absent: the writer's model is unknown, as before.
   */
  writerAttempts?: {
    getByWorkflowId(workflowId: string): Promise<{ routingDecision?: Record<string, unknown> } | null>;
  };
  dispatcher: TaskExecutionDispatcher;
  missions: MissionRepository;
  tasks: TaskRepository;
  durableMemory: DurableMemory;
  defaultIntegrationTarget?: string;
  defaultFileScope?: {
    owns: string[];
    shared: string[];
    forbidden: string[];
  };
  leaseMs?: number;
  leaseRenewalIntervalMs?: number;
  ownerToken?: string;
}

export interface ExecutionWorkspace {
  workspaceId: string;
  taskId: string;
  missionId: string;
  status: "allocated" | "executing" | "completed" | "failed" | "released";
  allocatedAt: string;
  releasedAt?: string;
  workflowId?: string;
  fencingToken?: number;
  executionResult?: {
    outcome: string;
    result?: string;
    error?: string;
  };
}

export interface CoordinationResult {
  workspaceId: string;
  taskId: string;
  success: boolean;
  decision?: "ACCEPT" | "REJECT" | "NEEDS_REBASE" | "NEEDS_HUMAN_APPROVAL";
  reasons?: string[];
  workflowId?: string;
  error?: string;
  /** Present only when an applier is composed AND the gate returned ACCEPT (M8). */
  integration?: IntegrationApplyOutcome;
  /**
   * True when execution finished but NO canonical review exists yet (M13, defect 28).
   *
   * Not a failure and not an escalation: the workspace is durable, holds its commits, and is
   * waiting for QC. A later governed pass gates it once a review is persisted.
   */
  awaitingReview?: boolean;
  /** The gate ACCEPTed but the apply integrated nothing (NEEDS_REBASE / RACE_LOST): in flight. */
  awaitingIntegration?: boolean;
}

function isIntegrated(outcome: IntegrationApplyOutcome | undefined): boolean {
  return outcome?.status === "INTEGRATED" || outcome?.status === "ALREADY_INTEGRATED";
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_LEASE_RENEWAL_INTERVAL_MS = 60 * 1000;

/**
 * Workspace Execution Coordinator
 *
 * Phase 8D implementation:
 * - Idempotent workspace allocation per task (one writer per worktree)
 * - Workspace-aware dispatcher bridge (routes dispatch to workspace context)
 * - Lease renewal / restart reconciliation (coordinates with AutonomousMissionRunner)
 * - QC ACCEPT → IntegrationGate handoff (quality gate before integration)
 * - Recovery integration / fail-closed cases (handles all error paths)
 * - End-to-end 8D proof (coordination flow testable)
 */
export class WorkspaceExecutionCoordinator {
  private readonly git: Git;
  private readonly manager: WorkspaceManager;
  private readonly integrationGate: IntegrationGate;
  private readonly integrationApplier?: IntegrationApplier;
  private readonly reviewDecisions?: WorkspaceExecutionCoordinatorOptions["reviewDecisions"];
  private readonly writerAttempts?: WorkspaceExecutionCoordinatorOptions["writerAttempts"];
  private readonly dispatcher: TaskExecutionDispatcher;
  private readonly missions: MissionRepository;
  private readonly tasks: TaskRepository;
  private readonly durableMemory: DurableMemory;
  private readonly defaultIntegrationTarget: string;
  private readonly defaultFileScope: {
    owns: string[];
    shared: string[];
    forbidden: string[];
  };
  private readonly leaseMs: number;
  private readonly leaseRenewalIntervalMs: number;
  private readonly ownerToken: string;

  // In-memory execution workspace tracking (durable state in mission/tasks)
  private executionWorkspaces = new Map<string, ExecutionWorkspace>();

  // Lease renewal timers
  private leaseTimers = new Map<string, NodeJS.Timeout>();
  private leaseRenewals = new Map<string, Promise<void>>();
  private ownershipLost = new Set<string>();

  constructor(options: WorkspaceExecutionCoordinatorOptions) {
    this.git = options.git;
    this.manager = options.manager;
    this.integrationGate = options.integrationGate;
    this.integrationApplier = options.integrationApplier;
    this.reviewDecisions = options.reviewDecisions;
    this.writerAttempts = options.writerAttempts;
    this.dispatcher = options.dispatcher;
    this.missions = options.missions;
    this.tasks = options.tasks;
    this.durableMemory = options.durableMemory;
    this.defaultIntegrationTarget = options.defaultIntegrationTarget ?? "integration/phase-7";
    this.defaultFileScope = options.defaultFileScope ?? {
      owns: [],
      shared: [],
      forbidden: ["drizzle/", "config/", ".github/", "docker/", "*.md"],
    };
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.leaseRenewalIntervalMs =
      options.leaseRenewalIntervalMs ?? DEFAULT_LEASE_RENEWAL_INTERVAL_MS;
    this.ownerToken = options.ownerToken ?? `workspace-execution-coordinator:${randomUUID()}`;
  }

  /**
   * Allocate or reuse a workspace for a task (idempotent).
   * One writer per worktree invariant enforced.
   */
  async allocateWorkspace(
    missionId: string,
    taskId: string,
    workerId: string,
    slugHint?: string,
    workflowId?: string,
    /**
     * The task's DECLARED file scope (M9, defect 23).
     *
     * Not cosmetic: the Integration Gate REJECTS every changed file outside `owns`, so a
     * workspace built from a generic default would turn each governed run into a
     * rejection. The scope the planner declared is the scope the gate enforces — one
     * source of truth, not two.
     */
    fileScope?: FileScope,
  ): Promise<ExecutionWorkspace> {
    /*
     * THE REGISTRY DECIDES WHETHER A BINDING STILL HOLDS, not this map.
     *
     * The in-memory record was treated as authoritative about release, so a workspace
     * released by anyone else — a reaping sweep, recovery, or the self-development
     * coordinator settling a refused attempt — left a stale binding here. The next attempt
     * for that task was then refused with WORKFLOW_COLLISION against a workspace that no
     * longer existed, which is what stopped every correction attempt from being allocated.
     * The durable row is the truth; this map is a cache.
     */
    const existing = this.executionWorkspaces.get(taskId);
    const durable =
      existing && existing.status !== "released"
        ? await this.manager.get(existing.workspaceId).catch(() => null)
        : null;
    const stillHeld = durable !== null && durable.releasedAt === null;

    if (existing && stillHeld) {
      if (workflowId && existing.workflowId && existing.workflowId !== workflowId) {
        throw new Error(
          `WORKFLOW_COLLISION: task ${taskId} is bound to ${existing.workflowId}, not ${workflowId}`,
        );
      }
      return existing;
    }
    if (existing && !stillHeld) {
      /* The binding is gone; forget it rather than letting it refuse the successor. */
      existing.status = "released";
      existing.releasedAt = existing.releasedAt ?? new Date().toISOString();
      this.stopLeaseRenewal(existing.workspaceId);
    }

    // Create new workspace
    const slug = slugHint ?? `task-${taskId.slice(0, 8)}`;
    const workspace = await this.manager.request({
      slug,
      workerId,
      missionId,
      taskId,
      workflowId,
      integrationTarget: this.defaultIntegrationTarget,
      fileScope: fileScope ?? this.defaultFileScope,
      migrations: 0,
    });

    const leaseIsOursAndValid =
      workspace.leaseOwner === this.ownerToken &&
      workspace.leaseExpiresAt !== null &&
      Date.parse(workspace.leaseExpiresAt) > Date.now();
    const leased = leaseIsOursAndValid
      ? await this.manager.renewLease(
          workspace.workspaceId,
          this.ownerToken,
          workspace.fencingToken,
          this.leaseMs,
        )
      : await this.manager.acquireLease(workspace.workspaceId, this.ownerToken, this.leaseMs);
    if (workspace.status === "requested") {
      await this.manager.create(workspace.workspaceId, this.ownerToken, leased.fencingToken);
    }

    const execWs: ExecutionWorkspace = {
      workspaceId: workspace.workspaceId,
      taskId,
      missionId,
      status: "allocated",
      allocatedAt: new Date().toISOString(),
      workflowId: workspace.workflowId ?? undefined,
      fencingToken: leased.fencingToken,
    };

    this.executionWorkspaces.set(taskId, execWs);
    this.startLeaseRenewal(workspace.workspaceId, this.ownerToken, leased.fencingToken);

    return execWs;
  }

  /**
   * Execute a task within its allocated workspace.
   * Bridges dispatcher with workspace context.
   */
  async executeInWorkspace(
    missionId: string,
    taskId: string,
    input: Omit<TaskExecutionDispatchInput, "workflowId"> & { workflowId?: string },
    humanApprovedBy?: string,
  ): Promise<CoordinationResult> {
    const execWs = this.executionWorkspaces.get(taskId);
    if (!execWs) {
      throw new Error(`No workspace allocated for task ${taskId}`);
    }

    if (execWs.status === "released") {
      throw new Error(`Workspace for task ${taskId} already released`);
    }

    const ws = await this.manager.get(execWs.workspaceId);
    if (ws.releasedAt !== null) {
      throw new Error(`Workspace ${execWs.workspaceId} has been released`);
    }

    await this.assertOwned(execWs);

    // Transition to executing
    execWs.status = "executing";
    await this.manager.transition(
      execWs.workspaceId,
      "working",
      this.ownerToken,
      execWs.fencingToken,
    );

    try {
      // Dispatch execution via dispatcher (workspace-aware)
      const workflowId = input.workflowId ?? execWs.workflowId;
      if (!workflowId) {
        throw new Error(
          "MISSING_CANONICAL_WORKFLOW_ID: canonical workflowId must be supplied from durable dispatch identity",
        );
      }
      const dispatchInput: TaskExecutionDispatchInput = {
        ...input,
        workflowId,
      };

      execWs.workflowId = workflowId;

      await this.assertOwned(execWs);
      const result = await this.dispatcher.dispatch(dispatchInput);

      // Verify workflowId matches (idempotency)
      if (result.workflowId !== workflowId) {
        throw new Error(
          `DISPATCH_WORKFLOW_ID_MISMATCH: expected ${workflowId}, got ${result.workflowId}`,
        );
      }
      await this.assertOwned(execWs);

      // Record execution result in coordination state
      execWs.executionResult = {
        outcome: "success",
        result: `Workflow ${workflowId} dispatched successfully`,
      };

      // Transition workspace to validating (ready for QC/IntegrationGate)
      await this.manager.transition(
        execWs.workspaceId,
        "validating",
        this.ownerToken,
        execWs.fencingToken,
      );
      execWs.status = "completed";

      /*
       * THE GATE RUNS ONLY AFTER AN INDEPENDENT REVIEW EXISTS (M13, defect 28).
       *
       * It used to run here unconditionally, consulting a review QC had not written yet — QC
       * reviews on a LATER sweep, after the result is recorded. So the gate answered
       * NEEDS_HUMAN_APPROVAL for every unreviewed run, and the CORE3 certification had to
       * PRE-PERSIST an approval to get past it. That pre-seeding was a certification
       * artifact hiding a real ordering defect.
       *
       * Absent review is neither approval nor escalation. The workspace stays durable and
       * `ready_for_integration`, and `gatePendingReview()` gates it on a later pass.
       */
      const pendingReview = await this.resolveReview(workflowId);
      if (!pendingReview) {
        /*
         * Idempotent: a second pass over work that is already waiting must not attempt a
         * self-transition, which the lifecycle rightly forbids.
         */
        const current = await this.manager.get(execWs.workspaceId);
        if (current.status !== "ready_for_integration") {
          await this.manager.transition(
            execWs.workspaceId,
            "ready_for_integration",
            this.ownerToken,
            execWs.fencingToken,
          );
        }
        return {
          workspaceId: execWs.workspaceId,
          taskId,
          /*
           * NOT success: nothing was accepted or integrated. NOT failure either — the work
           * is intact and waiting. The caller must not mark the task terminal on this.
           */
          success: false,
          awaitingReview: true,
          workflowId,
        };
      }

      const withdrawn = await this.refuseWithdrawnWork(execWs);
      if (withdrawn) return withdrawn;

      const gateResult = await this.handoffToIntegrationGate(
        execWs.workspaceId,
        workflowId,
        humanApprovedBy,
      );

      /*
       * ACCEPT -> APPLY (M8, defect 19).
       *
       * This is the step that was missing: the gate granted `accepted` and nothing ever
       * moved the canonical branch, so worker branches accumulated indefinitely. The apply
       * runs HERE, inside the one component that already owns the workspace lease and its
       * fencing token, so the integration is fenced by the same evidence that authorised
       * the execution — a stale coordinator cannot integrate.
       */
      const integration =
        gateResult.decision === "ACCEPT" && this.integrationApplier
          ? await this.integrationApplier.apply(execWs.workspaceId, {
              lease: { owner: this.ownerToken, fencingToken: execWs.fencingToken! },
            })
          : undefined;

      /*
       * ACCEPT IS NOT DONE UNTIL IT IS APPLIED (INLINE_GATE_NEEDS_REBASE_DEFECT). An ACCEPT whose
       * apply answered NEEDS_REBASE / RACE_LOST integrated nothing: reported as success, the
       * supervisor marked the task `succeeded` and released the workspace, so dependents ran on
       * a target without the work. It stays in flight, awaiting integration.
       */
      const accepted = gateResult.decision === "ACCEPT";
      const landed = !this.integrationApplier || isIntegrated(integration);
      return {
        workspaceId: execWs.workspaceId,
        taskId,
        success: accepted && landed,
        awaitingIntegration: accepted && !landed,
        decision: gateResult.decision,
        reasons: gateResult.reasons,
        workflowId,
        integration,
      };
    } catch (error) {
      execWs.status = "failed";
      execWs.executionResult = {
        outcome: "failure",
        error: error instanceof Error ? error.message : String(error),
      };

      await this.manager
        .transition(execWs.workspaceId, "blocked", this.ownerToken, execWs.fencingToken)
        .catch(() => undefined);

      // For workflowId mismatch, throw to maintain fail-closed behavior
      if (error instanceof Error && error.message.includes("DISPATCH_WORKFLOW_ID_MISMATCH")) {
        throw error;
      }

      return {
        workspaceId: execWs.workspaceId,
        taskId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        workflowId: execWs.workflowId,
      };
    }
  }

  /**
   * QC ACCEPT → IntegrationGate handoff.
   * Runs IntegrationGate on the workspace after successful execution.
   */
  /**
   * RETIRES THE WORKSPACES OF SUPERSEDED ATTEMPTS (SUPERSEDED_ATTEMPT_WORKSPACE_HELD).
   *
   * A later attempt exists only because QC refused the earlier one (CORRECT / RETRY), so the
   * earlier attempt's work can never integrate. A REQUEST_CHANGES predecessor used to be freed
   * by the pending-review gate's REJECT; a FAILED one (e.g. a worker timeout answered RETRY) has
   * no review, so nothing ever freed it and every allocation of its successor collided. The
   * predecessor is abandoned and released here, under its lease; the branch survives as
   * evidence. A workspace another live owner holds is left to that owner.
   */
  async retireSupersededWorkspaces(taskId: string, workflowId: string): Promise<void> {
    for (const ws of await this.manager.list()) {
      if (ws.taskId !== taskId || ws.releasedAt !== null) continue;
      if (!ws.workflowId || ws.workflowId === workflowId) continue;

      const bound = this.executionWorkspaces.get(taskId);
      const ours = bound?.workspaceId === ws.workspaceId && bound.status !== "released";
      let fencingToken = ours ? bound!.fencingToken : undefined;
      if (!ours) {
        try {
          fencingToken = (await this.manager.acquireLease(ws.workspaceId, this.ownerToken, this.leaseMs))
            .fencingToken;
        } catch (error) {
          if (
            error instanceof WorkspaceError &&
            (error.code === "LEASE_HELD" ||
              error.code === "REGISTRY_LOCKED" ||
              error.code === "WORKSPACE_RELEASED")
          ) {
            continue;
          }
          throw error;
        }
      }

      await this.manager
        .transition(ws.workspaceId, "abandoned", this.ownerToken, fencingToken)
        .catch(() => undefined);
      /*
       * PRESERVE, NEVER DISCARD (SUPERSEDED_DIRTY_WORKSPACE_HELD). A worker killed mid-task
       * leaves uncommitted edits, and cleanup rightly refuses to destroy them — so the
       * workspace was never released and the retry stranded. The edits are committed to the
       * superseded attempt's OWN branch, which cleanup keeps (it is not in the target).
       */
      if ((await this.git.statusPorcelain(ws.worktreePath).catch(() => [])).length > 0) {
        /* Durci : gitdir dérivé du canonique, sans hooks ni pilotes (ADR 0072, phase 0). */
        await this.git.preserveWorktreeChanges(
          ws.worktreePath,
          `icos: preserve uncommitted work of superseded attempt ${ws.workflowId}`,
        );
      }
      try {
        await this.manager.cleanup(ws.workspaceId, this.ownerToken, fencingToken!);
      } finally {
        this.stopLeaseRenewal(ws.workspaceId);
        if (ours) {
          bound!.status = "released";
          bound!.releasedAt = new Date().toISOString();
        }
      }
    }
  }

  /**
   * CANCELLED WORK NEVER INTEGRATES (CANCELLED_WORK_INTEGRATION_DEFECT).
   *
   * An approval judges the work, not whether it is still wanted. When the MissionTask was
   * cancelled or superseded while its work waited, gating it would land a change nobody asked
   * for any more — and a self-development policy denial relies on exactly this refusal. The
   * work is abandoned and released instead; the branch survives as evidence.
   */
  private async refuseWithdrawnWork(execWs: ExecutionWorkspace): Promise<CoordinationResult | null> {
    const missionTask = (await this.missions.listTasks(execWs.missionId)).find(
      (t) => t.taskId === execWs.taskId,
    );
    if (missionTask?.status !== "cancelled" && missionTask?.status !== "superseded") return null;

    await this.manager
      .transition(execWs.workspaceId, "abandoned", this.ownerToken, execWs.fencingToken)
      .catch(() => undefined);
    await this.releaseWorkspace(execWs.taskId).catch(() => undefined);
    return {
      workspaceId: execWs.workspaceId,
      taskId: execWs.taskId,
      success: false,
      decision: "REJECT",
      reasons: [`TASK_${missionTask.status.toUpperCase()}: the work is no longer wanted`],
      workflowId: execWs.workflowId,
    };
  }

  private async handoffToIntegrationGate(
    workspaceId: string,
    workflowId: string,
    humanApprovedBy?: string,
  ): Promise<IntegrationReport> {
    const execWs = Array.from(this.executionWorkspaces.values()).find(
      (w) => w.workspaceId === workspaceId,
    );
    if (!execWs) throw new Error(`OWNERSHIP_LOST: workspace ${workspaceId} is not tracked`);
    await this.assertOwned(execWs);

    /*
     * Move to `ready_for_integration` only if not already there. Since M13 the work may
     * ALREADY be waiting in that state — it was parked there when no review existed — and the
     * lifecycle rightly forbids a self-transition.
     */
    const before = await this.manager.get(workspaceId);
    if (before.status !== "ready_for_integration") {
      await this.manager.transition(
        workspaceId,
        "ready_for_integration",
        this.ownerToken,
        execWs.fencingToken,
      );
    }

    /*
     * INDEPENDENT REVIEW -> the gate (M8, defect 19).
     *
     * The gate's review step answers NEEDS_HUMAN_APPROVAL when no verdict is supplied, so
     * before this an autonomous run could never reach ACCEPT. The verdict comes from the
     * CANONICAL review decision for this workflow — the same record QC produced. Until 0054
     * the only reviewer identity passed was its KIND, which can never equal a worker id, so
     * the gate's self-review refusal could never fire. It now also receives the EFFECTIVE
     * reviewer worker/model and the writer's effective model (see resolveReview), and refuses
     * a same-worker or same-model review.
     *
     * A worker's own claim is never consulted: only a persisted review decision counts.
     */
    const review = await this.resolveReview(workflowId);

    // Run IntegrationGate
    const report = await this.integrationGate.integrate(workspaceId, {
      review,
      humanApprovedBy,
      lease: {
        owner: this.ownerToken,
        fencingToken: execWs.fencingToken!,
      },
    });

    // Update execution workspace with gate result
    if (execWs) {
      execWs.status = report.decision === "ACCEPT" ? "completed" : "failed";
    }

    return report;
  }

  /**
   * THE LATER GOVERNED PASS (M13, defect 28).
   *
   * Gates every workspace that finished execution and has since acquired a canonical review.
   * This is what closes the loop opened by `awaitingReview`: execution and gating are now two
   * governed steps with QC between them, rather than one step that gated whatever review
   * happened to exist.
   *
   * It is idempotent and safe to call on every sweep: a workspace with no review is skipped,
   * one already accepted is left alone, and integration is exactly-once by the applier's own
   * git-derived check.
   */
  async gatePendingReview(humanApprovedBy?: string): Promise<CoordinationResult[]> {
    /*
     * SINGLE-FLIGHT (defect 28 closure). The production sweep may fire while a previous pass is
     * still gating (a gate runs the full verification suite). Overlapping passes in one process
     * share the in-flight pass instead of gating the same workspace twice. Across processes the
     * durable workspace lease below is the exclusion.
     */
    if (this.pendingReviewPass) return this.pendingReviewPass;
    this.pendingReviewPass = this.runPendingReviewPass(humanApprovedBy).finally(() => {
      this.pendingReviewPass = null;
    });
    return this.pendingReviewPass;
  }

  private pendingReviewPass: Promise<CoordinationResult[]> | null = null;
  /** workspaceId → gate inputs of its last NEEDS_* verdict (see runPendingReviewPass). */
  private readonly inconclusiveGates = new Map<string, string>();

  /**
   * DURABLE ADOPTION (defect 28 closure).
   *
   * `executionWorkspaces` only knows what THIS process executed. After a restart — or when the
   * work was executed by another process — the pending workspace exists only in the durable
   * registry, and a pass over the in-memory map would never see it: parked work would wait for
   * ever. So the pass first adopts, from durable state, every workspace that is parked for
   * review AND already has a canonical review.
   *
   * - No review: not adopted, not claimed, not touched. Silence is never consent, and taking
   *   a lease on unreviewed work would only block its real owner.
   * - Adoption takes the durable lease (`acquireLease` bumps the fencing token). `LEASE_HELD`
   *   means a live owner is responsible for it: skip. Two processes cannot both adopt it.
   */
  private async adoptReviewedPendingWorkspaces(): Promise<void> {
    const tracked = new Set(
      Array.from(this.executionWorkspaces.values())
        .filter((w) => w.status !== "released")
        .map((w) => w.workspaceId),
    );

    for (const ws of await this.manager.list()) {
      if (tracked.has(ws.workspaceId)) continue;
      if (ws.releasedAt !== null || !ws.workflowId || !ws.taskId || !ws.missionId) continue;
      if (ws.status !== "ready_for_integration" && ws.status !== "integrating") continue;
      if (!(await this.resolveReview(ws.workflowId))) continue;

      let claimed;
      try {
        claimed = await this.manager.acquireLease(ws.workspaceId, this.ownerToken, this.leaseMs);
      } catch (error) {
        /*
         * LEASE_HELD: a live owner is responsible for it. REGISTRY_LOCKED: another process is
         * mutating the registry right now (the registry uses a TRY-lock). Both mean "not now":
         * skip it, the next sweep retries. Exclusion is the lock and the lease, never a guess.
         */
        if (
          error instanceof WorkspaceError &&
          (error.code === "LEASE_HELD" ||
            error.code === "REGISTRY_LOCKED" ||
            error.code === "WORKSPACE_RELEASED")
        ) {
          continue;
        }
        throw error;
      }

      /* A lease legitimately re-acquired is ours again, whatever an earlier holder lost. */
      this.ownershipLost.delete(ws.workspaceId);
      this.executionWorkspaces.set(ws.taskId, {
        workspaceId: ws.workspaceId,
        taskId: ws.taskId,
        missionId: ws.missionId,
        status: "completed",
        allocatedAt: ws.createdAt,
        workflowId: ws.workflowId,
        fencingToken: claimed.fencingToken,
      });
      this.startLeaseRenewal(ws.workspaceId, this.ownerToken, claimed.fencingToken);
    }
  }

  private async runPendingReviewPass(humanApprovedBy?: string): Promise<CoordinationResult[]> {
    await this.adoptReviewedPendingWorkspaces();
    const results: CoordinationResult[] = [];

    for (const execWs of this.executionWorkspaces.values()) {
      if (!execWs.workflowId || execWs.status === "released") continue;

      const workspace = await this.manager.get(execWs.workspaceId).catch(() => null);
      /* Only work that finished and is waiting: never re-gate an accepted or released one. */
      if (!workspace || workspace.releasedAt !== null) continue;
      if (workspace.status !== "ready_for_integration" && workspace.status !== "integrating") {
        continue;
      }

      /* Still unreviewed: leave it pending rather than gating it again. */
      const review = await this.resolveReview(execWs.workflowId);
      if (!review) continue;

      const withdrawn = await this.refuseWithdrawnWork(execWs);
      if (withdrawn) {
        results.push(withdrawn);
        continue;
      }

      /*
       * NO RE-GATE ON UNCHANGED INPUTS (defect 28 closure). A NEEDS_* verdict is not terminal,
       * but gating again with the same review, the same work and the same target can only
       * repeat it — at the cost of the full verification suite on every sweep. Re-gate only
       * when one of those inputs moved. Process-local on purpose: after a restart the first
       * pass gates once more, which is the safe direction.
       */
      const fingerprint = [
        review.verdict,
        humanApprovedBy ?? "",
        await this.git.resolveCommit(workspace.branch).catch(() => "?"),
        await this.git.resolveCommit(workspace.integrationTarget).catch(() => "?"),
      ].join("|");
      if (this.inconclusiveGates.get(execWs.workspaceId) === fingerprint) continue;

      let gateResult: IntegrationReport;
      try {
        gateResult = await this.handoffToIntegrationGate(
          execWs.workspaceId,
          execWs.workflowId,
          humanApprovedBy,
        );
      } catch (error) {
        /*
         * ONE WORKSPACE, NOT THE PASS. A workspace can leave this process's hands mid-pass — a
         * superseded attempt retired by the supervisor, a lease taken over. Gating it is then
         * correctly refused, but aborting the pass stopped every OTHER parked workspace from
         * being gated on that tick.
         */
        if (error instanceof Error && error.message.startsWith("OWNERSHIP_LOST")) {
          results.push({
            workspaceId: execWs.workspaceId,
            taskId: execWs.taskId,
            success: false,
            error: error.message,
            workflowId: execWs.workflowId,
          });
          continue;
        }
        throw error;
      }

      if (gateResult.decision === "ACCEPT" || gateResult.decision === "REJECT") {
        this.inconclusiveGates.delete(execWs.workspaceId);
      } else {
        this.inconclusiveGates.set(execWs.workspaceId, fingerprint);
      }

      const integration =
        gateResult.decision === "ACCEPT" && this.integrationApplier
          ? await this.integrationApplier.apply(execWs.workspaceId, {
              lease: { owner: this.ownerToken, fencingToken: execWs.fencingToken! },
            })
          : undefined;

      /*
       * REAP after the commit is contained in the target, and only then. Release moved here
       * with the gate: since M13 the execution pass leaves work AWAITING REVIEW, so releasing
       * there would have removed the worktree the gate still has to evaluate — and destroyed
       * the commits with it.
       */
      if (isIntegrated(integration) || gateResult.decision === "REJECT") {
        await this.releaseWorkspace(execWs.taskId).catch(() => undefined);
      }

      results.push({
        workspaceId: execWs.workspaceId,
        taskId: execWs.taskId,
        success: gateResult.decision === "ACCEPT" && (!this.integrationApplier || isIntegrated(integration)),
        decision: gateResult.decision,
        reasons: gateResult.reasons,
        workflowId: execWs.workflowId,
        integration,
      });
    }

    return results;
  }

  /**
   * Maps a canonical review decision onto the gate's verdict vocabulary.
   *
   * Only APPROVE authorises; REQUEST_CHANGES is an explicit refusal. Everything else —
   * BLOCK, ESCALATE_TO_HUMAN, RETRY, REPLAN or no decision at all — yields `undefined`, and
   * the gate then answers NEEDS_HUMAN_APPROVAL. Fail-closed: silence is never consent.
   */
  private async resolveReview(
    workflowId: string,
  ): Promise<NonNullable<Parameters<IntegrationGate["integrate"]>[1]["review"]> | undefined> {
    const decision = await this.reviewDecisions?.getByWorkflowId(workflowId);
    if (!decision) return undefined;

    const reviewer = decision.reviewerKind ?? "reviewer";
    const verdict =
      decision.decision === "APPROVE"
        ? ("APPROVED" as const)
        : decision.decision === "REQUEST_CHANGES"
          ? ("CHANGES_REQUESTED" as const)
          : undefined;
    if (!verdict) return undefined;

    /* EFFECTIVE identities, from durable rows only (decision 0054). */
    const reviewerIdentity = reviewerEffectiveIdentity(decision.providerMetadata);
    const attempt = await this.writerAttempts?.getByWorkflowId(workflowId);
    return {
      verdict,
      reviewer,
      reviewerWorkerId: reviewerIdentity.workerId,
      reviewerModel: reviewerIdentity.model,
      writerModel: writerEffectiveModel(attempt?.routingDecision),
    };
  }

  /**
   * Release workspace after integration (accepted/rejected/abandoned).
   * Cleans up worktree, branch, test database.
   */
  async releaseWorkspace(taskId: string): Promise<void> {
    const execWs = this.executionWorkspaces.get(taskId);
    if (!execWs) {
      return;
    }

    if (execWs.status === "released") {
      return;
    }

    try {
      // Cleanup is fenced and clears the durable lease after resource cleanup.
      await this.manager.cleanup(execWs.workspaceId, this.ownerToken, execWs.fencingToken!);
    } finally {
      this.stopLeaseRenewal(execWs.workspaceId);
      execWs.status = "released";
      execWs.releasedAt = new Date().toISOString();
    }
  }

  /**
   * Restart reconciliation: recover execution state after crash/restart.
   * Scans for workspaces with allocated/executing status and reconciles.
   */
  async reconcile(missionId?: string): Promise<{
    recovered: number;
    released: number;
    errors: string[];
  }> {
    const workspaces = await this.manager.list();
    const activeWorkspaces = workspaces.filter(
      (w) => w.releasedAt === null && (missionId === undefined || w.missionId === missionId),
    );

    let recovered = 0;
    let released = 0;
    const errors: string[] = [];

    for (const ws of activeWorkspaces) {
      try {
        // Check if workspace has a valid lease
        const hasValidLease =
          ws.leaseOwner && ws.leaseExpiresAt && Date.parse(ws.leaseExpiresAt) > Date.now();

        if (!hasValidLease) {
          const claimed = await this.manager.acquireLease(
            ws.workspaceId,
            this.ownerToken,
            this.leaseMs,
          );
          // Lease expired - check if work was committed
          const dirty = await this.git.statusPorcelain(ws.worktreePath);
          if (dirty.length === 0) {
            // Clean worktree - check if branch has commits beyond base
            const changed = await this.git.changedFiles(ws.baseCommit, ws.branch);
            if (changed.length > 0) {
              // Has committed work - transition to ready_for_integration
              await this.manager.transition(
                ws.workspaceId,
                "ready_for_integration",
                this.ownerToken,
                claimed.fencingToken,
              );
              if (ws.taskId && ws.missionId) {
                this.executionWorkspaces.set(ws.taskId, {
                  workspaceId: ws.workspaceId,
                  taskId: ws.taskId,
                  missionId: ws.missionId,
                  status: "completed",
                  allocatedAt: ws.createdAt,
                  workflowId: ws.workflowId ?? undefined,
                  fencingToken: claimed.fencingToken,
                });
              }
              this.startLeaseRenewal(ws.workspaceId, this.ownerToken, claimed.fencingToken);
              recovered++;
            } else {
              // No work - abandon
              await this.manager.transition(
                ws.workspaceId,
                "abandoned",
                this.ownerToken,
                claimed.fencingToken,
              );
              await this.manager.cleanup(ws.workspaceId, this.ownerToken, claimed.fencingToken);
              released++;
              // Update execution workspace status to released
              const execWs =
                ws.taskId !== null ? this.executionWorkspaces.get(ws.taskId) : undefined;
              if (execWs) {
                execWs.status = "released";
                execWs.releasedAt = new Date().toISOString();
              }
            }
          } else {
            // Uncommitted changes - block for human intervention
            await this.manager.transition(
              ws.workspaceId,
              "blocked",
              this.ownerToken,
              claimed.fencingToken,
            );
            errors.push(`${ws.workspaceId}: uncommitted changes, manual intervention required`);
            // Update execution workspace status to failed
            const execWs = ws.taskId !== null ? this.executionWorkspaces.get(ws.taskId) : undefined;
            if (execWs) {
              execWs.status = "failed";
              execWs.executionResult = {
                outcome: "failure",
                error: "Workspace blocked due to uncommitted changes",
              };
            }
          }
        } else {
          if (ws.leaseOwner !== this.ownerToken) {
            throw new Error(`LEASE_HELD: ${ws.workspaceId} is owned by another coordinator`);
          }
          this.startLeaseRenewal(ws.workspaceId, this.ownerToken, ws.fencingToken);
          recovered++;
        }
      } catch (error) {
        errors.push(`${ws.workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { recovered, released, errors };
  }

  /**
   * Start lease renewal for a workspace.
   * Coordinates with AutonomousMissionRunner lease system.
   */
  private startLeaseRenewal(workspaceId: string, owner: string, fencingToken: number): void {
    if (this.leaseTimers.has(workspaceId)) {
      return;
    }

    const renew = async () => {
      try {
        const ws = await this.manager.get(workspaceId);
        if (ws.fencingToken !== fencingToken) {
          // Fencing token changed - we lost ownership
          this.ownershipLost.add(workspaceId);
          this.stopLeaseRenewal(workspaceId);
          return;
        }
        await this.manager.renewLease(workspaceId, owner, fencingToken, this.leaseMs);
      } catch (error) {
        /*
         * REGISTRY_LOCKED is "not now", never "not yours": the registry is a TRY-lock that any
         * concurrent mutation holds briefly. The lease outlives several renewal intervals, so
         * the next renewal retries. Read as a loss, one collision during a long run failed the
         * task with OWNERSHIP_LOST (self-build run 3). A real loss (expired, stale fence,
         * another owner) still ends ownership, here or in `assertOwned`.
         */
        if (error instanceof WorkspaceError && error.code === "REGISTRY_LOCKED") return;
        this.ownershipLost.add(workspaceId);
        this.stopLeaseRenewal(workspaceId);
      }
    };

    // Initial renewal
    const initialRenewal = renew();
    this.leaseRenewals.set(workspaceId, initialRenewal);
    void initialRenewal.finally(() => {
      if (this.leaseRenewals.get(workspaceId) === initialRenewal) {
        this.leaseRenewals.delete(workspaceId);
      }
    });

    // Schedule renewals
    const timer = setInterval(renew, this.leaseRenewalIntervalMs);
    this.leaseTimers.set(workspaceId, timer);
  }

  /**
   * Stop lease renewal for a workspace.
   */
  private stopLeaseRenewal(workspaceId: string): void {
    const timer = this.leaseTimers.get(workspaceId);
    if (timer) {
      clearInterval(timer);
      this.leaseTimers.delete(workspaceId);
    }
  }

  private async assertOwned(execWs: ExecutionWorkspace): Promise<void> {
    const renewal = this.leaseRenewals.get(execWs.workspaceId);
    if (renewal) await renewal;
    const workspace = await this.manager.get(execWs.workspaceId);
    const expiresAt = workspace.leaseExpiresAt ? Date.parse(workspace.leaseExpiresAt) : 0;
    if (
      this.ownershipLost.has(execWs.workspaceId) ||
      workspace.leaseOwner !== this.ownerToken ||
      execWs.fencingToken === undefined ||
      workspace.fencingToken !== execWs.fencingToken ||
      expiresAt <= Date.now()
    ) {
      this.ownershipLost.add(execWs.workspaceId);
      throw new Error(`OWNERSHIP_LOST: workspace ${execWs.workspaceId}`);
    }
  }

  /**
   * Get execution workspace status for a task.
   */
  getExecutionWorkspace(taskId: string): ExecutionWorkspace | undefined {
    return this.executionWorkspaces.get(taskId);
  }

  /**
   * List all execution workspaces for a mission.
   */
  listExecutionWorkspaces(missionId: string): ExecutionWorkspace[] {
    return Array.from(this.executionWorkspaces.values()).filter((w) => w.missionId === missionId);
  }

  /**
   * Shutdown coordinator (cleanup all timers).
   */
  async shutdown(): Promise<void> {
    for (const workspaceId of this.leaseTimers.keys()) {
      this.stopLeaseRenewal(workspaceId);
    }
    this.executionWorkspaces.clear();
  }
}

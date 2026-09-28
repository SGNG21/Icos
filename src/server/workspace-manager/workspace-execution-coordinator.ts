import { randomUUID } from "node:crypto";

import type { Git } from "./git";
import type { WorkspaceManager } from "./manager";
import type { FileScope } from "./types";
import type { IntegrationGate } from "./integration-gate";
import type { IntegrationApplier, IntegrationApplyOutcome } from "./integration-applier";

/** The slice of a canonical review decision the gate needs. */
export interface ReviewLike {
  decision: string;
  reviewerKind?: string;
}
import type { IntegrationReport } from "./report";

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
    const existing = this.executionWorkspaces.get(taskId);
    if (existing && existing.status !== "released") {
      if (workflowId && existing.workflowId && existing.workflowId !== workflowId) {
        throw new Error(
          `WORKFLOW_COLLISION: task ${taskId} is bound to ${existing.workflowId}, not ${workflowId}`,
        );
      }
      // Already allocated - verify workspace still exists and is valid
      const ws = await this.manager.get(existing.workspaceId);
      if (ws.releasedAt === null) {
        return existing;
      }
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

      // QC ACCEPT -> IntegrationGate handoff
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

      return {
        workspaceId: execWs.workspaceId,
        taskId,
        success: gateResult.decision === "ACCEPT",
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

    // Transition to ready_for_integration
    await this.manager.transition(
      workspaceId,
      "ready_for_integration",
      this.ownerToken,
      execWs.fencingToken,
    );

    /*
     * INDEPENDENT REVIEW -> the gate (M8, defect 19).
     *
     * The gate's review step answers NEEDS_HUMAN_APPROVAL when no verdict is supplied, so
     * before this an autonomous run could never reach ACCEPT. The verdict comes from the
     * CANONICAL review decision for this workflow — the same record QC produced — and the
     * reviewer identity is its kind, which can never equal a worker id, so the gate's
     * self-review refusal remains structurally unreachable.
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
   * Maps a canonical review decision onto the gate's verdict vocabulary.
   *
   * Only APPROVE authorises; REQUEST_CHANGES is an explicit refusal. Everything else —
   * BLOCK, ESCALATE_TO_HUMAN, RETRY, REPLAN or no decision at all — yields `undefined`, and
   * the gate then answers NEEDS_HUMAN_APPROVAL. Fail-closed: silence is never consent.
   */
  private async resolveReview(
    workflowId: string,
  ): Promise<{ verdict: "APPROVED" | "CHANGES_REQUESTED"; reviewer: string } | undefined> {
    const decision = await this.reviewDecisions?.getByWorkflowId(workflowId);
    if (!decision) return undefined;

    const reviewer = decision.reviewerKind ?? "reviewer";
    if (decision.decision === "APPROVE") return { verdict: "APPROVED", reviewer };
    if (decision.decision === "REQUEST_CHANGES") return { verdict: "CHANGES_REQUESTED", reviewer };
    return undefined;
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
      } catch {
        // Lease renewal failed - ownership lost
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

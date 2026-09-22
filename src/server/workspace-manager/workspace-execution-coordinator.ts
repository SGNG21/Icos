import { randomUUID } from "node:crypto";
import type { Git } from "./git";
import type { WorkspaceManager } from "./manager";
import type { IntegrationGate } from "./integration-gate";
import type { IntegrationReport } from "./report";
import type { Workspace, WorkspaceStatus } from "./types";
import type { TaskExecutionDispatcher, TaskExecutionDispatchInput } from "@/server/execution/ports";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { DurableMemory } from "@/core/context/durable-memory";

export interface WorkspaceExecutionCoordinatorOptions {
  git: Git;
  manager: WorkspaceManager;
  integrationGate: IntegrationGate;
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
}

export interface ExecutionWorkspace {
  workspaceId: string;
  taskId: string;
  missionId: string;
  status: "allocated" | "executing" | "completed" | "failed" | "released";
  allocatedAt: string;
  releasedAt?: string;
  workflowId?: string;
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

  // In-memory execution workspace tracking (durable state in mission/tasks)
  private executionWorkspaces = new Map<string, ExecutionWorkspace>();

  // Lease renewal timers
  private leaseTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: WorkspaceExecutionCoordinatorOptions) {
    this.git = options.git;
    this.manager = options.manager;
    this.integrationGate = options.integrationGate;
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
    this.leaseRenewalIntervalMs = options.leaseRenewalIntervalMs ?? DEFAULT_LEASE_RENEWAL_INTERVAL_MS;
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
  ): Promise<ExecutionWorkspace> {
    const existing = this.executionWorkspaces.get(taskId);
    if (existing && existing.status !== "released") {
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
      integrationTarget: this.defaultIntegrationTarget,
      fileScope: this.defaultFileScope,
      migrations: 0,
    });

    await this.manager.create(workspace.workspaceId, "workspace-execution-coordinator");

    const execWs: ExecutionWorkspace = {
      workspaceId: workspace.workspaceId,
      taskId,
      missionId,
      status: "allocated",
      allocatedAt: new Date().toISOString(),
    };

    this.executionWorkspaces.set(taskId, execWs);
    this.startLeaseRenewal(workspace.workspaceId, "workspace-execution-coordinator");

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

    // Transition to executing
    execWs.status = "executing";
    await this.manager.transition(execWs.workspaceId, "working", "workspace-execution-coordinator");

    try {
      // Dispatch execution via dispatcher (workspace-aware)
      const workflowId = input.workflowId ?? `icos-${missionId}-${taskId}-${randomUUID().slice(0, 8)}`;
      const dispatchInput: TaskExecutionDispatchInput = {
        ...input,
        workflowId,
      };

      execWs.workflowId = workflowId;

      const result = await this.dispatcher.dispatch(dispatchInput);

      // Verify workflowId matches (idempotency)
      if (result.workflowId !== workflowId) {
        throw new Error(`DISPATCH_WORKFLOW_ID_MISMATCH: expected ${workflowId}, got ${result.workflowId}`);
      }

      // Record execution result in coordination state
      execWs.executionResult = {
        outcome: "success",
        result: `Workflow ${workflowId} dispatched successfully`,
      };

      // Transition workspace to validating (ready for QC/IntegrationGate)
      await this.manager.transition(execWs.workspaceId, "validating", "workspace-execution-coordinator");
      execWs.status = "completed";

      // QC ACCEPT → IntegrationGate handoff
      const gateResult = await this.handoffToIntegrationGate(
        execWs.workspaceId,
        workflowId,
        humanApprovedBy,
      );

      return {
        workspaceId: execWs.workspaceId,
        taskId,
        success: gateResult.decision === "ACCEPT",
        decision: gateResult.decision,
        reasons: gateResult.reasons,
        workflowId,
      };
    } catch (error) {
      execWs.status = "failed";
      execWs.executionResult = {
        outcome: "failure",
        error: error instanceof Error ? error.message : String(error),
      };

      await this.manager.transition(execWs.workspaceId, "blocked", "workspace-execution-coordinator");

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
    const ws = await this.manager.get(workspaceId);

    // Transition to ready_for_integration
    await this.manager.transition(workspaceId, "ready_for_integration", "workspace-execution-coordinator");

    // Run IntegrationGate
    const report = await this.integrationGate.integrate(workspaceId, {
      humanApprovedBy,
    });

    // Update execution workspace with gate result
    const execWs = Array.from(this.executionWorkspaces.values()).find((w) => w.workspaceId === workspaceId);
    if (execWs) {
      execWs.status = report.decision === "ACCEPT" ? "completed" : "failed";
    }

    return report;
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
        // Release lease before cleanup to match test expectations
        await this.manager.releaseLease(execWs.workspaceId, "workspace-execution-coordinator");
        await this.manager.cleanup(execWs.workspaceId);
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
        const hasValidLease = ws.leaseOwner && ws.leaseExpiresAt && Date.parse(ws.leaseExpiresAt) > Date.now();

        if (!hasValidLease) {
          // Lease expired - check if work was committed
          const dirty = await this.git.statusPorcelain(ws.worktreePath);
          if (dirty.length === 0) {
            // Clean worktree - check if branch has commits beyond base
            const changed = await this.git.changedFiles(ws.baseCommit, ws.branch);
            if (changed.length > 0) {
              // Has committed work - transition to ready_for_integration
              await this.manager.transition(ws.workspaceId, "ready_for_integration", "reconciliation");
              recovered++;
            } else {
              // No work - abandon
              await this.manager.transition(ws.workspaceId, "abandoned", "reconciliation");
              await this.manager.cleanup(ws.workspaceId);
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
            await this.manager.transition(ws.workspaceId, "blocked", "reconciliation");
            errors.push(`${ws.workspaceId}: uncommitted changes, manual intervention required`);
            // Update execution workspace status to failed
            const execWs =
              ws.taskId !== null ? this.executionWorkspaces.get(ws.taskId) : undefined;
            if (execWs) {
              execWs.status = "failed";
              execWs.executionResult = {
                outcome: "failure",
                error: "Workspace blocked due to uncommitted changes",
              };
            }
          }
        } else {
          // Valid lease - resume lease renewal
          if (ws.leaseOwner) {
            this.startLeaseRenewal(ws.workspaceId, ws.leaseOwner);
          }
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
  private startLeaseRenewal(workspaceId: string, owner: string): void {
    if (this.leaseTimers.has(workspaceId)) {
      return;
    }

    const renew = async () => {
      try {
        await this.manager.acquireLease(workspaceId, owner, this.leaseMs);
      } catch {
        // Lease acquisition failed - ownership lost
        this.stopLeaseRenewal(workspaceId);
      }
    };

    // Initial acquisition
    renew();

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
    return Array.from(this.executionWorkspaces.values()).filter(
      (w) => w.missionId === missionId,
    );
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
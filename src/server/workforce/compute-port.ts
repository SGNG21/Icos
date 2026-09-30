import type { ComputeRequirement } from "@/core/workers/compute-routing";
import type { WorkerRequirement } from "@/core/workers/worker-eligibility";
import {
  computeRequestFor,
  toWorkerRequirement,
  type WorkforceComputeRequest,
} from "@/core/workforce/compute";
import type {
  AgentKind,
  ExecutionRecord,
  ReviewOutcome,
  WorkAssignment,
} from "@/core/workforce/contracts";
import type { Principal } from "@/core/workforce/governance";

import type { WorkforceStore } from "./ports";
import type { PrincipalAuthority } from "./principals";
import {
  WorkforceDeniedError,
  WorkforceNotFoundError,
  type WorkforceService,
} from "./workforce-service";

/**
 * THE CORE3 ↔ WORKFORCE COMPUTE PORT (decision 0057 §integration). CORE3 is not modified.
 *
 *   CORE3 dispatch  → requestFor(assignment)   : capabilities + difficulty, NEVER a model
 *   CORE3 routing   → (CapabilityRouter, 0031–0054, chooses worker + model)
 *   CORE3 result    → recordExecution(evidence): what ran, what was selected, what happened
 *
 * Only a trusted runtime (system) principal may call it.
 */

export interface Core3ComputeRequest {
  tenantId: string;
  missionId: string;
  taskId: string;
  assignmentId: string;
  agent: {
    agentId: string;
    kind: AgentKind;
    roleId: string;
    roleVersion: string;
    workerId?: string;
  };
  skillId: string;
  requiredCapabilities: string[];
  /** Model-independent requirement; `modelHints` are recorded, never gates. */
  compute: WorkforceComputeRequest;
  /** Ready to pass to the canonical matcher. */
  workerRequirement: Pick<WorkerRequirement, "requiredCapabilities">;
  /** A required approval that is not given means CORE3 must not dispatch. */
  approval: { required: boolean; satisfied: boolean };
}

/**
 * Factual execution evidence from CORE3. `selected` = what the router chose; `effective` =
 * what the runtime REPORTS actually ran. When `modelSteered` is false (0054: the CLI's default
 * model ran) `effective.modelKey` must be absent — the schema refuses a copy of `selected`.
 */
export type ExecutionEvidence = Omit<ExecutionRecord, "requestedCapabilities"> & {
  /** Defaults to the assignment's required capabilities. */
  requestedCapabilities?: string[];
  /** CORE3's independent review of this execution, if it already happened. */
  review?: { reviewerWorkerId: string; outcome: ReviewOutcome; notes?: string };
};

export class WorkforceComputePort {
  constructor(
    private readonly deps: {
      store: WorkforceStore;
      principals: Pick<PrincipalAuthority, "isIssued">;
      service: WorkforceService;
    },
  ) {}

  private requireSystem(principal: Principal): void {
    if (!this.deps.principals.isIssued(principal) || principal.kind !== "system") {
      throw new WorkforceDeniedError(["ACTOR_NOT_AUTHORIZED"]);
    }
  }

  async requestFor(
    system: Principal,
    assignmentId: string,
    options: { taskRisk?: ComputeRequirement["risk"] } = {},
  ): Promise<Core3ComputeRequest> {
    this.requireSystem(system);
    const { store } = this.deps;
    const a = await store.getAssignment(system.tenantId, assignmentId);
    if (!a) throw new WorkforceNotFoundError(`assignment ${assignmentId}`);
    const agent = await store.getAgent(system.tenantId, a.assigneeAgentId);
    const skill = (await store.listSkills(system.tenantId)).find((s) => s.skillId === a.skillId);
    if (!agent || !skill) throw new WorkforceNotFoundError(`assignment ${assignmentId} context`);
    const compute = computeRequestFor({
      skill,
      agentCompute: agent.compute,
      taskRisk: options.taskRisk,
    });
    return {
      tenantId: a.tenantId,
      missionId: a.missionId,
      taskId: a.taskId,
      assignmentId: a.assignmentId,
      agent: {
        agentId: agent.agentId,
        kind: agent.kind,
        roleId: agent.roleId,
        roleVersion: agent.roleVersion,
        ...(agent.workerId ? { workerId: agent.workerId } : {}),
      },
      skillId: a.skillId,
      requiredCapabilities: [...a.requiredCapabilities],
      compute,
      workerRequirement: toWorkerRequirement(compute),
      approval: {
        required: a.approval.required,
        satisfied: !a.approval.required || Boolean(a.approval.approvedBy),
      },
    };
  }

  /** Records the execution, then CORE3's review if one is reported. */
  async recordExecution(
    system: Principal,
    assignmentId: string,
    evidence: ExecutionEvidence,
  ): Promise<WorkAssignment> {
    this.requireSystem(system);
    const { review, ...rest } = evidence;
    const current = await this.deps.store.getAssignment(system.tenantId, assignmentId);
    if (!current) throw new WorkforceNotFoundError(`assignment ${assignmentId}`);
    const executed = await this.deps.service.recordExecution(system, assignmentId, {
      ...rest,
      requestedCapabilities: rest.requestedCapabilities ?? [...current.requiredCapabilities],
    });
    if (!review || rest.result !== "succeeded") return executed;
    return this.deps.service.recordWorkerReview(system, assignmentId, review);
  }
}

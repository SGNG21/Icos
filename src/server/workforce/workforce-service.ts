import type { z } from "zod";

import type { JsonValue } from "@/core/contracts/common";
import type { OrganizationBounds, WorkforceBootstrap } from "@/core/workforce/bootstrap";
import {
  agentPolicySchema,
  memoryScopeSchema,
  agentRoleSchema,
  departmentSchema,
  executionRecordSchema,
  skillDefinitionSchema,
  workAssignmentSchema,
  workforceAgentSchema,
  type ActorRef,
  type AgentKind,
  type AgentPolicy,
  type AgentRole,
  type ComputeNeed,
  type Department,
  type ReviewOutcome,
  type SkillDefinition,
  type WorkAssignment,
  type WorkforceAgent,
  type WorkforceAgentStatus,
  type WorkforceEvent,
  type WorkRequest,
  type WorkScope,
  type Kpi,
} from "@/core/workforce/contracts";
import {
  approveAssignment,
  buildAssignment,
  observationFromReview,
  planDelegation,
  recordExecution,
  recordReview,
  recordWorkerReview,
  startExecution,
  synthesize,
  type DelegationGap,
  type Step,
} from "@/core/workforce/delegation";
import {
  evaluateAgentCreation,
  evaluateAgentStatusChange,
  evaluatePolicyChange,
  isActive,
  isWorkforceAdmin,
  liveToolIds,
  policyWithin,
  type Principal,
  type Verdict,
} from "@/core/workforce/governance";
import { summarizePerformance, type PerformanceFilter } from "@/core/workforce/performance";
import {
  activateRole,
  certifyRole,
  composeRole,
  type CompositionResult,
} from "@/core/workforce/role-composer";

import type { WorkforceStore } from "./ports";
import { UntrustedPrincipalError, type PrincipalAuthority } from "./principals";

/**
 * THE governed entry point of the digital workforce (decision 0057). Every write:
 *   load → pure governance → write + append-only event, in ONE tenant-serialised transaction.
 * A refusal writes nothing but a `governance.denied` event, then throws. Callers (HTTP,
 * cockpit, CORE3) never write the store directly.
 */

export class WorkforceDeniedError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`workforce: refusé (${violations.join(", ")})`);
    this.name = "WorkforceDeniedError";
  }
}
export class WorkforceNotFoundError extends Error {
  constructor(what: string) {
    super(`workforce: ${what} introuvable`);
    this.name = "WorkforceNotFoundError";
  }
}
export class WorkforceConflictError extends Error {
  constructor(what: string) {
    super(`workforce: écriture concurrente sur ${what}`);
    this.name = "WorkforceConflictError";
  }
}

export interface WorkforceServiceDeps {
  store: WorkforceStore;
  /** Only principals issued by this authority are accepted (see principals.ts). */
  principals: Pick<PrincipalAuthority, "isIssued">;
  bounds: OrganizationBounds;
  now: () => string;
  newId: (prefix: string) => string;
}

export interface AgentSpec {
  agentId: string;
  kind: AgentKind;
  roleId: string;
  roleVersion: string;
  displayName: string;
  departmentId?: string | null;
  supervisorAgentId: string | null;
  scope: WorkScope;
  memoryScope: z.input<typeof memoryScopeSchema>;
  policy: AgentPolicy;
  compute?: ComputeNeed;
  objectives?: string[];
  kpis?: Kpi[];
  missionId?: string;
  expiresAt?: string;
  workerId?: string;
}

const actorOf = (p: Principal): ActorRef => ({ kind: p.kind, id: p.id });
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Record<string, JsonValue>;

export class WorkforceService {
  constructor(private readonly deps: WorkforceServiceDeps) {}

  /** No forged principal reaches governance. No event is written: its tenant is untrusted. */
  private trust(principal: Principal): void {
    if (!this.deps.principals.isIssued(principal)) throw new UntrustedPrincipalError("non émis");
  }

  private event(
    tenantId: string,
    type: WorkforceEvent["type"],
    actor: Principal,
    subjectId: string,
    details: unknown,
  ): WorkforceEvent {
    return {
      eventId: this.deps.newId("wfe"),
      tenantId,
      type,
      actor: actorOf(actor),
      subjectId,
      details: json(details),
      occurredAt: this.deps.now(),
    };
  }

  /** Durable denial evidence, written outside the refused transaction, then the throw. */
  // `violations` is optional only because TS widens the `in` narrowing of the tx outcomes.
  private async deny(
    principal: Principal,
    subjectId: string,
    action: string,
    violations: readonly string[] = ["UNKNOWN"],
  ): Promise<never> {
    await this.deps.store.transaction(principal.tenantId, (tx) =>
      tx.appendEvent(
        this.event(principal.tenantId, "governance.denied", principal, subjectId, {
          action,
          violations,
        }),
      ),
    );
    throw new WorkforceDeniedError(violations);
  }

  private async check(
    principal: Principal,
    subjectId: string,
    action: string,
    v: Verdict,
  ): Promise<void> {
    if (!v.allowed) await this.deny(principal, subjectId, action, v.violations);
  }

  private async requireAdmin(
    principal: Principal,
    subjectId: string,
    action: string,
  ): Promise<void> {
    if (!isWorkforceAdmin(principal))
      await this.deny(principal, subjectId, action, ["ACTOR_NOT_AUTHORIZED"]);
  }

  private async unwrap<T>(
    principal: Principal,
    subjectId: string,
    action: string,
    step: Step<T>,
  ): Promise<T> {
    if (!step.ok) return this.deny(principal, subjectId, action, step.errors);
    return step.value;
  }

  /* ---------------------------------------------------------------- registry (human only) */

  /** Loads templates: skills active, roles DRAFT (they still need certification). Idempotent. */
  async seedBootstrap(principal: Principal, bootstrap: WorkforceBootstrap): Promise<void> {
    this.trust(principal);
    await this.requireAdmin(principal, "bootstrap", "seed");
    const tenantId = principal.tenantId;
    await this.deps.store.transaction(tenantId, async (tx) => {
      const skills = new Set(
        (await tx.listSkills(tenantId)).map((s) => `${s.skillId}@${s.version}`),
      );
      const roles = new Set((await tx.listRoles(tenantId)).map((r) => `${r.roleId}@${r.version}`));
      const depts = new Set((await tx.listDepartments(tenantId)).map((d) => d.departmentId));
      for (const s of bootstrap.skills)
        if (!skills.has(`${s.skillId}@${s.version}`)) await tx.insertSkill(tenantId, s);
      for (const r of bootstrap.roles)
        if (!roles.has(`${r.roleId}@${r.version}`)) await tx.insertRole(tenantId, r);
      for (const d of bootstrap.departments)
        if (!depts.has(d.departmentId)) await tx.insertDepartment(tenantId, d);
      await tx.appendEvent(
        this.event(tenantId, "skill.registered", principal, "bootstrap", {
          skills: bootstrap.skills.length,
          roles: bootstrap.roles.length,
          departments: bootstrap.departments.length,
        }),
      );
    });
  }

  async registerSkill(principal: Principal, input: SkillDefinition): Promise<SkillDefinition> {
    this.trust(principal);
    await this.requireAdmin(principal, input.skillId, "skill.register");
    const skill = skillDefinitionSchema.parse(input);
    await this.deps.store.transaction(principal.tenantId, async (tx) => {
      await tx.insertSkill(principal.tenantId, skill);
      await tx.appendEvent(
        this.event(principal.tenantId, "skill.registered", principal, skill.skillId, {
          version: skill.version,
        }),
      );
    });
    return skill;
  }

  async createDepartment(principal: Principal, input: Department): Promise<Department> {
    this.trust(principal);
    await this.requireAdmin(principal, input.departmentId, "department.create");
    const department = departmentSchema.parse(input);
    await this.deps.store.transaction(principal.tenantId, async (tx) => {
      await tx.insertDepartment(principal.tenantId, department);
      await tx.appendEvent(
        this.event(
          principal.tenantId,
          "department.created",
          principal,
          department.departmentId,
          department,
        ),
      );
    });
    return department;
  }

  /* ----------------------------------------------------------------- dynamic role creation */

  /**
   * Any tenant actor (human or agent) may PROPOSE a role: a draft carries no authority. The
   * capabilities come from the decomposer port (NOT_CONNECTED here) or from the caller.
   */
  async proposeRole(
    principal: Principal,
    input: {
      need: string;
      roleId: string;
      name: string;
      capabilities: string[];
      agentKinds: AgentKind[];
    },
  ): Promise<CompositionResult> {
    this.trust(principal);
    const tenantId = principal.tenantId;
    return this.deps.store.transaction(tenantId, async (tx) => {
      const result = composeRole({
        ...input,
        skills: await tx.listSkills(tenantId),
        existingRoles: await tx.listRoles(tenantId),
        createdBy: actorOf(principal),
      });
      if (result.kind === "DRAFT") {
        await tx.insertRole(tenantId, agentRoleSchema.parse(result.role));
        await tx.appendEvent(
          this.event(tenantId, "role.registered", principal, result.role.roleId, {
            need: input.need,
            skills: result.coveredBy,
          }),
        );
      }
      return result;
    });
  }

  async certifyRole(
    principal: Principal,
    roleId: string,
    version: string,
    testsPassed: string[],
  ): Promise<AgentRole> {
    this.trust(principal);
    const tenantId = principal.tenantId;
    const role = await this.deps.store.getRole(tenantId, roleId, version);
    if (!role) throw new WorkforceNotFoundError(`role ${roleId}@${version}`);
    const skills = await this.deps.store.listSkills(tenantId);
    const result = certifyRole({
      role,
      skills,
      certifier: principal,
      testsPassed,
      now: this.deps.now(),
    });
    if (!result.ok) return this.deny(principal, roleId, "role.certify", result.violations);
    await this.deps.store.transaction(tenantId, async (tx) => {
      if (!(await tx.updateRole(tenantId, result.role, "draft")))
        throw new WorkforceConflictError(`role ${roleId}`);
      await tx.appendEvent(
        this.event(tenantId, "role.certified", principal, roleId, { version, testsPassed }),
      );
    });
    return result.role;
  }

  async activateRole(principal: Principal, roleId: string, version: string): Promise<AgentRole> {
    this.trust(principal);
    const tenantId = principal.tenantId;
    const role = await this.deps.store.getRole(tenantId, roleId, version);
    if (!role) throw new WorkforceNotFoundError(`role ${roleId}@${version}`);
    const result = activateRole(role, principal);
    if (!result.ok) return this.deny(principal, roleId, "role.activate", result.violations);
    await this.deps.store.transaction(tenantId, async (tx) => {
      if (!(await tx.updateRole(tenantId, result.role, "certified")))
        throw new WorkforceConflictError(`role ${roleId}`);
      await tx.appendEvent(this.event(tenantId, "role.activated", principal, roleId, { version }));
    });
    return result.role;
  }

  /* -------------------------------------------------------------------- agents / spawning */

  /** Root, durable Mini-ICOS (human) and ephemeral/worker spawn (human or the parent agent). */
  async createAgent(principal: Principal, spec: AgentSpec): Promise<WorkforceAgent> {
    this.trust(principal);
    const tenantId = principal.tenantId;
    const now = this.deps.now();
    const outcome = await this.deps.store.transaction(tenantId, async (tx) => {
      const supervisor = spec.supervisorAgentId
        ? await tx.getAgent(tenantId, spec.supervisorAgentId)
        : null;
      const spawnedByAgent = principal.kind === "agent";
      const candidate = workforceAgentSchema.parse({
        ...spec,
        tenantId,
        departmentId: spec.departmentId ?? supervisor?.departmentId ?? null,
        parentAgentId: spawnedByAgent ? principal.id : (spec.supervisorAgentId ?? null),
        depth: supervisor ? supervisor.depth + 1 : 0,
        objectives: spec.objectives ?? [],
        kpis: spec.kpis ?? [],
        status: "active",
        createdBy: actorOf(principal),
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
      const verdict = evaluateAgentCreation({
        principal,
        candidate,
        supervisor,
        role: await tx.getRole(tenantId, spec.roleId, spec.roleVersion),
        org: await tx.listAgents(tenantId),
        bounds: this.deps.bounds,
        now,
      });
      if (!verdict.allowed) return { denied: verdict.violations } as const;
      await tx.insertAgent(candidate);
      await tx.appendEvent(
        this.event(
          tenantId,
          spawnedByAgent ? "agent.spawned" : "agent.created",
          principal,
          candidate.agentId,
          {
            kind: candidate.kind,
            roleId: candidate.roleId,
            supervisorAgentId: candidate.supervisorAgentId,
            depth: candidate.depth,
            autonomyLevel: candidate.policy.autonomyLevel,
            toolIds: candidate.policy.toolGrants.map((g) => g.toolId),
          },
        ),
      );
      return { agent: candidate } as const;
    });
    if ("denied" in outcome)
      return this.deny(principal, spec.agentId, "agent.create", outcome.denied);
    return outcome.agent;
  }

  async changePolicy(
    principal: Principal,
    agentId: string,
    next: AgentPolicy,
  ): Promise<WorkforceAgent> {
    this.trust(principal);
    const tenantId = principal.tenantId;
    const policy = agentPolicySchema.parse(next);
    const now = this.deps.now();
    const outcome = await this.deps.store.transaction(tenantId, async (tx) => {
      const target = await tx.getAgent(tenantId, agentId);
      if (!target) throw new WorkforceNotFoundError(`agent ${agentId}`);
      const verdict = evaluatePolicyChange({
        principal,
        target,
        next: policy,
        supervisor: target.supervisorAgentId
          ? await tx.getAgent(tenantId, target.supervisorAgentId)
          : null,
        role: await tx.getRole(tenantId, target.roleId, target.roleVersion),
        siblings: await tx.listAgents(tenantId),
        now,
      });
      if (!verdict.allowed) return { denied: verdict.violations } as const;
      const updated = { ...target, policy, updatedAt: now, version: target.version + 1 };
      if (!(await tx.updateAgent(updated, target.version)))
        throw new WorkforceConflictError(`agent ${agentId}`);
      await tx.appendEvent(
        this.event(tenantId, "agent.policy_changed", principal, agentId, {
          before: target.policy,
          after: policy,
        }),
      );
      return { agent: updated } as const;
    });
    if ("denied" in outcome)
      return this.deny(principal, agentId, "agent.policy_change", outcome.denied);
    return outcome.agent;
  }

  async changeStatus(
    principal: Principal,
    agentId: string,
    to: WorkforceAgentStatus,
  ): Promise<WorkforceAgent> {
    this.trust(principal);
    const tenantId = principal.tenantId;
    const now = this.deps.now();
    const outcome = await this.deps.store.transaction(tenantId, async (tx) => {
      const target = await tx.getAgent(tenantId, agentId);
      if (!target) throw new WorkforceNotFoundError(`agent ${agentId}`);
      const verdict = evaluateAgentStatusChange({ principal, target, to });
      if (!verdict.allowed) return { denied: verdict.violations } as const;
      const updated = { ...target, status: to, updatedAt: now, version: target.version + 1 };
      if (!(await tx.updateAgent(updated, target.version)))
        throw new WorkforceConflictError(`agent ${agentId}`);
      await tx.appendEvent(
        this.event(tenantId, "agent.status_changed", principal, agentId, {
          from: target.status,
          to,
        }),
      );
      return { agent: updated } as const;
    });
    if ("denied" in outcome)
      return this.deny(principal, agentId, "agent.status_change", outcome.denied);
    return outcome.agent;
  }

  /* ---------------------------------------------------------------------------- delegation */

  /** The supervisor agent delegates to its direct reports. Gaps are returned, never forced. */
  async delegate(
    principal: Principal,
    input: { requests: WorkRequest[]; parentAssignmentId: string | null },
  ): Promise<{ assignments: WorkAssignment[]; gaps: DelegationGap[] }> {
    this.trust(principal);
    const tenantId = principal.tenantId;
    const now = this.deps.now();
    const outcome = await this.deps.store.transaction(tenantId, async (tx) => {
      const supervisor =
        principal.kind === "agent" ? await tx.getAgent(tenantId, principal.id) : null;
      if (!supervisor) return { denied: ["ACTOR_NOT_AUTHORIZED"] } as const;
      if (input.parentAssignmentId) {
        const parent = await tx.getAssignment(tenantId, input.parentAssignmentId);
        if (
          !parent ||
          parent.assigneeAgentId !== supervisor.agentId ||
          parent.status !== "executing"
        ) {
          return { denied: ["NOT_THE_SUPERVISOR"] } as const;
        }
        if (input.requests.some((r) => r.missionId !== parent.missionId)) {
          return { denied: ["MISSION_LINEAGE_MISMATCH"] } as const;
        }
      }
      const agents = await tx.listAgents(tenantId);
      const plan = planDelegation({
        supervisor,
        requests: input.requests,
        org: {
          agents,
          roles: await tx.listRoles(tenantId),
          skills: await tx.listSkills(tenantId),
          assignments: await tx.listAssignments(tenantId),
        },
        now,
      });
      const assignments: WorkAssignment[] = [];
      for (const p of plan.planned) {
        const assignment = workAssignmentSchema.parse(
          buildAssignment({
            assignmentId: this.deps.newId("wfa"),
            plan: p,
            supervisor,
            assignee: agents.find((a) => a.agentId === p.assigneeAgentId)!,
            parentAssignmentId: input.parentAssignmentId,
            now,
          }),
        );
        await tx.insertAssignment(assignment);
        await tx.appendEvent(
          this.event(tenantId, "assignment.created", principal, assignment.assignmentId, {
            missionId: assignment.missionId,
            taskId: assignment.taskId,
            parentAssignmentId: assignment.parentAssignmentId,
            assigneeAgentId: assignment.assigneeAgentId,
            skillId: assignment.skillId,
            approval: assignment.approval,
            reason: p.reason,
            rejected: p.rejected,
          }),
        );
        assignments.push(assignment);
      }
      for (const gap of plan.gaps) {
        await tx.appendEvent(
          this.event(tenantId, "governance.denied", principal, gap.request.taskId, {
            action: "assignment.plan",
            violations: [gap.reason],
            rejected: gap.rejected,
          }),
        );
      }
      return { assignments, gaps: plan.gaps } as const;
    });
    if ("denied" in outcome)
      return this.deny(principal, "delegation", "assignment.delegate", outcome.denied);
    return outcome;
  }

  /** Load → pure step → CAS write + event. */
  private async advance(
    principal: Principal,
    assignmentId: string,
    action: string,
    type: WorkforceEvent["type"],
    step: (
      a: WorkAssignment,
      tx: WorkforceStore,
    ) => Promise<Step<WorkAssignment> | { denied: string[] }>,
  ): Promise<WorkAssignment> {
    const tenantId = principal.tenantId;
    const outcome = await this.deps.store.transaction(tenantId, async (tx) => {
      const current = await tx.getAssignment(tenantId, assignmentId);
      if (!current) throw new WorkforceNotFoundError(`assignment ${assignmentId}`);
      const result = await step(current, tx);
      if ("denied" in result) return { denied: result.denied } as const;
      if (!result.ok) return { denied: result.errors as string[] } as const;
      const next = workAssignmentSchema.parse(result.value);
      if (!(await tx.updateAssignment(next, current.version)))
        throw new WorkforceConflictError(`assignment ${assignmentId}`);
      await tx.appendEvent(
        this.event(tenantId, type, principal, assignmentId, {
          from: current.status,
          to: next.status,
          ...(next.execution && type === "assignment.executed"
            ? { execution: next.execution }
            : {}),
          ...(next.review && type === "assignment.reviewed" ? { review: next.review } : {}),
          ...(type === "assignment.approved" ? { approval: next.approval } : {}),
        }),
      );
      return { value: next, current } as const;
    });
    if ("denied" in outcome) return this.deny(principal, assignmentId, action, outcome.denied);
    return outcome.value;
  }

  async approve(principal: Principal, assignmentId: string): Promise<WorkAssignment> {
    this.trust(principal);
    return this.advance(
      principal,
      assignmentId,
      "assignment.approve",
      "assignment.approved",
      async (a) => approveAssignment(a, principal, this.deps.now()),
    );
  }

  /** Only the assignee starts its own work. */
  async start(principal: Principal, assignmentId: string): Promise<WorkAssignment> {
    this.trust(principal);
    return this.advance(
      principal,
      assignmentId,
      "assignment.start",
      "assignment.started",
      async (a, tx) => {
        if (principal.kind !== "agent" || principal.id !== a.assigneeAgentId) {
          return { denied: ["ACTOR_NOT_AUTHORIZED"] };
        }
        // A blocked, suspended or expired agent does not start work it was given earlier.
        const now = this.deps.now();
        const assignee = await tx.getAgent(principal.tenantId, a.assigneeAgentId);
        if (!assignee || !isActive(assignee, now)) return { denied: ["AGENT_NOT_ACTIVE"] };
        // Authority is re-checked at start: grants or a supervisor policy narrowed since the
        // assignment stop the work. Per-call tool enforcement belongs to the Tool Gateway.
        const supervisor = await tx.getAgent(principal.tenantId, a.supervisorAgentId);
        const skill = (await tx.listSkills(principal.tenantId)).find(
          (s) => s.skillId === a.skillId,
        );
        const live = liveToolIds(assignee.policy, now);
        const drift: string[] = [
          ...(supervisor
            ? policyWithin(assignee.policy, supervisor.policy, now)
            : ["SUPERVISOR_NOT_ACTIVE"]),
          ...(!skill || !skill.requiredTools.every((t) => live.has(t))
            ? ["MISSING_TOOL_GRANT"]
            : []),
        ];
        if (drift.length > 0) return { denied: [...new Set(drift)] };
        return startExecution(a, now);
      },
    );
  }

  /**
   * Execution facts come from the assignee or from the execution fabric (`system`, lane A).
   * The worker identity and model/provider are recorded as reported; `source` says whether
   * they are REAL.
   */
  async recordExecution(
    principal: Principal,
    assignmentId: string,
    input: z.input<typeof executionRecordSchema>,
  ): Promise<WorkAssignment> {
    this.trust(principal);
    const execution = executionRecordSchema.parse(input);
    return this.advance(
      principal,
      assignmentId,
      "assignment.execute",
      "assignment.executed",
      async (a, tx) => {
        const allowed =
          (principal.kind === "agent" && principal.id === a.assigneeAgentId) ||
          principal.kind === "system";
        if (!allowed) return { denied: ["ACTOR_NOT_AUTHORIZED"] };
        // An execution worker agent stands for ONE registered worker: evidence must name it.
        const assignee = await tx.getAgent(a.tenantId, a.assigneeAgentId);
        if (assignee?.kind === "EXECUTION_WORKER" && assignee.workerId !== execution.workerId) {
          return { denied: ["WORKER_MISMATCH"] };
        }
        const step = recordExecution(a, execution, this.deps.now());
        // A failed execution is a performance fact on its own (no review will follow it).
        if (step.ok && execution.result === "failed") await this.observe(tx, principal, step.value);
        return step;
      },
    );
  }

  /**
   * A review made by a CORE3 reviewer worker, reported by the trusted runtime. The workforce
   * records it (and its observation); it does not re-run CORE3's review.
   */
  async recordWorkerReview(
    principal: Principal,
    assignmentId: string,
    input: { reviewerWorkerId: string; outcome: ReviewOutcome; notes?: string },
  ): Promise<WorkAssignment> {
    this.trust(principal);
    return this.advance(
      principal,
      assignmentId,
      "assignment.review",
      "assignment.reviewed",
      async (a, tx) => {
        if (principal.kind !== "system") return { denied: ["ACTOR_NOT_AUTHORIZED"] };
        const step = recordWorkerReview({ assignment: a, ...input, now: this.deps.now() });
        if (step.ok) await this.observe(tx, principal, step.value);
        return step;
      },
    );
  }

  private async observe(
    tx: WorkforceStore,
    principal: Principal,
    a: WorkAssignment,
  ): Promise<void> {
    const assignee = await tx.getAgent(a.tenantId, a.assigneeAgentId);
    const observation = observationFromReview({
      observationId: this.deps.newId("wfo"),
      assignment: a,
      roleId: assignee?.roleId ?? "UNKNOWN_ROLE",
      taskType: a.skillId,
      now: this.deps.now(),
    });
    await tx.appendObservation(observation);
    await tx.appendEvent(
      this.event(
        a.tenantId,
        "observation.recorded",
        principal,
        observation.observationId,
        observation,
      ),
    );
  }

  /** The reviewer agent reviews; the review produces a performance observation. */
  async review(
    principal: Principal,
    assignmentId: string,
    outcome: ReviewOutcome,
    notes?: string,
  ): Promise<WorkAssignment> {
    this.trust(principal);
    const tenantId = principal.tenantId;
    return this.advance(
      principal,
      assignmentId,
      "assignment.review",
      "assignment.reviewed",
      async (a, tx) => {
        const reviewer =
          principal.kind === "agent" ? await tx.getAgent(tenantId, principal.id) : null;
        if (!reviewer) return { denied: ["ACTOR_NOT_AUTHORIZED"] };
        const role = await tx.getRole(tenantId, reviewer.roleId, reviewer.roleVersion);
        const skills = await tx.listSkills(tenantId);
        const reviewerCapabilities =
          role?.status === "active"
            ? skills
                .filter((s) => role.skills.includes(s.skillId) && s.status === "active")
                .flatMap((s) => s.capabilities)
            : [];
        const step = recordReview({
          assignment: a,
          reviewer,
          reviewerCapabilities,
          outcome,
          notes,
          now: this.deps.now(),
        });
        if (step.ok) await this.observe(tx, principal, step.value);
        return step;
      },
    );
  }

  /** The supervisor synthesises its settled children (BLOCKed children are reported, not re-run). */
  async synthesize(
    principal: Principal,
    input: { missionId: string; parentAssignmentId: string | null; summary: string },
  ): Promise<{ parent: WorkAssignment | null; blockedChildIds: string[] }> {
    this.trust(principal);
    const tenantId = principal.tenantId;
    const now = this.deps.now();
    const outcome = await this.deps.store.transaction(tenantId, async (tx) => {
      const all = await tx.listAssignments(tenantId);
      const parent = input.parentAssignmentId
        ? (all.find((a) => a.assignmentId === input.parentAssignmentId) ?? null)
        : null;
      if (input.parentAssignmentId && !parent)
        throw new WorkforceNotFoundError(`assignment ${input.parentAssignmentId}`);
      const children = all.filter(
        (a) =>
          a.missionId === input.missionId &&
          a.parentAssignmentId === input.parentAssignmentId &&
          a.supervisorAgentId === principal.id &&
          a.status !== "synthesized",
      );
      const step =
        principal.kind === "agent"
          ? synthesize({
              actorAgentId: principal.id,
              parent,
              children,
              summary: input.summary,
              now,
            })
          : ({ ok: false, errors: ["ACTOR_NOT_AUTHORIZED"] } as const);
      if (!step.ok) return { denied: step.errors as string[] } as const;
      const before = new Map(all.map((a) => [a.assignmentId, a]));
      for (const c of step.value.children) {
        const prev = before.get(c.assignmentId)!;
        if (c.version !== prev.version && !(await tx.updateAssignment(c, prev.version))) {
          throw new WorkforceConflictError(`assignment ${c.assignmentId}`);
        }
      }
      if (step.value.parent && !(await tx.updateAssignment(step.value.parent, parent!.version))) {
        throw new WorkforceConflictError(`assignment ${parent!.assignmentId}`);
      }
      await tx.appendEvent(
        this.event(
          tenantId,
          "assignment.synthesized",
          principal,
          input.parentAssignmentId ?? input.missionId,
          {
            missionId: input.missionId,
            summary: input.summary,
            childAssignmentIds: children.map((c) => c.assignmentId).sort(),
            blockedChildIds: step.value.blockedChildIds,
          },
        ),
      );
      return step.value;
    });
    if ("denied" in outcome) {
      return this.deny(
        principal,
        input.parentAssignmentId ?? input.missionId,
        "assignment.synthesize",
        outcome.denied,
      );
    }
    return { parent: outcome.parent, blockedChildIds: outcome.blockedChildIds };
  }

  /* -------------------------------------------------------------------------------- reads */

  /** Humans need `cockpit.read`; agents and the system read their own tenant only. */
  private async requireRead(principal: Principal): Promise<void> {
    if (principal.kind === "human" && !principal.permissions.includes("cockpit.read")) {
      await this.deny(principal, "workforce", "read", ["ACTOR_NOT_AUTHORIZED"]);
    }
  }
  async listAgents(principal: Principal): Promise<WorkforceAgent[]> {
    this.trust(principal);
    await this.requireRead(principal);
    return this.deps.store.listAgents(principal.tenantId);
  }
  async listAssignments(principal: Principal): Promise<WorkAssignment[]> {
    this.trust(principal);
    await this.requireRead(principal);
    return this.deps.store.listAssignments(principal.tenantId);
  }
  async listEvents(principal: Principal): Promise<WorkforceEvent[]> {
    this.trust(principal);
    await this.requireRead(principal);
    return this.deps.store.listEvents(principal.tenantId);
  }
  async performance(principal: Principal, filter: PerformanceFilter = {}) {
    this.trust(principal);
    await this.requireRead(principal);
    return summarizePerformance(await this.deps.store.listObservations(principal.tenantId), filter);
  }
}

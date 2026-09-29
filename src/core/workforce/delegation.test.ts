import { describe, expect, it } from "vitest";

import { workAssignmentSchema, type WorkAssignment } from "./contracts";
import {
  approveAssignment,
  buildAssignment,
  observationFromReview,
  planDelegation,
  recordExecution,
  recordReview,
  startExecution,
  synthesize,
} from "./delegation";
import { summarizePerformance } from "./performance";
import { computeRequestFor, toWorkerRequirement } from "./compute";
import { NOW, agent, child, owner, request, role, skill } from "./test-fixtures";

const root = agent();
const specialist = child(root);
const reviewer = child(root, { agentId: "agent-reviewer", roleId: "INDEPENDENT_REVIEWER" });
const org = {
  agents: [root, specialist, reviewer],
  roles: [role(), role({ roleId: "INDEPENDENT_REVIEWER", skills: ["INDEPENDENT_REVIEW"] })],
  skills: [
    skill(),
    skill({
      skillId: "INDEPENDENT_REVIEW",
      capabilities: ["independent_review"],
      requiredTools: [],
    }),
  ],
  assignments: [] as WorkAssignment[],
};
const execution = {
  workerId: "worker-hermes-1",
  modelKey: "local/some-model",
  provider: "local",
  source: "SIMULATED" as const,
  startedAt: NOW,
  finishedAt: "2026-09-29T10:05:00.000Z",
  evidence: ["artifact://report-1"],
};

const ok = <T>(s: { ok: boolean; value?: T; errors?: string[] }): T => {
  if (!s.ok) throw new Error(`step refused: ${s.errors?.join(",")}`);
  return s.value as T;
};

function assigned(over: Partial<WorkAssignment> = {}): WorkAssignment {
  const { planned } = planDelegation({ supervisor: root, requests: [request()], org, now: NOW });
  return workAssignmentSchema.parse({
    ...buildAssignment({
      assignmentId: "wfa-1",
      plan: planned[0],
      supervisor: root,
      assignee: specialist,
      parentAssignmentId: null,
      now: NOW,
    }),
    ...over,
  });
}

describe("governed delegation", () => {
  it("plans to the eligible direct report and states why; unreachable work is a gap", () => {
    const { planned, gaps } = planDelegation({
      supervisor: root,
      requests: [request(), request({ taskId: "task-2", requiredCapabilities: ["crm_write"] })],
      org,
      now: NOW,
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      assigneeAgentId: specialist.agentId,
      skillId: "APPSEC_REVIEW",
    });
    expect(planned[0].rejected).toEqual([]);
    expect(gaps).toMatchObject([{ request: { taskId: "task-2" }, reason: "NO_ELIGIBLE_REPORT" }]);
    expect(gaps[0].rejected.map((r) => [r.agentId, r.violations])).toEqual([
      [reviewer.agentId, ["SKILL_NOT_IN_ROLE"]],
      [specialist.agentId, ["SKILL_NOT_IN_ROLE"]],
    ]);
  });

  it("prefers the lowest-risk skill covering the capability (fewer approval gates)", () => {
    const risky = skill({ skillId: "AAA_CRITICAL_APPSEC", risk: "CRITICAL" });
    const r = role({ skills: ["AAA_CRITICAL_APPSEC", "APPSEC_REVIEW"] });
    const { planned } = planDelegation({
      supervisor: root,
      requests: [request()],
      org: { ...org, roles: [r, org.roles[1]], skills: [risky, ...org.skills] },
      now: NOW,
    });
    expect(planned[0]).toMatchObject({ skillId: "APPSEC_REVIEW", requiresApproval: false });
  });

  it("records lineage, identity and the permissions held at assignment", () => {
    expect(assigned()).toMatchObject({
      missionId: "mission-1",
      taskId: "task-1",
      parentAssignmentId: null,
      supervisorAgentId: root.agentId,
      assigneeAgentId: specialist.agentId,
      permissionsSnapshot: { autonomyLevel: 2, toolIds: ["repo_read"] },
    });
  });

  it("no anonymous work: an execution without worker identity does not parse", () => {
    const executing = ok<WorkAssignment>(startExecution(assigned(), NOW));
    const next = ok<WorkAssignment>(recordExecution(executing, execution, NOW));
    expect(() =>
      workAssignmentSchema.parse({ ...next, execution: { ...execution, workerId: "" } }),
    ).toThrow();
    expect(next.execution).toMatchObject({
      workerId: "worker-hermes-1",
      modelKey: "local/some-model",
      source: "SIMULATED",
    });
  });

  it("a gated assignment cannot start until a human with approvals.decide approves", () => {
    const gated = assigned({ approval: { required: true, reasons: ["destructive_remediation"] } });
    expect(startExecution(gated, NOW)).toEqual({ ok: false, errors: ["APPROVAL_PENDING"] });
    expect(approveAssignment(gated, owner({ permissions: ["agents.manage"] }), NOW)).toEqual({
      ok: false,
      errors: ["APPROVER_NOT_AUTHORIZED"],
    });
    const approved = ok<WorkAssignment>(approveAssignment(gated, owner(), NOW));
    expect(startExecution(approved, NOW).ok).toBe(true);
  });

  describe("independent review", () => {
    const inReview = () =>
      ok<WorkAssignment>(recordExecution(ok(startExecution(assigned(), NOW)), execution, NOW));
    const review = (
      r = reviewer,
      caps = ["independent_review"],
      outcome: "APPROVE" | "REQUEST_CHANGES" | "BLOCK" = "APPROVE",
    ) =>
      recordReview({
        assignment: inReview(),
        reviewer: r,
        reviewerCapabilities: caps,
        outcome,
        now: NOW,
      });

    it("the assignee cannot review its own work", () => {
      expect(review(specialist).ok).toBe(false);
      expect(
        !review(specialist).ok && (review(specialist) as { errors: string[] }).errors,
      ).toContain("REVIEWER_NOT_INDEPENDENT");
    });
    it("the agent standing for the executing worker cannot review it either", () => {
      const same = child(root, {
        agentId: "agent-w",
        kind: "EXECUTION_WORKER",
        workerId: "worker-hermes-1",
      });
      expect((review(same) as { errors: string[] }).errors).toContain("REVIEWER_NOT_INDEPENDENT");
    });
    it("the reviewer must hold the work's client scope (reviewing is reading)", () => {
      const outsider = child(root, {
        agentId: "agent-outsider",
        scope: { clientIds: ["lds-renov"], projectIds: [] },
      });
      expect((review(outsider) as { errors: string[] }).errors).toEqual(["SCOPE_ESCAPE"]);
    });
    it("the reviewer must hold independent_review", () => {
      expect((review(reviewer, ["appsec"]) as { errors: string[] }).errors).toEqual([
        "REVIEWER_NOT_QUALIFIED",
      ]);
    });
    it("REQUEST_CHANGES counts a correction; BLOCK is terminal", () => {
      const changes = ok<WorkAssignment>(review(reviewer, undefined, "REQUEST_CHANGES"));
      expect(changes).toMatchObject({ status: "changes_requested", correctionCount: 1 });
      const blocked = ok<WorkAssignment>(review(reviewer, undefined, "BLOCK"));
      expect(blocked.status).toBe("blocked");
      expect(startExecution(blocked, NOW)).toEqual({ ok: false, errors: ["INVALID_TRANSITION"] });
    });
  });

  describe("supervisor synthesis", () => {
    const accepted = () =>
      ok<WorkAssignment>(
        recordReview({
          assignment: ok(recordExecution(ok(startExecution(assigned(), NOW)), execution, NOW)),
          reviewer,
          reviewerCapabilities: ["independent_review"],
          outcome: "APPROVE",
          now: NOW,
        }),
      );

    it("only the delegating supervisor, only once children are settled; BLOCKed children are reported", () => {
      const a = accepted();
      const b = { ...assigned({ assignmentId: "wfa-2" }), status: "blocked" as const };
      expect(
        synthesize({
          actorAgentId: specialist.agentId,
          parent: null,
          children: [a],
          summary: "x",
          now: NOW,
        }),
      ).toEqual({ ok: false, errors: ["NOT_THE_SUPERVISOR"] });
      expect(
        synthesize({
          actorAgentId: root.agentId,
          parent: null,
          children: [a, assigned({ assignmentId: "wfa-3" })],
          summary: "x",
          now: NOW,
        }),
      ).toEqual({ ok: false, errors: ["CHILDREN_NOT_SETTLED"] });
      const done = ok<{ children: WorkAssignment[]; blockedChildIds: string[] }>(
        synthesize({
          actorAgentId: root.agentId,
          parent: null,
          children: [a, b],
          summary: "Consolidated",
          now: NOW,
        }),
      );
      expect(done.children.map((c) => c.status)).toEqual(["synthesized", "blocked"]);
      expect(done.blockedChildIds).toEqual(["wfa-2"]);
    });

    it("a review produces an auditable observation; SIMULATED facts are excluded from summaries by default", () => {
      const obs = observationFromReview({
        observationId: "wfo-1",
        assignment: accepted(),
        roleId: "APPSEC_SPECIALIST",
        taskType: "appsec_review",
        now: NOW,
      });
      expect(obs).toMatchObject({
        success: true,
        correctionCount: 0,
        latencyMs: 300_000,
        modelKey: "local/some-model",
        source: "SIMULATED",
      });
      expect(summarizePerformance([obs])).toMatchObject({
        count: 0,
        successRate: null,
        observationIds: [],
      });
      expect(summarizePerformance([obs], { includeNonReal: true })).toMatchObject({
        count: 1,
        successRate: 1,
        firstPassApprovals: 1,
        meanLatencyMs: 300_000,
        totalCostCents: null,
        observationIds: ["wfo-1"],
      });
    });
  });
});

describe("compute seam — capabilities, never a model", () => {
  it("maps skill risk and reasoning to complexity and worker capabilities; hints stay hints", () => {
    const req = computeRequestFor({
      skill: skill({
        risk: "MEDIUM",
        compute: {
          reasoning: "deep",
          workerCapabilities: ["code.review"],
          modelHints: ["prefers-long-context"],
        },
      }),
      taskRisk: "read_only",
    });
    expect(req).toEqual({
      workerCapabilities: ["code.review"],
      complexity: "high",
      risk: "read_only",
      modelHints: ["prefers-long-context"],
    });
    expect(toWorkerRequirement(req)).toEqual({ requiredCapabilities: ["code.review"] });
    expect(Object.keys(toWorkerRequirement(req))).not.toContain("model");
  });
});

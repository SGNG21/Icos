import { describe, expect, it } from "vitest";

import type { AuditEntry } from "@/core/contracts/audit";
import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { Mission, MissionTask } from "@/core/mission/contracts";
import type { GoalRecord } from "@/server/repositories/ports";
import { GATE_REPORT_EVENT } from "@/server/workspace-manager/report";

import {
  autonomyAssessmentFor,
  readAutonomyEvidence,
  type AutonomyEvidenceDeps,
} from "./autonomy-evidence";

const NOW = new Date("2026-10-11T20:00:00Z");
const SYSTEM = { kind: "system" as const, id: "icos" };

let n = 0;
const audit = (
  eventType: AuditEntry["eventType"],
  details: AuditEntry["details"],
  over: Partial<AuditEntry> = {},
): AuditEntry => ({
  id: `audit-${++n}`,
  eventType,
  actor: SYSTEM,
  details,
  occurredAt: `2026-10-11T18:${String(n).padStart(2, "0")}:00.000Z`,
  createdAt: `2026-10-11T18:${String(n).padStart(2, "0")}:00.000Z`,
  ...over,
});

const mission = (id: string, status: Mission["status"]): Mission => ({
  id,
  title: id,
  objective: "o",
  status,
  createdAt: NOW,
  updatedAt: NOW,
});

const goal = (
  goalId: string,
  source: string | undefined,
  resultingMissionId: string | null,
): GoalRecord => ({
  goal: {
    id: goalId,
    title: `goal ${goalId}`,
    objective: "o",
    rawInput: "r",
    normalizedIntent: "n",
    constraints: [],
    successCriteria: [],
    priority: 3,
    riskLevel: "reversible",
    allowedCapabilities: [],
    forbiddenCapabilities: [],
    humanApprovalPolicy: "never",
    metadata: source ? { source } : {},
    createdAt: "2026-10-11T18:00:00.000Z",
  } as unknown as GoalRecord["goal"],
  status: resultingMissionId ? "converted" : "pending",
  resultingMissionId,
  convertedAt: null,
});

function deps(input: {
  audit?: AuditEntry[];
  goals?: GoalRecord[];
  missions?: Mission[];
  tasks?: Record<string, MissionTask[]>;
  reviews?: ReviewDecisionRecord[];
  broken?: ReadonlyArray<keyof AutonomyEvidenceDeps>;
}): AutonomyEvidenceDeps {
  const fail = (k: keyof AutonomyEvidenceDeps) => {
    if (input.broken?.includes(k))
      throw new Error(`${k} down (internal detail that must not leak)`);
  };
  return {
    audit: {
      query: async (f) => {
        fail("audit");
        return (input.audit ?? []).filter((e) => !f.eventType || e.eventType === f.eventType);
      },
    },
    goals: {
      list: async () => {
        fail("goals");
        return input.goals ?? [];
      },
    },
    missions: {
      list: async (f) => {
        fail("missions");
        return (input.missions ?? []).filter((m) => !f?.status || m.status === f.status);
      },
      listTasks: async (id) => input.tasks?.[id] ?? [],
    },
    reviewDecisions: {
      list: async () => {
        fail("reviewDecisions");
        return input.reviews ?? [];
      },
    },
  };
}

const task = (id: string, missionId: string): MissionTask => ({
  id,
  missionId,
  title: id,
  dependsOn: [],
  status: "succeeded",
  taskId: `t-${id}`,
});

describe("readAutonomyEvidence — proofs are rows other authorities already write", () => {
  it("empty runtime: every source read, nothing proven, level L0", async () => {
    const port = autonomyAssessmentFor(deps({}), undefined, () => NOW);
    const a = await port.current();
    expect(a.level).toBe("L0");
    expect(a.dimensions.filter((d) => d.state === "UNKNOWN").map((d) => d.key)).toEqual([
      "deployment",
    ]);
  });

  it("the lab run3 shape: planned + dispatched + failed execution + QC escalation → L1 only", async () => {
    const d = deps({
      audit: [
        audit("goal.created", { goalId: "sd-goal-1" }),
        audit("goal.converted", { goalId: "sd-goal-1", missionId: "sd-mission-1" }),
        audit(
          "task.execution.completed",
          { outcome: "failure", errorCode: "WORKER_FAILED", workflowId: "wf-1" },
          { taskId: "t-a" },
        ),
      ],
      goals: [goal("sd-goal-1", "self-development", "sd-mission-1")],
      missions: [mission("sd-mission-1", "failed")],
      tasks: { "sd-mission-1": [task("a", "sd-mission-1"), task("b", "sd-mission-1")] },
    });
    const a = await autonomyAssessmentFor(d, "lab", () => NOW).current();
    expect(a.level).toBe("L1");
    expect(a.certification).toBe("LAB_CERTIFIED");
    const planning = a.dimensions.find((x) => x.key === "planning")!;
    expect(planning.state).toBe("PROVEN");
    expect(planning.evidence[0]?.summary).toContain("2 task(s) planned by system");
    expect(a.dimensions.find((x) => x.key === "routing")?.state).toBe("UNPROVEN");
    const sd = a.dimensions.find((x) => x.key === "self_development")!;
    expect(sd.state).toBe("UNPROVEN");
    expect(sd.limits[0]).toContain("1 self-development goal(s) proposed");
  });

  it("a human-converted goal is not a planning proof; a mission without tasks neither", async () => {
    const d = deps({
      audit: [
        audit(
          "goal.converted",
          { goalId: "g1", missionId: "m1" },
          { actor: { kind: "human", id: "u" } },
        ),
        audit("goal.converted", { goalId: "g2", missionId: "m2" }),
      ],
      tasks: { m1: [task("a", "m1")] },
    });
    const e = await readAutonomyEvidence(d, undefined);
    expect(e.planned).toEqual({ kind: "read", value: [] });
  });

  it("routing = successful execution; recovery = success after a failure on the SAME task", async () => {
    const d = deps({
      audit: [
        audit(
          "task.execution.completed",
          { outcome: "failure", workflowId: "wf-1" },
          { taskId: "t-a" },
        ),
        audit(
          "task.execution.completed",
          { outcome: "success", workflowId: "wf-2" },
          { taskId: "t-b" },
        ),
        audit(
          "task.execution.completed",
          { outcome: "success", workflowId: "wf-3" },
          { taskId: "t-a" },
        ),
      ],
    });
    const e = await readAutonomyEvidence(d, undefined);
    expect(e.routed.kind === "read" && e.routed.value.map((r) => r.summary)).toEqual([
      "execution success, task t-b (workflow wf-2)",
      "execution success, task t-a (workflow wf-3)",
    ]);
    expect(e.recovered.kind === "read" && e.recovered.value.map((r) => r.summary)).toEqual([
      "task t-a completed after a failed execution",
    ]);
  });

  it("integration = gate report ACCEPT only; review = ICOS reviewer only", async () => {
    const d = deps({
      audit: [
        audit(GATE_REPORT_EVENT, {
          missionId: "m1",
          report: { decision: "REJECT", branch: "b", commitSha: "x" },
        }),
        audit(GATE_REPORT_EVENT, {
          missionId: "m1",
          report: { decision: "ACCEPT", branch: "integration/n1", commitSha: "abcdef0123456" },
        }),
      ],
      reviews: [
        {
          id: "rv-1",
          taskId: "t-a",
          workflowId: "wf-1",
          missionId: "m1",
          decision: "APPROVE",
          reviewerKind: "llm",
          severity: "info",
          reasons: ["ok"],
          providerMetadata: { provider: "gemini", model: "gemini-3.5-flash" },
          createdAt: "2026-10-11T18:30:00.000Z",
        } as unknown as ReviewDecisionRecord,
      ],
    });
    const e = await readAutonomyEvidence(d, undefined);
    expect(e.integrated.kind === "read" && e.integrated.value.map((r) => r.summary)).toEqual([
      "gate ACCEPT integration/n1 @abcdef0123 (mission m1)",
    ]);
    expect(e.reviewed.kind === "read" && e.reviewed.value[0]?.summary).toBe(
      "review APPROVE by llm (gemini-3.5-flash) on mission m1",
    );
  });

  it("self-development is proven only by a SUCCEEDED mission from a self-development goal", async () => {
    const d = deps({
      goals: [
        goal("sd-1", "self-development", "m-done"),
        goal("sd-2", "self-development", "m-failed"),
        goal("h-1", undefined, "m-done"),
      ],
      missions: [mission("m-done", "succeeded"), mission("m-failed", "failed")],
    });
    const e = await readAutonomyEvidence(d, undefined);
    expect(e.selfProposed.kind === "read" && e.selfProposed.value.length).toBe(2);
    expect(e.selfDeveloped.kind === "read" && e.selfDeveloped.value.map((r) => r.ref)).toEqual([
      "m-done",
    ]);
  });

  it("one unreadable source makes ITS dimension UNKNOWN without leaking the error", async () => {
    const d = deps({
      audit: [audit("goal.converted", { goalId: "g", missionId: "m1" })],
      tasks: { m1: [task("a", "m1")] },
      broken: ["reviewDecisions"],
    });
    const a = await autonomyAssessmentFor(d, "live", () => NOW).current();
    const review = a.dimensions.find((x) => x.key === "review")!;
    expect(review.state).toBe("UNKNOWN");
    expect(review.limits[0]).toBe("Review decisions could not be read from ICOS.");
    expect(JSON.stringify(a)).not.toContain("internal detail");
    expect(a.dimensions.find((x) => x.key === "planning")?.certification).toBe("LIVE_CERTIFIED");
    expect(a.level).toBe("L1");
  });
});

import { describe, expect, it } from "vitest";

import {
  missionMemoryInputSchema,
  proceduralObservationSchema,
  containsSecret,
} from "@/core/memory";
import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { TaskExecutionResult } from "@/core/contracts/task-execution";
import {
  executionResultToMissionMemory,
  executionResultToObservations,
  missionObjectiveToMemory,
  missionPlanToMemory,
  reviewDecisionToMissionMemory,
  terminalStateToMemory,
} from "./recorders";

const success: TaskExecutionResult = {
  id: "res-001",
  taskId: "task-001",
  workflowId: "wf-001",
  outcome: "success",
  workerKind: "hermes",
  capability: "website.build",
  result: "Build ok. " + "x".repeat(3000),
  completedAt: "2026-09-19T11:00:00.000Z",
  recordedAt: "2026-09-19T11:00:01.000Z",
  artifacts: [
    {
      type: "preview",
      url: "https://cdn.example.test/p/1?token=SECRETVALUE&sig=abc",
      metadata: { apiKey: "leak" },
    },
  ],
  findings: [
    { severity: "PASS", check: "build", message: "ok" },
    { severity: "WARN", check: "a11y", message: "contrast" },
  ],
};
const failure: TaskExecutionResult = {
  id: "res-002",
  taskId: "task-001",
  workflowId: "wf-002",
  outcome: "failure",
  workerKind: "hermes",
  capability: "website.build",
  error: { code: "WORKER_TIMEOUT", message: "timed out after 600s" },
  completedAt: "2026-09-19T11:10:00.000Z",
  recordedAt: "2026-09-19T11:10:01.000Z",
};
const review: ReviewDecisionRecord = {
  id: "rev-001",
  taskId: "task-001",
  workflowId: "wf-002",
  missionId: "mission-1",
  decision: "RETRY",
  reviewerKind: "deterministic",
  severity: "warning",
  reasons: ["timeout is retryable"],
  createdAt: "2026-09-19T11:11:00.000Z",
  humanOverridden: false,
} as ReviewDecisionRecord;

describe("recorders (pure mappers over existing contracts)", () => {
  it("maps a success to a result + artifact entry with execution_result provenance, valid against the input schema", () => {
    const entries = executionResultToMissionMemory("mission-1", "mt-1", success);
    expect(entries.map((e) => e.kind)).toEqual(["result", "artifact"]);
    for (const e of entries) {
      expect(missionMemoryInputSchema.safeParse(e).success).toBe(true);
      expect(e.provenance).toEqual({ sourceType: "execution_result", sourceId: "res-001" });
      expect(e.missionTaskId).toBe("mt-1");
      expect(e.occurredAt).toBe("2026-09-19T11:00:00.000Z");
    }
    expect(entries[0].summary.length).toBeLessThanOrEqual(500);
    expect(entries[0].payload).toMatchObject({
      outcome: "success",
      workerKind: "hermes",
      capability: "website.build",
      findings: { PASS: 1, WARN: 1, BLOCK: 0 },
    });
  });

  it("never copies artifact metadata or URL query strings (signed URLs / tokens)", () => {
    const [, artifact] = executionResultToMissionMemory("mission-1", undefined, success);
    expect(JSON.stringify(artifact)).not.toContain("SECRETVALUE");
    expect(JSON.stringify(artifact)).not.toContain("leak");
    expect(containsSecret(artifact.payload)).toBe(false);
    expect(artifact.payload).toEqual({
      artifacts: [{ type: "preview", url: "https://cdn.example.test/p/1" }],
    });
  });

  it("maps a failure to an error entry carrying the normalized code", () => {
    const [e, ...rest] = executionResultToMissionMemory("mission-1", undefined, failure);
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      kind: "error",
      summary: "timed out after 600s",
      payload: { code: "WORKER_TIMEOUT" },
    });
    expect(missionMemoryInputSchema.safeParse(e).success).toBe(true);
  });

  it("maps a RETRY review to review + retry entries with review_decision provenance", () => {
    const entries = reviewDecisionToMissionMemory(review);
    expect(entries.map((e) => e.kind)).toEqual(["review", "retry"]);
    for (const e of entries) {
      expect(e.provenance).toEqual({ sourceType: "review_decision", sourceId: "rev-001" });
      expect(missionMemoryInputSchema.safeParse(e).success).toBe(true);
    }
    expect(
      reviewDecisionToMissionMemory({ ...review, decision: "APPROVE" }).map((e) => e.kind),
    ).toEqual(["review"]);
  });

  it("maps objective, plan and terminal state; terminal_state refuses non-terminal statuses", () => {
    const obj = missionObjectiveToMemory({
      id: "mission-1",
      title: "Site",
      objective: "Ship the site",
      createdAt: "2026-09-19T09:00:00.000Z",
    });
    expect(obj).toMatchObject({
      kind: "objective",
      provenance: { sourceType: "mission", sourceId: "mission-1" },
    });
    const plan = missionPlanToMemory("mission-1", "plan-v1", "2026-09-19T09:05:00.000Z", [
      { id: "mt-1", title: "Build", dependsOn: [], capability: "website.build" },
      { id: "mt-2", title: "QA", dependsOn: ["mt-1"] },
    ]);
    expect(plan).toMatchObject({
      kind: "plan",
      provenance: { sourceType: "mission_plan", sourceId: "plan-v1" },
      payload: { taskCount: 2 },
    });
    const term = terminalStateToMemory({
      missionId: "mission-1",
      status: "succeeded",
      at: "2026-09-19T12:00:00.000Z",
      sourceId: "mission-1",
    });
    expect(term).toMatchObject({ kind: "terminal_state", payload: { status: "succeeded" } });
    expect(() =>
      terminalStateToMemory({
        missionId: "mission-1",
        status: "running",
        at: "2026-09-19T12:00:00.000Z",
        sourceId: "x",
      }),
    ).toThrow();
    for (const e of [obj, plan, term])
      expect(missionMemoryInputSchema.safeParse(e).success).toBe(true);
  });

  it("derives procedural observations: strategy + recurring_error on failure; nothing without capability/worker", () => {
    const ok = executionResultToObservations("mission-1", success);
    expect(ok.map((o) => [o.kind, o.signature, o.outcome])).toEqual([
      ["strategy", "website.build|hermes", "success"],
    ]);
    const ko = executionResultToObservations("mission-1", failure);
    expect(ko.map((o) => [o.kind, o.signature, o.outcome])).toEqual([
      ["strategy", "website.build|hermes", "failure"],
      ["recurring_error", "website.build|hermes|WORKER_TIMEOUT", "failure"],
    ]);
    for (const o of [...ok, ...ko]) {
      expect(proceduralObservationSchema.safeParse(o).success).toBe(true);
      expect(o.provenance.sourceType).toBe("execution_result");
      expect(o.scope).toBe("capability");
    }
    expect(
      executionResultToObservations("mission-1", {
        ...success,
        capability: undefined,
        workerKind: undefined,
      }),
    ).toEqual([]);
    expect(
      executionResultToObservations("mission-1", { ...success, capability: undefined })[0].scope,
    ).toBe("worker_kind");
  });
});

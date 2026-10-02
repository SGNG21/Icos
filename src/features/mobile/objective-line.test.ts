import { describe, expect, it } from "vitest";

import { UNKNOWN } from "@/core/supervisor/contracts";
import { missing, real } from "@/features/cockpit/truth";
import type { ObjectiveView } from "@/server/supervisor/objective-read-model";

import type { PendingApprovalFact } from "./home";
import { approvalQueueTruth, toObjectiveLine } from "./load";

const view = (over: Partial<ObjectiveView> = {}): ObjectiveView => ({
  objectiveId: "g1",
  title: "Livrer le portail client",
  missionId: "m1",
  state: "EXECUTING",
  phase: "EXECUTION",
  priority: { score: 1, reasons: [] } as unknown as ObjectiveView["priority"],
  progress: { tasksTotal: 5, tasksSettled: 2 },
  assignedWorkers: ["model"],
  reviewState: "APPROVE",
  blockedReason: null,
  humanDecisionRequired: false,
  cost: UNKNOWN,
  elapsedMs: 1000,
  latestMeaningfulResult: "APPROVE: critères remplis",
  degraded: null,
  ...over,
});

describe("objective line: an uncertain field never becomes a value", () => {
  it("carries the real progress and the real result", () => {
    const line = toObjectiveLine(view());
    expect(line.progress).toMatchObject({ kind: "real", value: "2/5 tâches réglées" });
    expect(line.result).toMatchObject({ kind: "real", value: "APPROVE: critères remplis" });
  });

  it("keeps cost an explicitly stated hole, never 0 and never hidden", () => {
    const line = toObjectiveLine(view());
    expect(line.cost.kind).toBe("not_available");
    expect(line.cost).not.toMatchObject({ kind: "real" });
    if (line.cost.kind === "real") throw new Error("unreachable");
    expect(line.cost.reason).toMatch(/aucun chiffre n'est inventé/);
    expect(line.cost.requirement).toBe("BR-05");
  });

  it("tells an unreadable task list apart from a settled one", () => {
    const unreadable = toObjectiveLine(view({ progress: UNKNOWN }));
    expect(unreadable.progress.kind).toBe("unknown");
    const nothingSettled = toObjectiveLine(view({ progress: { tasksTotal: 5, tasksSettled: 0 } }));
    expect(nothingSettled.progress).toMatchObject({ kind: "real", value: "0/5 tâches réglées" });
  });

  it("says no review was recorded instead of inventing a result", () => {
    const line = toObjectiveLine(view({ latestMeaningfulResult: UNKNOWN }));
    expect(line.result.kind).toBe("not_available");
  });
});

const action = (id: string): PendingApprovalFact => ({
  id,
  kind: "SEND_EMAIL",
  risk: "sensitive",
  taskId: null,
  requestedAt: "2026-10-02T09:00:00.000Z",
  requestedBy: "agent-1",
});

describe("the approval queue never presents its own absence as calm", () => {
  it("is NOT_CONNECTED when the repository answers with nothing", () => {
    const truth = approvalQueueTruth(real([]));
    expect(truth.kind).toBe("not_connected");
    if (truth.kind === "real") throw new Error("unreachable");
    expect(truth.reason).toMatch(/ne peut pas se remplir/);
  });

  it("passes real rows through untouched so an existing action stays decidable", () => {
    expect(approvalQueueTruth(real([action("a")]))).toMatchObject({
      kind: "real",
      value: [{ id: "a" }],
    });
  });

  it("keeps an unreadable repository distinct from an unfillable queue", () => {
    expect(approvalQueueTruth(missing("unknown", "Approvals could not be read.")).kind).toBe(
      "unknown",
    );
  });
});

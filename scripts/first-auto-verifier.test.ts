import { describe, expect, it } from "vitest";

import type { TaskDag, TaskNodeStatus } from "@/core/supervisor";
import { isFirstAutoFinalStateSuccessful } from "./first-auto-verifier";

const NOW = "2026-07-28T00:00:00.000Z";

function makeDag(nodeStatuses: TaskNodeStatus[]): TaskDag {
  return {
    id: "dag-first-auto-verifier",
    missionId: "mission-first-auto-verifier",
    tenantId: "tenant-first-auto-verifier",
    status: "COMPLETED",
    nodes: Object.fromEntries(
      nodeStatuses.map((status, index) => [
        `task-${index}`,
        {
          id: `task-${index}`,
          label: `Task ${index}`,
          description: `Task ${index}`,
          acceptanceCriteria: [],
          status,
          dependsOn: [],
          blockedBy: [],
          workerAssignments: [],
          correctionIds: [],
          correctionCount: 0,
          retryCount: 0,
          maxRetries: 2,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]),
    ),
    nodeOrder: [],
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
  };
}

describe("FIRST-AUTO final verifier", () => {
  it("rejects COMPLETED when a required node remains ASSIGNED", () => {
    expect(
      isFirstAutoFinalStateSuccessful({
        executionStatus: "SUCCEEDED",
        finalDag: makeDag(["ASSIGNED"]),
        allGatesPassed: true,
      }),
    ).toBe(false);
  });

  it("accepts COMPLETED when all required nodes are SUCCEEDED", () => {
    expect(
      isFirstAutoFinalStateSuccessful({
        executionStatus: "SUCCEEDED",
        finalDag: makeDag(["SUCCEEDED", "SUCCEEDED"]),
        allGatesPassed: true,
      }),
    ).toBe(true);
  });

  it("rejects a projected success when global gates failed", () => {
    expect(
      isFirstAutoFinalStateSuccessful({
        executionStatus: "SUCCEEDED",
        finalDag: makeDag(["SUCCEEDED"]),
        allGatesPassed: false,
      }),
    ).toBe(false);
  });
});

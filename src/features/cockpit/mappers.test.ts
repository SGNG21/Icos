import { describe, expect, it } from "vitest";

import type { AgentAction } from "@/core/contracts";
import type { Mission } from "@/core/mission";

import { artifactRefToDisplay, missionToHistoryItem, actionToApprovalCard } from "./mappers";
import type { ArtifactRef } from "./mappers";

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "mission-test-001",
    tenantId: "icos",
    userRequest: "Test mission",
    status: "IN_PROGRESS",
    runs: [],
    createdAt: "2026-07-26T10:00:00.000Z",
    updatedAt: "2026-07-26T10:05:00.000Z",
    ...overrides,
  };
}

function makeAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: "action-test-001",
    initiatedByAgentId: "agent-cto",
    kind: "Déploiement production",
    risk: "sensitive",
    requiresHumanApproval: true,
    approvalStatus: "pending",
    requestedAt: "2026-07-26T10:30:00.000Z",
    ...overrides,
  };
}

describe("missionToHistoryItem", () => {
  it("converts a basic mission", () => {
    const m = makeMission();
    const item = missionToHistoryItem(m);
    expect(item.id).toBe("mission-test-001");
    expect(item.status).toBe("IN_PROGRESS");
    expect(item.userRequest).toBe("Test mission");
    expect(item.createdAt).toBe("2026-07-26T10:00:00.000Z");
    expect(item.updatedAt).toBe("2026-07-26T10:05:00.000Z");
  });

  it("sets completedSteps from runs", () => {
    const m = makeMission({
      runs: [
        {
          id: "run-test-01",
          missionId: "mission-test-001",
          stepIndex: 0,
          startedAt: "2026-07-26T10:00:00.000Z",
          completedAt: "2026-07-26T10:01:00.000Z",
          status: "completed",
        },
        {
          id: "run-test-02",
          missionId: "mission-test-001",
          stepIndex: 1,
          startedAt: "2026-07-26T10:01:00.000Z",
          status: "in_progress",
        },
      ],
    });
    const item = missionToHistoryItem(m);
    expect(item.completedSteps).toBe(1);
  });

  it("sets totalSteps from plan", () => {
    const m = makeMission({
      plan: {
        steps: [
          { id: "step-01", description: "First", status: "completed", dependsOn: [] },
          { id: "step-02", description: "Second", status: "pending", dependsOn: ["step-01"] },
          { id: "step-03", description: "Third", status: "pending", dependsOn: ["step-02"] },
        ],
        totalSteps: 3,
        description: "Test plan",
      },
    });
    const item = missionToHistoryItem(m);
    expect(item.totalSteps).toBe(3);
  });

  it("includes error for failed missions", () => {
    const m = makeMission({
      status: "FAILED",
      error: "Échec lors de l'étape 3",
    });
    const item = missionToHistoryItem(m);
    expect(item.error).toBe("Échec lors de l'étape 3");
  });

  it("includes completedAt when present", () => {
    const m = makeMission({
      status: "COMPLETED",
      completedAt: "2026-07-26T10:05:00.000Z",
    });
    const item = missionToHistoryItem(m);
    expect(item.completedAt).toBe("2026-07-26T10:05:00.000Z");
  });

  it("handles missing optional fields gracefully", () => {
    const m = makeMission({
      plan: undefined,
      runs: undefined as never,
      error: undefined,
      completedAt: undefined,
    });
    const item = missionToHistoryItem(m);
    expect(item.totalSteps).toBeUndefined();
    expect(item.completedSteps).toBeUndefined();
    expect(item.error).toBeUndefined();
    expect(item.completedAt).toBeUndefined();
  });
});

describe("artifactRefToDisplay", () => {
  it("converts an artifact ref to display model", () => {
    const ref: ArtifactRef = {
      id: "artf-01",
      type: "document",
      name: "Rapport d'analyse",
      sizeBytes: 24576,
      description: "Rapport complet",
    };
    const display = artifactRefToDisplay(ref);
    expect(display.id).toBe("artf-01");
    expect(display.type).toBe("document");
    expect(display.displayName).toBe("Rapport d'analyse");
    expect(display.originalName).toBe("Rapport d'analyse");
    expect(display.sizeBytes).toBe(24576);
    expect(display.description).toBe("Rapport complet");
  });

  it("maps unknown types to document", () => {
    const ref: ArtifactRef = {
      id: "artf-02",
      type: "spreadsheet",
      name: "data.xlsx",
    };
    const display = artifactRefToDisplay(ref);
    expect(display.type).toBe("document");
  });

  it("handles minimal ref without optional fields", () => {
    const ref: ArtifactRef = {
      id: "artf-03",
      type: "code",
      name: "patch.diff",
    };
    const display = artifactRefToDisplay(ref);
    expect(display.type).toBe("code");
    expect(display.sizeBytes).toBeUndefined();
    expect(display.description).toBeUndefined();
  });
});

describe("actionToApprovalCard", () => {
  it("converts an action to an approval ChatMessage", () => {
    const action = makeAction();
    const msg = actionToApprovalCard(action);
    expect(msg.role).toBe("approval");
    expect(msg.id).toBe("approval-action-test-001");
    expect(msg.payload).toBe(action);
    expect(msg.timestamp).toBe("2026-07-26T10:30:00.000Z");
    expect(msg.content).toBeUndefined();
  });

  it("includes taskId in payload when present", () => {
    const action = makeAction({ taskId: "task-001" });
    const msg = actionToApprovalCard(action);
    expect((msg.payload as AgentAction).taskId).toBe("task-001");
  });
});

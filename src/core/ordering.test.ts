import { describe, expect, it } from "vitest";

import type { Agent, AgentAction, Approval, AuditEntry, Task } from "./contracts";
import {
  compareActions,
  compareAgents,
  compareApprovals,
  compareAuditEntries,
  compareTasks,
} from "./ordering";

function agent(id: string, level: 0 | 1 | 2 | 3): Agent {
  return {
    id,
    name: id,
    role: "r",
    status: "available",
    authorizationLevel: level,
    description: "d",
  };
}

describe("comparateurs d'ordre", () => {
  it("agents : authorizationLevel DESC, id ASC", () => {
    const sorted = [agent("agent-b", 1), agent("agent-a", 3), agent("agent-c", 3)].sort(
      compareAgents,
    );
    expect(sorted.map((a) => a.id)).toEqual(["agent-a", "agent-c", "agent-b"]);
  });

  it("tasks : createdAt ASC, id ASC (par instant)", () => {
    const base = {
      title: "t",
      status: "draft" as const,
      actionIds: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const t = (id: string, createdAt: string): Task => ({ ...base, id, createdAt });
    const sorted = [
      t("task-b", "2026-07-21T10:00:00.000Z"),
      t("task-a", "2026-07-21T09:00:00.000Z"),
      t("task-c", "2026-07-21T10:00:00.000Z"),
    ].sort(compareTasks);
    expect(sorted.map((x) => x.id)).toEqual(["task-a", "task-b", "task-c"]);
  });

  it("actions : requestedAt ASC, id ASC", () => {
    const a = (id: string, requestedAt: string): AgentAction => ({
      id,
      initiatedByAgentId: "agent-x",
      kind: "k",
      risk: "sensitive",
      requiresHumanApproval: true,
      approvalStatus: "pending",
      requestedAt,
    });
    const sorted = [
      a("action-b", "2026-07-21T10:00:00.000Z"),
      a("action-a", "2026-07-21T10:00:00.000Z"),
    ].sort(compareActions);
    expect(sorted.map((x) => x.id)).toEqual(["action-a", "action-b"]);
  });

  it("approvals : decidedAt ASC, id ASC", () => {
    const ap = (id: string, decidedAt: string): Approval => ({
      id,
      actionId: "action-x",
      decidedBy: "op",
      decision: "approved",
      decidedAt,
    });
    const sorted = [
      ap("ap-b", "2026-07-21T11:00:00.000Z"),
      ap("ap-a", "2026-07-21T10:00:00.000Z"),
    ].sort(compareApprovals);
    expect(sorted.map((x) => x.id)).toEqual(["ap-a", "ap-b"]);
  });

  it("audit : occurredAt ASC, id ASC (chronologique)", () => {
    const e = (id: string, occurredAt: string): AuditEntry => ({
      id,
      occurredAt,
      eventType: "task.created",
      actor: { kind: "system", id: "icos" },
      details: {},
    });
    const sorted = [
      e("audit-b", "2026-07-21T10:00:00.000Z"),
      e("audit-a", "2026-07-21T09:00:00.000Z"),
    ].sort(compareAuditEntries);
    expect(sorted.map((x) => x.id)).toEqual(["audit-a", "audit-b"]);
  });
});

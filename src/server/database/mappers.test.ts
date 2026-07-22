import { describe, expect, it } from "vitest";

import type { Agent } from "@/core/contracts";

import { RepositoryMappingError } from "./errors";
import { agentToRow, rowToAction, rowToAgent } from "./mappers";
import type { actions, agents } from "./schema";

type AgentRow = typeof agents.$inferSelect;
type ActionRow = typeof actions.$inferSelect;

describe("mappers", () => {
  it("round-trip agent (contrat → ligne → contrat)", () => {
    const agent: Agent = {
      id: "agent-cto",
      name: "CTO",
      role: "Direction technique",
      status: "available",
      authorizationLevel: 2,
      description: "desc",
    };
    const row = agentToRow(agent) as AgentRow;
    expect(rowToAgent(row)).toEqual(agent);
  });

  it("rowToAction : la colonne created_at porte requestedAt", () => {
    const row: ActionRow = {
      id: "action-001",
      initiatedByAgentId: "agent-cto",
      taskId: null,
      kind: "repository.read",
      risk: "read_only",
      requiresHumanApproval: false,
      approvalStatus: "not_required",
      createdAt: new Date("2026-07-21T08:00:00.000Z"),
      updatedAt: new Date("2026-07-21T09:00:00.000Z"),
    };
    expect(rowToAction(row).requestedAt).toBe("2026-07-21T08:00:00.000Z");
  });

  it("lève RepositoryMappingError sur une ligne invalide", () => {
    const badRow = {
      id: "agent-cto",
      name: "CTO",
      role: "r",
      status: "weird",
      authorizationLevel: 9,
      description: "d",
    } as AgentRow;
    expect(() => rowToAgent(badRow)).toThrow(RepositoryMappingError);
  });
});

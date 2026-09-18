import { describe, expect, it } from "vitest";

import type { Agent, AuditEntry, TaskExecutionResult } from "@/core/contracts";

import { RepositoryMappingError } from "./errors";
import {
  agentToRow,
  auditToRow,
  rowToAction,
  rowToAgent,
  rowToAuditEntry,
  rowToTaskExecutionResult,
  taskExecutionResultToRow,
} from "./mappers";
import type { actions, agents, auditEntries, taskExecutionResults } from "./schema";

type AgentRow = typeof agents.$inferSelect;
type ActionRow = typeof actions.$inferSelect;
type AuditRow = typeof auditEntries.$inferSelect;
type TaskExecutionResultRow = typeof taskExecutionResults.$inferSelect;

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

  it("préserve occurredAt et createdAt distincts pendant le round-trip audit", () => {
    const entry: AuditEntry = {
      id: "audit-mapper-round-trip",
      occurredAt: "2026-09-16T10:00:00.000Z",
      eventType: "task.execution.completed",
      actor: { kind: "system", id: "icos" },
      taskId: "task-mapper-round-trip",
      details: { workflowId: "workflow-mapper-round-trip" },
      createdAt: "2026-09-16T10:05:00.000Z",
    };

    const row = auditToRow(entry) as AuditRow;

    expect(rowToAuditEntry(row)).toEqual(entry);
    expect(row.occurredAt).toEqual(new Date(entry.occurredAt));
    expect(row.createdAt).toEqual(new Date(entry.createdAt));
  });

  it("préserve toute la preuve TaskExecutionResult pendant le round-trip", () => {
    const result: TaskExecutionResult = {
      id: "texec-mapper-round-trip",
      taskId: "task-mapper-round-trip",
      workflowId: "workflow-mapper-round-trip",
      outcome: "success",
      workerKind: "digitalos",
      capability: "website.build",
      digitalosExecutionId: "digitalos-execution-001",
      result: "build complete",
      startedAt: "2026-09-16T10:00:00.000Z",
      completedAt: "2026-09-16T10:05:00.000Z",
      recordedAt: "2026-09-16T10:05:01.000Z",
      artifacts: [{ type: "preview", url: "https://example.test/preview" }],
      evidence: [
        {
          type: "report",
          source: "gate",
          timestamp: "2026-09-16T10:04:00.000Z",
          metadata: { passed: true },
        },
      ],
      findings: [{ severity: "PASS", check: "build", message: "ok" }],
      observations: [{ durationMs: 300_000 }],
      confidence: 0.95,
    };

    const row = taskExecutionResultToRow(result) as TaskExecutionResultRow;

    expect(rowToTaskExecutionResult(row)).toEqual(result);
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

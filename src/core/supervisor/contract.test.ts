import { describe, expect, it } from "vitest";

import { taskNodeSchema, taskDagSchema, dagStatusSchema, taskNodeStatusSchema } from "./contract";

// ─────────────────────────────────────
// Contract validation
// ─────────────────────────────────────

describe("taskNodeStatusSchema", () => {
  it("accepts all defined statuses", () => {
    const valid = [
      "PENDING",
      "READY",
      "ASSIGNED",
      "RUNNING",
      "REVIEWING",
      "CHANGES_REQUIRED",
      "FAILED_REVIEW",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
      "BLOCKED",
      "WAITING_FOR_HUMAN",
    ];
    for (const s of valid) {
      expect(() => taskNodeStatusSchema.parse(s)).not.toThrow();
    }
  });

  it("rejects unknown status", () => {
    expect(() => taskNodeStatusSchema.parse("UNKNOWN_STATUS")).toThrow();
  });
});

describe("dagStatusSchema", () => {
  it("accepts all defined statuses", () => {
    const valid = ["CREATED", "SCHEDULING", "EXECUTING", "COMPLETED", "FAILED", "CANCELLED"];
    for (const s of valid) {
      expect(() => dagStatusSchema.parse(s)).not.toThrow();
    }
  });

  it("rejects unknown status", () => {
    expect(() => dagStatusSchema.parse("INVALID")).toThrow();
  });
});

describe("taskNodeSchema", () => {
  it("creates a valid node", () => {
    const node = taskNodeSchema.parse({
      id: "task-001",
      label: "Implement port",
      description: "Create the WorkerManager port interface",
      acceptanceCriteria: ["Port interface compiles", "Tests pass"],
      dependsOn: [],
      createdAt: "2026-07-26T10:00:00Z",
      updatedAt: "2026-07-26T10:00:00Z",
    });

    expect(node.id).toBe("task-001");
    expect(node.status).toBe("PENDING");
    expect(node.retryCount).toBe(0);
    expect(node.maxRetries).toBe(2);
    expect(node.workerAssignments).toEqual([]);
    expect(node.correctionIds).toEqual([]);
  });

  it("accepts a node with dependencies", () => {
    const node = taskNodeSchema.parse({
      id: "task-003",
      label: "Integration",
      description: "Integrate all components",
      dependsOn: ["task-001", "task-002"],
      createdAt: "2026-07-26T10:00:00Z",
      updatedAt: "2026-07-26T10:00:00Z",
    });

    expect(node.dependsOn).toEqual(["task-001", "task-002"]);
  });

  it("accepts a node with custom retry config", () => {
    const node = taskNodeSchema.parse({
      id: "task-004",
      label: "Flaky task",
      description: "This task might need retries",
      maxRetries: 5,
      retryCount: 1,
      createdAt: "2026-07-26T10:00:00Z",
      updatedAt: "2026-07-26T10:00:00Z",
    });

    expect(node.maxRetries).toBe(5);
    expect(node.retryCount).toBe(1);
  });

  it("rejects a node with empty id", () => {
    expect(() =>
      taskNodeSchema.parse({
        id: "ab",
        label: "Bad",
        description: "Too short id",
        createdAt: "2026-07-26T10:00:00Z",
        updatedAt: "2026-07-26T10:00:00Z",
      }),
    ).toThrow();
  });
});

describe("taskDagSchema", () => {
  it("creates a valid DAG", () => {
    const dag = taskDagSchema.parse({
      id: "dag-001",
      missionId: "mission-001",
      tenantId: "tenant-001",
      nodes: {},
      createdAt: "2026-07-26T10:00:00Z",
      updatedAt: "2026-07-26T10:00:00Z",
    });

    expect(dag.id).toBe("dag-001");
    expect(dag.status).toBe("CREATED");
  });

  it("accepts a DAG with nodes", () => {
    const now = "2026-07-26T10:00:00Z";
    const dag = taskDagSchema.parse({
      id: "dag-002",
      missionId: "mission-001",
      tenantId: "tenant-001",
      nodes: {
        "task-001": {
          id: "task-001",
          label: "Root task",
          description: "First task",
          dependsOn: [],
          createdAt: now,
          updatedAt: now,
        },
      },
      createdAt: now,
      updatedAt: now,
    });

    expect(Object.keys(dag.nodes)).toHaveLength(1);
    expect(dag.nodes["task-001"].label).toBe("Root task");
  });
});

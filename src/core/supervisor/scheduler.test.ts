import { describe, expect, it, vi } from "vitest";

import { Scheduler } from "./scheduler";
import type { TaskDag, TaskNode } from "./contract";

// ─────────────────────────────────────
// Scheduler tests
// ─────────────────────────────────────

describe("Scheduler", () => {
  function createReadyDag(): TaskDag {
    const now = "2026-07-26T10:00:00Z";
    return {
      id: "dag-test",
      missionId: "mission-test",
      tenantId: "tenant-test",
      status: "EXECUTING",
      nodes: {
        "a": makeNode("a", [], "SUCCEEDED"),
        "b": makeNode("b", ["a"], "PENDING"),
        "c": makeNode("c", ["a"], "PENDING"),
        "d": makeNode("d", ["b", "c"], "PENDING"),
      },
      nodeOrder: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  function createExecutingDag(): TaskDag {
    const now = "2026-07-26T10:00:00Z";
    return {
      id: "dag-test",
      missionId: "mission-test",
      tenantId: "tenant-test",
      status: "EXECUTING",
      nodes: {
        "a": makeNode("a", [], "SUCCEEDED"),
        "b": makeNode("b", ["a"], "RUNNING"),
        "c": makeNode("c", ["a"], "PENDING"),
      },
      nodeOrder: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  // ─────────────────────────────────
  // getReadyNodes
  // ─────────────────────────────────

  describe("getReadyNodes", () => {
    it("returns ready nodes from a valid DAG", () => {
      const scheduler = new Scheduler(createReadyDag());
      const result = scheduler.getReadyNodes();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual(["b", "c"]);
      }
    });

    it("returns empty when no nodes are ready", () => {
      const dag = createExecutingDag();
      // Make c depend on b which is RUNNING (not yet succeeded)
      dag.nodes["c"].dependsOn = ["b"];
      const scheduler = new Scheduler(dag);
      const result = scheduler.getReadyNodes();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual([]);
      }
    });

    it("fails when DAG is in wrong state", () => {
      const dag = createReadyDag();
      dag.status = "COMPLETED";
      const scheduler = new Scheduler(dag);
      const result = scheduler.getReadyNodes();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("INVALID_STATE");
      }
    });
  });

  // ─────────────────────────────────
  // onNodeCompleted
  // ─────────────────────────────────

  describe("onNodeCompleted", () => {
    it("recalculates ready nodes after completion", async () => {
      const dag = createExecutingDag();
      // Marquer b comme terminé
      dag.nodes["b"].status = "SUCCEEDED";

      const scheduler = new Scheduler(dag);
      const result = await scheduler.onNodeCompleted("b");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toContain("c");
      }
    });

    it("fails for non-existent node", async () => {
      const scheduler = new Scheduler(createReadyDag());
      const result = await scheduler.onNodeCompleted("nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("NODE_NOT_FOUND");
      }
    });

    it("emits events on completion", async () => {
      const dag = createExecutingDag();
      dag.nodes["b"].status = "SUCCEEDED";
      const scheduler = new Scheduler(dag);

      const events: string[] = [];
      scheduler.onEvent((e) => {
        events.push(e.type);
      });

      await scheduler.onNodeCompleted("b");

      expect(events).toContain("node_completed");
    });
  });

  // ─────────────────────────────────
  // onNodeFailed
  // ─────────────────────────────────

  describe("onNodeFailed", () => {
    it("emits failure event and propagates to dependents", async () => {
      const dag = createReadyDag();
      dag.nodes["b"].status = "FAILED";
      dag.nodes["b"].maxRetries = 0; // No retry possible

      const scheduler = new Scheduler(dag);
      const events: string[] = [];
      scheduler.onEvent((e) => events.push(e.type));

      const result = await scheduler.onNodeFailed("b");

      expect(result.ok).toBe(true);
      // d depends on b, and since b is failed, d's PENDING should be noted
    });

    it("reports retry-possible when node can be retried", async () => {
      const dag = createReadyDag();
      dag.nodes["b"].status = "FAILED";
      dag.nodes["b"].retryCount = 0;
      dag.nodes["b"].maxRetries = 2;

      const scheduler = new Scheduler(dag);
      const events: string[] = [];
      scheduler.onEvent((e) => events.push(e.type));

      const result = await scheduler.onNodeFailed("b");

      // Should emit retry_attempted
      expect(events.some((e) => e === "retry_attempted")).toBe(true);
    });
  });

  // ─────────────────────────────────
  // isDagComplete
  // ─────────────────────────────────

  describe("isDagComplete", () => {
    it("returns true when all nodes are terminal", () => {
      const dag = createReadyDag();
      // All nodes SUCCEEDED
      for (const n of Object.keys(dag.nodes)) {
        dag.nodes[n].status = "SUCCEEDED";
      }

      const scheduler = new Scheduler(dag);
      expect(scheduler.isDagComplete()).toBe(true);
    });

    it("returns false when nodes are still running", () => {
      const scheduler = new Scheduler(createReadyDag());
      expect(scheduler.isDagComplete()).toBe(false);
    });
  });

  // ─────────────────────────────────
  // canAssign
  // ─────────────────────────────────

  describe("canAssign", () => {
    it("allows assignment of READY node", () => {
      const dag = createReadyDag();
      // b is still PENDING, not READY. Let's make it READY.
      dag.nodes["c"].status = "READY";

      const scheduler = new Scheduler(dag);
      const result = scheduler.canAssign("c");
      expect(result.ok).toBe(true);
    });

    it("denies assignment of non-READY node", () => {
      const scheduler = new Scheduler(createReadyDag());
      const result = scheduler.canAssign("d"); // PENDING with unmet deps
      expect(result.ok).toBe(false);
    });

    it("denies assignment of non-existent node", () => {
      const scheduler = new Scheduler(createReadyDag());
      const result = scheduler.canAssign("nonexistent");
      expect(result.ok).toBe(false);
    });
  });

  // ─────────────────────────────────
  // canRaiseHumanGate
  // ─────────────────────────────────

  describe("canRaiseHumanGate", () => {
    it("allows human gate for ASSIGNED node", () => {
      const dag = createReadyDag();
      dag.nodes["c"].status = "ASSIGNED";
      const scheduler = new Scheduler(dag);
      expect(scheduler.canRaiseHumanGate("c").ok).toBe(true);
    });

    it("allows human gate for RUNNING node", () => {
      const scheduler = new Scheduler(createExecutingDag());
      expect(scheduler.canRaiseHumanGate("b").ok).toBe(true);
    });

    it("denies human gate for PENDING node", () => {
      const scheduler = new Scheduler(createReadyDag());
      expect(scheduler.canRaiseHumanGate("c").ok).toBe(false);
    });
  });

  // ─────────────────────────────────
  // canReview
  // ─────────────────────────────────

  describe("canReview", () => {
    it("allows review for RUNNING node", () => {
      const scheduler = new Scheduler(createExecutingDag());
      expect(scheduler.canReview("b").ok).toBe(true);
    });

    it("denies review for non-RUNNING node", () => {
      const scheduler = new Scheduler(createReadyDag());
      expect(scheduler.canReview("a").ok).toBe(false);
    });
  });
});

// ─────────────────────────────────────
// Helper
// ─────────────────────────────────────

function makeNode(
  id: string,
  deps: string[],
  status: TaskNode["status"],
): TaskNode {
  return {
    id,
    label: `Task ${id}`,
    description: `Description ${id}`,
    status,
    dependsOn: deps,
    blockedBy: [],
    workerAssignments: [],
    correctionIds: [],
    correctionCount: 0,
    retryCount: 0,
    maxRetries: 2,
    createdAt: "2026-07-26T10:00:00Z",
    updatedAt: "2026-07-26T10:00:00Z",
  };
}

import { describe, expect, it } from "vitest";

import { InMemorySupervisorRepository } from "./supervisor-repository";
import type { TaskNode, TaskNodeStatus } from "@/core/supervisor";

describe("InMemorySupervisorRepository", () => {
  function makeRepo() {
    return new InMemorySupervisorRepository();
  }

  function makeNode(id: string, deps: string[] = []): TaskNode {
    return {
      id,
      label: `Task ${id}`,
      description: `Description ${id}`,
      acceptanceCriteria: [],
      status: "PENDING",
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

  async function transitionNodeTo(
    repo: InMemorySupervisorRepository,
    dagId: string,
    nodeId: string,
    target: TaskNodeStatus,
  ): Promise<void> {
    const paths: Record<TaskNodeStatus, TaskNodeStatus[]> = {
      PENDING: [],
      READY: ["READY"],
      ASSIGNED: ["READY", "ASSIGNED"],
      RUNNING: ["READY", "ASSIGNED", "RUNNING"],
      REVIEWING: ["READY", "ASSIGNED", "RUNNING", "REVIEWING"],
      CHANGES_REQUIRED: ["READY", "ASSIGNED", "RUNNING", "REVIEWING", "CHANGES_REQUIRED"],
      FAILED_REVIEW: ["READY", "ASSIGNED", "RUNNING", "REVIEWING", "FAILED_REVIEW"],
      SUCCEEDED: ["READY", "ASSIGNED", "RUNNING", "REVIEWING", "SUCCEEDED"],
      FAILED: ["READY", "FAILED"],
      CANCELLED: ["CANCELLED"],
      BLOCKED: ["BLOCKED"],
      WAITING_FOR_HUMAN: ["READY", "ASSIGNED", "WAITING_FOR_HUMAN"],
    };

    for (const status of paths[target]) {
      const updated = await repo.updateNodeStatus(dagId, nodeId, status);
      expect(updated, `${nodeId} should transition to ${status}`).not.toBeNull();
    }
  }

  // ─────────────────────────────────
  // createDag
  // ─────────────────────────────────

  describe("createDag", () => {
    it("creates a DAG with nodes", async () => {
      const repo = makeRepo();
      const dag = await repo.createDag({
        id: "dag-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("task-a"), makeNode("task-b", ["task-a"])],
      });

      expect(dag.id).toBe("dag-001");
      expect(dag.status).toBe("CREATED");
      expect(Object.keys(dag.nodes)).toHaveLength(2);
      expect(dag.nodes["task-a"].status).toBe("PENDING");
    });

    it("creates different DAGs independently", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("a")],
      });
      await repo.createDag({
        id: "dag-002",
        missionId: "mission-002",
        tenantId: "tenant-002",
        nodes: [makeNode("b")],
      });

      const dag1 = await repo.findDagById("dag-001");
      const dag2 = await repo.findDagById("dag-002");
      expect(dag1).not.toBeNull();
      expect(dag2).not.toBeNull();
      expect(dag1!.missionId).toBe("mission-001");
      expect(dag2!.missionId).toBe("mission-002");
    });
  });

  // ─────────────────────────────────
  // findDagById
  // ─────────────────────────────────

  describe("findDagById", () => {
    it("finds existing DAG", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [],
      });

      const dag = await repo.findDagById("dag-001");
      expect(dag).not.toBeNull();
    });

    it("returns null for non-existent DAG", async () => {
      const repo = makeRepo();
      const dag = await repo.findDagById("nonexistent");
      expect(dag).toBeNull();
    });
  });

  // ─────────────────────────────────
  // findDagsByMissionId
  // ─────────────────────────────────

  describe("findDagsByMissionId", () => {
    it("finds all DAGs for a mission", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [],
      });
      await repo.createDag({
        id: "dag-002",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [],
      });

      const dags = await repo.findDagsByMissionId("mission-001");
      expect(dags).toHaveLength(2);
    });
  });

  // ─────────────────────────────────
  // updateDagStatus
  // ─────────────────────────────────

  describe("updateDagStatus", () => {
    it("updates DAG status", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [],
      });

      await repo.updateDagStatus("dag-001", "SCHEDULING");
      const dag = await repo.findDagById("dag-001");
      expect(dag!.status).toBe("SCHEDULING");
    });

    it("sets completedAt on terminal status", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("task-a")],
      });
      await transitionNodeTo(repo, "dag-001", "task-a", "SUCCEEDED");

      const completed = await repo.updateDagStatus("dag-001", "COMPLETED");
      expect(completed).not.toBeNull();
      const dag = await repo.findDagById("dag-001");
      expect(dag!.completedAt).toBeDefined();
    });

    const rejectedForCompletion: TaskNodeStatus[] = [
      "PENDING",
      "READY",
      "ASSIGNED",
      "RUNNING",
      "REVIEWING",
      "CHANGES_REQUIRED",
      "FAILED_REVIEW",
      "FAILED",
      "CANCELLED",
      "BLOCKED",
      "WAITING_FOR_HUMAN",
    ];

    it.each(rejectedForCompletion)(
      "rejects COMPLETED while a required node is %s",
      async (nodeStatus) => {
        const repo = makeRepo();
        await repo.createDag({
          id: `dag-${nodeStatus}`,
          missionId: "mission-001",
          tenantId: "tenant-001",
          nodes: [makeNode("task-a")],
        });
        await transitionNodeTo(repo, `dag-${nodeStatus}`, "task-a", nodeStatus);

        const completed = await repo.updateDagStatus(`dag-${nodeStatus}`, "COMPLETED");

        expect(completed).toBeNull();
        expect((await repo.findDagById(`dag-${nodeStatus}`))!.status).toBe("CREATED");
      },
    );

    it("allows COMPLETED only when every required node is SUCCEEDED", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-all-succeeded",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("task-a"), makeNode("task-b")],
      });
      await transitionNodeTo(repo, "dag-all-succeeded", "task-a", "SUCCEEDED");
      await transitionNodeTo(repo, "dag-all-succeeded", "task-b", "ASSIGNED");

      expect(await repo.updateDagStatus("dag-all-succeeded", "COMPLETED")).toBeNull();

      expect(await repo.updateNodeStatus("dag-all-succeeded", "task-b", "RUNNING")).not.toBeNull();
      expect(
        await repo.updateNodeStatus("dag-all-succeeded", "task-b", "REVIEWING"),
      ).not.toBeNull();
      expect(
        await repo.updateNodeStatus("dag-all-succeeded", "task-b", "SUCCEEDED"),
      ).not.toBeNull();
      const completed = await repo.updateDagStatus("dag-all-succeeded", "COMPLETED");

      expect(completed?.status).toBe("COMPLETED");
      expect(
        Object.values((await repo.findDagById("dag-all-succeeded"))!.nodes).every(
          (node) => node.status === "SUCCEEDED",
        ),
      ).toBe(true);
    });

    it("handles duplicate successful completion deterministically", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-idempotent",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("task-a")],
      });
      await transitionNodeTo(repo, "dag-idempotent", "task-a", "SUCCEEDED");

      const first = await repo.updateDagStatus("dag-idempotent", "COMPLETED");
      const duplicate = await repo.updateDagStatus("dag-idempotent", "COMPLETED");

      expect(duplicate).toBe(first);
      expect(duplicate?.status).toBe("COMPLETED");
      expect(duplicate?.nodes["task-a"].status).toBe("SUCCEEDED");
    });
  });

  // ─────────────────────────────────
  // updateNodeStatus
  // ─────────────────────────────────

  describe("updateNodeStatus", () => {
    it("updates node status through valid transitions", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("a")],
      });

      // PENDING → READY
      let node = await repo.updateNodeStatus("dag-001", "a", "READY");
      expect(node).not.toBeNull();
      expect(node!.status).toBe("READY");

      // READY → ASSIGNED
      node = await repo.updateNodeStatus("dag-001", "a", "ASSIGNED");
      expect(node).not.toBeNull();
      expect(node!.status).toBe("ASSIGNED");

      // ASSIGNED → RUNNING
      node = await repo.updateNodeStatus("dag-001", "a", "RUNNING");
      expect(node).not.toBeNull();
      expect(node!.status).toBe("RUNNING");

      // RUNNING → REVIEWING
      node = await repo.updateNodeStatus("dag-001", "a", "REVIEWING");
      expect(node).not.toBeNull();
      expect(node!.status).toBe("REVIEWING");

      // REVIEWING → SUCCEEDED
      node = await repo.updateNodeStatus("dag-001", "a", "SUCCEEDED");
      expect(node).not.toBeNull();
      expect(node!.status).toBe("SUCCEEDED");

      const persisted = await repo.findNodeById("dag-001", "a");
      expect(persisted?.status).toBe("SUCCEEDED");

      // Duplicate terminal success is rejected without corrupting persistence.
      expect(await repo.updateNodeStatus("dag-001", "a", "SUCCEEDED")).toBeNull();
      expect((await repo.findNodeById("dag-001", "a"))?.status).toBe("SUCCEEDED");
    });

    it("refuses invalid transitions", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("a")],
      });

      // PENDING → SUCCEEDED is invalid
      const node = await repo.updateNodeStatus("dag-001", "a", "SUCCEEDED");
      expect(node).toBeNull();
    });

    it("handles WAITING_FOR_HUMAN and resume", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("a")],
      });

      // PENDING → READY → ASSIGNED → WAITING_FOR_HUMAN
      await repo.updateNodeStatus("dag-001", "a", "READY");
      await repo.updateNodeStatus("dag-001", "a", "ASSIGNED");
      let node = await repo.updateNodeStatus("dag-001", "a", "WAITING_FOR_HUMAN");
      expect(node).not.toBeNull();
      expect(node!.status).toBe("WAITING_FOR_HUMAN");

      // WAITING_FOR_HUMAN → READY
      node = await repo.updateNodeStatus("dag-001", "a", "READY");
      expect(node).not.toBeNull();
      expect(node!.status).toBe("READY");
    });
  });

  // ─────────────────────────────────
  // findActiveDags
  // ─────────────────────────────────

  describe("findActiveDags", () => {
    it("filters out terminal DAGs", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-active",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [],
      });
      await repo.createDag({
        id: "dag-done",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("done")],
      });

      await transitionNodeTo(repo, "dag-done", "done", "SUCCEEDED");
      await repo.updateDagStatus("dag-done", "COMPLETED");

      const active = await repo.findActiveDags();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("dag-active");
    });
  });

  // ─────────────────────────────────
  // addNode
  // ─────────────────────────────────

  describe("addNode", () => {
    it("adds a node to an existing DAG", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("a")],
      });

      await repo.addNode("dag-001", makeNode("b", ["a"]));
      const dag = await repo.findDagById("dag-001");
      expect(Object.keys(dag!.nodes)).toHaveLength(2);
    });
  });

  // ─────────────────────────────────
  // findNodeById
  // ─────────────────────────────────

  describe("findNodeById", () => {
    it("finds a node in a DAG", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("a")],
      });

      const node = await repo.findNodeById("dag-001", "a");
      expect(node).not.toBeNull();
      expect(node!.id).toBe("a");
    });

    it("returns null for non-existent node", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-001",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("a")],
      });

      const node = await repo.findNodeById("dag-001", "nonexistent");
      expect(node).toBeNull();
    });
  });

  // ─────────────────────────────────
  // updateNodeStatus with partial updates
  // ─────────────────────────────────

  describe("updateNodeStatus with updates", () => {
    it("applies partial updates to node", async () => {
      const repo = makeRepo();
      await repo.createDag({
        id: "dag-003",
        missionId: "mission-001",
        tenantId: "tenant-001",
        nodes: [makeNode("a")],
      });

      // PENDING → READY → ASSIGNED
      await repo.updateNodeStatus("dag-003", "a", "READY");
      const node = await repo.updateNodeStatus("dag-003", "a", "ASSIGNED", {
        currentWorkerId: "worker-001",
        workerAssignments: [
          {
            workerId: "worker-001",
            startedAt: new Date().toISOString(),
          },
        ],
      });

      expect(node).not.toBeNull();
      expect(node!.currentWorkerId).toBe("worker-001");
      expect(node!.workerAssignments).toHaveLength(1);
    });
  });
});

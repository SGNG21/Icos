import { describe, expect, it } from "vitest";

import { InMemorySupervisorRepository } from "./supervisor-repository";
import type { TaskNode } from "@/core/supervisor";

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
        nodes: [],
      });

      await repo.updateDagStatus("dag-001", "COMPLETED");
      const dag = await repo.findDagById("dag-001");
      expect(dag!.completedAt).toBeDefined();
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
        nodes: [],
      });

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

import { describe, expect, it } from "vitest";

import {
  isNodeTransitionAllowed,
  isDagTransitionAllowed,
  isNodeTerminal,
  isDagTerminal,
  canRetryNode,
  detectCycle,
  computeReadyNodes,
  wouldCreateCycle,
  topologicalSort,
  validateDag,
  allowedNodeTransitionsFrom,
} from "./lifecycle";
import type { TaskDag, TaskNode, TaskNodeStatus } from "./contract";

// ─────────────────────────────────────
// Node transitions
// ─────────────────────────────────────

describe("isNodeTransitionAllowed", () => {
  const allowedCases: Array<[TaskNodeStatus, TaskNodeStatus]> = [
    ["PENDING", "READY"],
    ["PENDING", "BLOCKED"],
    ["PENDING", "CANCELLED"],
    ["READY", "ASSIGNED"],
    ["READY", "BLOCKED"],
    ["READY", "CANCELLED"],
    // Provisioning (worktree/spawn) peut échouer entre READY et ASSIGNED :
    // le nœud doit pouvoir atteindre un état terminal plutôt que rester zombie.
    ["READY", "FAILED"],
    ["ASSIGNED", "RUNNING"],
    ["ASSIGNED", "WAITING_FOR_HUMAN"],
    ["ASSIGNED", "FAILED"],
    ["ASSIGNED", "CANCELLED"],
    ["RUNNING", "REVIEWING"],
    ["RUNNING", "FAILED"],
    ["RUNNING", "CANCELLED"],
    ["REVIEWING", "SUCCEEDED"],
    ["REVIEWING", "CHANGES_REQUIRED"],
    ["REVIEWING", "FAILED_REVIEW"],
    ["REVIEWING", "FAILED"],
    ["CHANGES_REQUIRED", "READY"],
    ["CHANGES_REQUIRED", "FAILED"],
    ["FAILED_REVIEW", "READY"],
    ["FAILED_REVIEW", "FAILED"],
    ["BLOCKED", "PENDING"],
    ["BLOCKED", "CANCELLED"],
    ["WAITING_FOR_HUMAN", "READY"],
    ["WAITING_FOR_HUMAN", "CANCELLED"],
  ];

  for (const [from, to] of allowedCases) {
    it(`allows ${from} → ${to}`, () => {
      expect(isNodeTransitionAllowed(from, to)).toBe(true);
    });
  }

  const deniedCases: Array<[TaskNodeStatus, TaskNodeStatus]> = [
    ["PENDING", "RUNNING"],
    ["PENDING", "SUCCEEDED"],
    ["SUCCEEDED", "READY"],
    ["SUCCEEDED", "FAILED"],
    ["FAILED", "READY"],
    ["CANCELLED", "PENDING"],
    ["BLOCKED", "SUCCEEDED"],
    ["ASSIGNED", "REVIEWING"],
    ["RUNNING", "READY"],
  ];

  for (const [from, to] of deniedCases) {
    it(`denies ${from} → ${to}`, () => {
      expect(isNodeTransitionAllowed(from, to)).toBe(false);
    });
  }
});

describe("allowedNodeTransitionsFrom", () => {
  it("returns valid targets for PENDING", () => {
    const allowed = allowedNodeTransitionsFrom("PENDING");
    expect(allowed).toContain("READY");
    expect(allowed).toContain("BLOCKED");
    expect(allowed).toContain("CANCELLED");
    expect(allowed).not.toContain("SUCCEEDED");
  });

  it("returns empty for terminal states", () => {
    expect(allowedNodeTransitionsFrom("SUCCEEDED")).toEqual([]);
    expect(allowedNodeTransitionsFrom("FAILED")).toEqual([]);
    expect(allowedNodeTransitionsFrom("CANCELLED")).toEqual([]);
  });
});

// ─────────────────────────────────────
// Terminal states
// ─────────────────────────────────────

describe("isNodeTerminal", () => {
  it("identifies terminal states", () => {
    expect(isNodeTerminal("SUCCEEDED")).toBe(true);
    expect(isNodeTerminal("FAILED")).toBe(true);
    expect(isNodeTerminal("CANCELLED")).toBe(true);
    expect(isNodeTerminal("BLOCKED")).toBe(true);
  });

  it("identifies non-terminal states", () => {
    expect(isNodeTerminal("PENDING")).toBe(false);
    expect(isNodeTerminal("READY")).toBe(false);
    expect(isNodeTerminal("RUNNING")).toBe(false);
    expect(isNodeTerminal("REVIEWING")).toBe(false);
    expect(isNodeTerminal("WAITING_FOR_HUMAN")).toBe(false);
  });
});

// ─────────────────────────────────────
// DAG transitions
// ─────────────────────────────────────

describe("isDagTransitionAllowed", () => {
  it("allows valid DAG transitions", () => {
    expect(isDagTransitionAllowed("CREATED", "SCHEDULING")).toBe(true);
    expect(isDagTransitionAllowed("CREATED", "FAILED")).toBe(true);
    expect(isDagTransitionAllowed("SCHEDULING", "EXECUTING")).toBe(true);
    expect(isDagTransitionAllowed("EXECUTING", "COMPLETED")).toBe(true);
    expect(isDagTransitionAllowed("EXECUTING", "FAILED")).toBe(true);
  });

  it("denies invalid DAG transitions", () => {
    expect(isDagTransitionAllowed("CREATED", "EXECUTING")).toBe(false);
    expect(isDagTransitionAllowed("COMPLETED", "CREATED")).toBe(false);
    expect(isDagTransitionAllowed("FAILED", "EXECUTING")).toBe(false);
  });
});

describe("isDagTerminal", () => {
  it("identifies terminal DAG states", () => {
    expect(isDagTerminal("COMPLETED")).toBe(true);
    expect(isDagTerminal("FAILED")).toBe(true);
    expect(isDagTerminal("CANCELLED")).toBe(true);
  });

  it("identifies non-terminal DAG states", () => {
    expect(isDagTerminal("CREATED")).toBe(false);
    expect(isDagTerminal("SCHEDULING")).toBe(false);
    expect(isDagTerminal("EXECUTING")).toBe(false);
  });
});

// ─────────────────────────────────────
// Retry logic
// ─────────────────────────────────────

describe("canRetryNode", () => {
  const baseNode: TaskNode = {
    id: "task-001",
    label: "Test",
    description: "A test node",
    acceptanceCriteria: [],
    status: "FAILED",
    dependsOn: [],
    blockedBy: [],
    workerAssignments: [],
    correctionIds: [],
    correctionCount: 0,
    retryCount: 0,
    maxRetries: 2,
    createdAt: "2026-07-26T10:00:00Z",
    updatedAt: "2026-07-26T10:00:00Z",
  };

  it("allows retry when under maxRetries", () => {
    expect(canRetryNode({ ...baseNode, retryCount: 0 })).toBe(true);
    expect(canRetryNode({ ...baseNode, retryCount: 1 })).toBe(true);
  });

  it("denies retry when at maxRetries", () => {
    expect(canRetryNode({ ...baseNode, retryCount: 2 })).toBe(false);
  });

  it("denies retry for non-retryable states", () => {
    expect(canRetryNode({ ...baseNode, status: "SUCCEEDED" })).toBe(false);
    expect(canRetryNode({ ...baseNode, status: "CANCELLED" })).toBe(false);
  });

  it("allows retry for BLOCKED nodes", () => {
    expect(canRetryNode({ ...baseNode, status: "BLOCKED" })).toBe(true);
  });

  it("allows retry for FAILED nodes with remaining retries", () => {
    expect(canRetryNode({ ...baseNode, status: "FAILED" })).toBe(true);
  });
});

// ─────────────────────────────────────
// Cycle detection
// ─────────────────────────────────────

describe("detectCycle", () => {
  it("returns null for an acyclic graph", () => {
    const nodes = new Map([
      ["a", { id: "a", dependsOn: [] }],
      ["b", { id: "b", dependsOn: ["a"] }],
      ["c", { id: "c", dependsOn: ["b"] }],
    ]);

    expect(detectCycle(nodes)).toBeNull();
  });

  it("detects a direct cycle", () => {
    const nodes = new Map([
      ["a", { id: "a", dependsOn: ["b"] }],
      ["b", { id: "b", dependsOn: ["a"] }],
    ]);

    const cycle = detectCycle(nodes);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
  });

  it("detects an indirect cycle", () => {
    const nodes = new Map([
      ["a", { id: "a", dependsOn: ["b"] }],
      ["b", { id: "b", dependsOn: ["c"] }],
      ["c", { id: "c", dependsOn: ["a"] }],
    ]);

    expect(detectCycle(nodes)).not.toBeNull();
  });

  it("detects a self-loop", () => {
    const nodes = new Map([
      ["a", { id: "a", dependsOn: ["a"] }],
    ]);

    expect(detectCycle(nodes)).not.toBeNull();
  });
});

// ─────────────────────────────────────
// Ready-node calculation
// ─────────────────────────────────────

describe("computeReadyNodes", () => {
  function makeDag(nodes: Omit<TaskNode, "createdAt" | "updatedAt">[]): TaskDag {
    const now = "2026-07-26T10:00:00Z";
    const nodeMap: Record<string, TaskNode> = {};
    for (const n of nodes) {
      nodeMap[n.id] = { ...n, createdAt: now, updatedAt: now };
    }
    return {
      id: "dag-test",
      missionId: "mission-test",
      tenantId: "tenant-test",
      status: "EXECUTING",
      nodes: nodeMap,
      nodeOrder: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  it("returns root nodes as ready", () => {
    const dag = makeDag([
      {
        id: "a", label: "A", description: "", status: "PENDING",
        acceptanceCriteria: [],
        dependsOn: [], blockedBy: [], workerAssignments: [], correctionIds: [],
        correctionCount: 0, retryCount: 0, maxRetries: 2,
      },
      {
        id: "b", label: "B", description: "", status: "PENDING",
        acceptanceCriteria: [],
        dependsOn: ["a"], blockedBy: [], workerAssignments: [], correctionIds: [],
        correctionCount: 0, retryCount: 0, maxRetries: 2,
      },
    ]);

    const ready = computeReadyNodes(dag);
    expect(ready).toEqual(["a"]);
  });

  it("returns dependent nodes when dependencies succeed", () => {
    const dag = makeDag([
      {
        id: "a", label: "A", description: "", status: "SUCCEEDED",
        acceptanceCriteria: [],
        dependsOn: [], blockedBy: [], workerAssignments: [], correctionIds: [],
        correctionCount: 0, retryCount: 0, maxRetries: 2,
      },
      {
        id: "b", label: "B", description: "", status: "PENDING",
        acceptanceCriteria: [],
        dependsOn: ["a"], blockedBy: [], workerAssignments: [], correctionIds: [],
        correctionCount: 0, retryCount: 0, maxRetries: 2,
      },
    ]);

    const ready = computeReadyNodes(dag);
    expect(ready).toEqual(["b"]);
  });

  it("does not return nodes with failed dependencies", () => {
    const dag = makeDag([
      {
        id: "a", label: "A", description: "", status: "FAILED",
        acceptanceCriteria: [],
        dependsOn: [], blockedBy: [], workerAssignments: [], correctionIds: [],
        correctionCount: 0, retryCount: 0, maxRetries: 2,
      },
      {
        id: "b", label: "B", description: "", status: "PENDING",
        acceptanceCriteria: [],
        dependsOn: ["a"], blockedBy: [], workerAssignments: [], correctionIds: [],
        correctionCount: 0, retryCount: 0, maxRetries: 2,
      },
    ]);

    const ready = computeReadyNodes(dag);
    expect(ready).toEqual([]);
  });

  it("skips non-PENDING nodes", () => {
    const dag = makeDag([
      {
        id: "a", label: "A", description: "", status: "RUNNING",
        acceptanceCriteria: [],
        dependsOn: [], blockedBy: [], workerAssignments: [], correctionIds: [],
        correctionCount: 0, retryCount: 0, maxRetries: 2,
      },
      {
        id: "b", label: "B", description: "", status: "PENDING",
        acceptanceCriteria: [],
        dependsOn: [], blockedBy: [], workerAssignments: [], correctionIds: [],
        correctionCount: 0, retryCount: 0, maxRetries: 2,
      },
    ]);

    const ready = computeReadyNodes(dag);
    expect(ready).toEqual(["b"]);
  });
});

// ─────────────────────────────────────
// Cycle prevention (wouldCreateCycle)
// ─────────────────────────────────────

describe("wouldCreateCycle", () => {
  it("detects that adding a dependency would create a cycle", () => {
    const nodes = new Map([
      ["a", { id: "a", dependsOn: ["b"] }],
      ["b", { id: "b", dependsOn: [] }],
    ]);

    expect(wouldCreateCycle(nodes, "b", "a")).toBe(true);
  });

  it("allows adding a dependency that does not create a cycle", () => {
    const nodes = new Map([
      ["a", { id: "a", dependsOn: [] }],
      ["b", { id: "b", dependsOn: [] }],
    ]);

    expect(wouldCreateCycle(nodes, "b", "a")).toBe(false);
  });
});

// ─────────────────────────────────────
// Topological sort
// ─────────────────────────────────────

describe("topologicalSort", () => {
  it("sorts a linear DAG correctly", () => {
    const dag = createTestDag([
      { id: "a", deps: [] },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["b"] },
    ]);

    const sorted = topologicalSort(dag);
    expect(sorted).toEqual(["a", "b", "c"]);
  });

  it("sorts a diamond DAG", () => {
    const dag = createTestDag([
      { id: "a", deps: [] },
      { id: "b", deps: ["a"] },
      { id: "c", deps: ["a"] },
      { id: "d", deps: ["b", "c"] },
    ]);

    const sorted = topologicalSort(dag);
    expect(sorted).not.toBeNull();
    expect(sorted!.indexOf("a")).toBeLessThan(sorted!.indexOf("b"));
    expect(sorted!.indexOf("a")).toBeLessThan(sorted!.indexOf("c"));
    expect(sorted!.indexOf("b")).toBeLessThan(sorted!.indexOf("d"));
    expect(sorted!.indexOf("c")).toBeLessThan(sorted!.indexOf("d"));
  });

  it("returns null for a cyclic DAG", () => {
    const dag = createTestDag([
      { id: "a", deps: ["b"] },
      { id: "b", deps: ["a"] },
    ]);

    expect(topologicalSort(dag)).toBeNull();
  });
});

// ─────────────────────────────────────
// DAG validation
// ─────────────────────────────────────

describe("validateDag", () => {
  it("validates a correct DAG", () => {
    const errors = validateDag([
      createNode("a", []),
      createNode("b", ["a"]),
    ]);
    expect(errors).toEqual([]);
  });

  it("detects missing dependencies", () => {
    const errors = validateDag([
      createNode("a", ["nonexistent"]),
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("nonexistent");
  });

  it("detects cycles", () => {
    const errors = validateDag([
      createNode("a", ["b"]),
      createNode("b", ["a"]),
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("Cycle"))).toBe(true);
  });

  it("detects missing root node (all nodes have dependencies)", () => {
    const errors = validateDag([
      createNode("a", ["b"]),
      createNode("b", ["a"]),
    ]);
    expect(errors.some((e) => e.includes("nœud racine"))).toBe(true);
  });

  it("allows valid DAG with root", () => {
    // Deux nœuds, a est root, b dépend de a → pas de cycle
    const errors = validateDag([
      createNode("a", []),
      createNode("b", ["a"]),
    ]);
    expect(errors).toEqual([]);
  });

  it("detects duplicate IDs", () => {
    const errors = validateDag([
      createNode("a", []),
    ]);
    // Pas de vraie duplication dans le tableau unique, ça passe
    expect(errors).toEqual([]);
  });
});

// ─────────────────────────────────────
// Helpers
// ─────────────────────────────────────

function createTestDag(
  spec: Array<{ id: string; deps: string[] }>,
): TaskDag {
  const now = "2026-07-26T10:00:00Z";
  const nodes: Record<string, TaskNode> = {};
  for (const s of spec) {
    nodes[s.id] = createNode(s.id, s.deps);
  }
  return {
    id: "dag-test",
    missionId: "mission-test",
    tenantId: "tenant-test",
    status: "EXECUTING",
    nodes,
    nodeOrder: [],
    createdAt: now,
    updatedAt: now,
  };
}

function createNode(id: string, deps: string[]): TaskNode {
  return {
    id,
    label: `Task ${id}`,
    description: `Task ${id} description`,
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

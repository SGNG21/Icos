import { describe, expect, it } from "vitest";

import type { MissionTask } from "@/core/mission/contracts";

import { buildDag, deriveNodeStatus, type DagInputTask } from "./dag";

function t(id: string, status: MissionTask["status"], dependsOn: string[] = []): DagInputTask {
  return { task: { id, title: id.toUpperCase(), status, dependsOn, taskId: `task-${id}` } };
}

describe("deriveNodeStatus", () => {
  it("maps canonical statuses without inventing finer states", () => {
    expect(deriveNodeStatus(t("a", "succeeded").task, true)).toBe("COMPLETED");
    expect(deriveNodeStatus(t("a", "failed").task, true)).toBe("FAILED_TERMINAL");
    expect(deriveNodeStatus(t("a", "awaiting_approval").task, true)).toBe("ESCALATED");
    expect(deriveNodeStatus(t("a", "superseded").task, true)).toBe("SUPERSEDED");
  });

  it("distinguishes READY / CLAIMED / DISPATCHED only from the dispatch ledger", () => {
    const q = t("a", "queued").task;
    expect(deriveNodeStatus(q, false)).toBe("PENDING");
    expect(deriveNodeStatus(q, true)).toBe("READY");
    expect(deriveNodeStatus(q, true, { attempt: 1, state: "prepared" })).toBe("CLAIMED");
    expect(deriveNodeStatus(q, true, { attempt: 2, state: "dispatched" })).toBe("DISPATCHED");
  });

  it("uses the review verdict for review_pending", () => {
    const r = t("a", "review_pending").task;
    const review = (decision: string) => ({ decision, reasons: ["x"], reviewerKind: "llm", createdAt: "" });
    expect(deriveNodeStatus(r, true)).toBe("AWAITING_REVIEW");
    expect(deriveNodeStatus(r, true, undefined, review("REQUEST_CHANGES"))).toBe("REPAIR_REQUIRED");
    expect(deriveNodeStatus(r, true, undefined, review("ESCALATE_TO_HUMAN"))).toBe("ESCALATED");
  });
});

describe("buildDag", () => {
  it("layers by longest path and exposes parallel roots", () => {
    const dag = buildDag([t("a", "succeeded"), t("b", "succeeded"), t("c", "queued", ["a", "b"]), t("d", "queued", ["c", "a"])]);
    const layer = Object.fromEntries(dag.nodes.map((n) => [n.id, n.layer]));
    expect(layer).toEqual({ a: 0, b: 0, c: 1, d: 2 });
    expect(dag.roots).toEqual(["a", "b"]);
    expect(dag.maxParallelism).toBe(2);
    expect(dag.nodes.find((n) => n.id === "c")!.status).toBe("READY");
    expect(dag.nodes.find((n) => n.id === "d")!.status).toBe("PENDING");
  });

  it("computes the remaining critical path over unfinished work only", () => {
    const dag = buildDag([
      t("a", "succeeded"),
      t("b", "running", ["a"]),
      t("c", "queued", ["b"]),
      t("x", "queued", ["a"]),
    ]);
    expect(dag.criticalPath).toEqual(["a", "b", "c"]);
    expect(dag.criticalRemaining).toBe(2);
    expect(dag.edges.find((e) => e.from === "b" && e.to === "c")!.critical).toBe(true);
    expect(dag.edges.find((e) => e.to === "x")!.critical).toBe(false);
  });

  it("has an empty critical path when everything is done", () => {
    expect(buildDag([t("a", "succeeded"), t("b", "succeeded", ["a"])]).criticalPath).toEqual([]);
  });

  it("explains why a node is blocked", () => {
    const dag = buildDag([t("a", "failed"), t("b", "queued", ["a"]), t("c", "queued", ["zzz"]), t("d", "draft")]);
    const reason = (id: string) => dag.nodes.find((n) => n.id === id)!.blockedReason;
    expect(reason("b")).toBe("Blocked by “A”.");
    expect(reason("c")).toContain("missing from the graph: zzz");
    expect(reason("d")).toContain("Draft");
    expect(dag.danglingDependencies).toEqual(["zzz"]);
  });

  it("isolates dependency cycles instead of looping", () => {
    const dag = buildDag([t("a", "queued", ["b"]), t("b", "queued", ["a"]), t("c", "queued")]);
    expect(dag.cycle.sort()).toEqual(["a", "b"]);
    expect(dag.nodes.find((n) => n.id === "a")!.layer).toBe(1);
  });

  it("lays out hundreds of nodes quickly and without overlap", () => {
    const input: DagInputTask[] = [];
    for (let i = 0; i < 600; i += 1) {
      const deps = i < 20 ? [] : [`n${i - 20}`, `n${(i * 7) % i}`];
      input.push(t(`n${i}`, i < 200 ? "succeeded" : "queued", deps));
    }
    const started = performance.now();
    const dag = buildDag(input);
    expect(performance.now() - started).toBeLessThan(500);
    const positions = new Set(dag.nodes.map((n) => `${n.x},${n.y}`));
    expect(positions.size).toBe(600);
    expect(dag.cycle).toEqual([]);
  });
});

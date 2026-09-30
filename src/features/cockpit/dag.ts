import type { MissionTask } from "@/core/mission/contracts";

/**
 * Mission DAG read model: status derivation, layered layout, critical path.
 *
 * Pure. It only projects what canonical data proves: statuses that ICOS does
 * not expose yet (VALIDATING, INTEGRATING, READY_FOR_INTEGRATION, QUARANTINED,
 * FAILED_RETRYABLE — BR-13) are part of the vocabulary but never produced here.
 */
export const NODE_STATUSES = [
  "PENDING",
  "READY",
  "CLAIMED",
  "DISPATCHED",
  "RUNNING",
  "VALIDATING",
  "AWAITING_REVIEW",
  "REPAIR_REQUIRED",
  "READY_FOR_INTEGRATION",
  "INTEGRATING",
  "COMPLETED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "ESCALATED",
  "QUARANTINED",
  "SUPERSEDED",
  "BLOCKED",
  "CANCELLED",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export interface NodeAttempt {
  attempt: number;
  state: "prepared" | "dispatched" | "completed" | "failed";
  workerId?: string;
  workerKind?: string;
  failureClass?: string;
  lastError?: string;
  dispatchedAt?: string;
}

export interface NodeReview {
  decision: string;
  reasons: readonly string[];
  reviewerKind: string;
  provider?: string;
  model?: string;
  createdAt: string;
}

export interface DagInputTask {
  task: Pick<
    MissionTask,
    "id" | "title" | "status" | "dependsOn" | "workerKind" | "capability" | "taskId"
  >;
  /** Current non-terminal dispatch attempt, if any. */
  attempt?: NodeAttempt;
  /** Latest review decision for the canonical task, if any. */
  review?: NodeReview;
}

export interface DagNode {
  id: string;
  title: string;
  status: NodeStatus;
  canonicalStatus: MissionTask["status"];
  layer: number;
  row: number;
  x: number;
  y: number;
  dependsOn: string[];
  dependents: string[];
  onCriticalPath: boolean;
  blockedReason: string | null;
  capability: string | null;
  workerKind: string | null;
  taskId: string;
  attempt: NodeAttempt | null;
  review: NodeReview | null;
}

export interface DagEdge {
  from: string;
  to: string;
  critical: boolean;
}

export interface DagModel {
  nodes: DagNode[];
  edges: DagEdge[];
  /** Longest chain of unfinished work (node ids, root first). Empty when all done. */
  criticalPath: string[];
  /** Unfinished nodes on the critical path (the chain may start with completed ancestors). */
  criticalRemaining: number;
  roots: string[];
  /** Nodes that could not be layered because they sit on a dependency cycle. */
  cycle: string[];
  /** Dependency ids referenced but absent from the mission graph. */
  danglingDependencies: string[];
  width: number;
  height: number;
  maxParallelism: number;
}

export const NODE_W = 208;
export const NODE_H = 64;
const COL = NODE_W + 56;
const ROW = NODE_H + 22;

const DONE: ReadonlySet<NodeStatus> = new Set(["COMPLETED", "SUPERSEDED", "CANCELLED"]);

export function isFinished(status: NodeStatus): boolean {
  return DONE.has(status);
}

export function deriveNodeStatus(
  task: DagInputTask["task"],
  depsCompleted: boolean,
  attempt?: NodeAttempt,
  review?: NodeReview,
): NodeStatus {
  switch (task.status) {
    case "superseded":
      return "SUPERSEDED";
    case "succeeded":
      return "COMPLETED";
    case "cancelled":
      return "CANCELLED";
    case "failed":
      return "FAILED_TERMINAL";
    case "running":
      return "RUNNING";
    case "awaiting_approval":
      return "ESCALATED";
    case "blocked":
      return "BLOCKED";
    case "draft":
      return "PENDING";
    case "review_pending":
      if (review?.decision === "REQUEST_CHANGES") return "REPAIR_REQUIRED";
      if (review?.decision === "ESCALATE_TO_HUMAN") return "ESCALATED";
      return "AWAITING_REVIEW";
    case "queued":
      if (attempt?.state === "dispatched") return "DISPATCHED";
      if (attempt?.state === "prepared") return "CLAIMED";
      return depsCompleted ? "READY" : "PENDING";
  }
}

export function buildDag(input: readonly DagInputTask[]): DagModel {
  const byId = new Map(input.map((entry) => [entry.task.id, entry]));
  const dangling = new Set<string>();
  const dependents = new Map<string, string[]>(input.map((e) => [e.task.id, []]));
  for (const { task } of input) {
    for (const dep of task.dependsOn) {
      if (byId.has(dep)) dependents.get(dep)!.push(task.id);
      else dangling.add(dep);
    }
  }

  // Kahn topological layering: layer = longest distance from a root.
  const indegree = new Map(
    input.map((e) => [e.task.id, e.task.dependsOn.filter((d) => byId.has(d)).length]),
  );
  const layer = new Map<string, number>();
  const order: string[] = [];
  const queue = input.filter((e) => indegree.get(e.task.id) === 0).map((e) => e.task.id);
  for (const id of queue) layer.set(id, 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const child of dependents.get(id)!) {
      layer.set(child, Math.max(layer.get(child) ?? 0, layer.get(id)! + 1));
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  const ordered = new Set(order);
  const cycle = input.map((e) => e.task.id).filter((id) => !ordered.has(id));
  const maxLayer = Math.max(-1, ...order.map((id) => layer.get(id)!));
  for (const id of cycle) layer.set(id, maxLayer + 1);

  // Status needs dependency completion, which needs topological order.
  const status = new Map<string, NodeStatus>();
  for (const id of [...order, ...cycle]) {
    const entry = byId.get(id)!;
    const depsCompleted = entry.task.dependsOn.every(
      (dep) => byId.has(dep) && status.get(dep) === "COMPLETED",
    );
    status.set(id, deriveNodeStatus(entry.task, depsCompleted, entry.attempt, entry.review));
  }

  // Remaining critical path: longest chain counting only unfinished nodes.
  const dist = new Map<string, number>();
  const parent = new Map<string, string | null>();
  for (const id of order) {
    const weight = isFinished(status.get(id)!) ? 0 : 1;
    let best: string | null = null;
    for (const dep of byId.get(id)!.task.dependsOn) {
      if (!dist.has(dep)) continue;
      if (best === null || dist.get(dep)! > dist.get(best)!) best = dep;
    }
    dist.set(id, weight + (best ? dist.get(best)! : 0));
    parent.set(id, best);
  }
  let end: string | null = null;
  for (const id of order) if (end === null || dist.get(id)! > dist.get(end)!) end = id;
  const criticalPath: string[] = [];
  if (end && dist.get(end)! > 0) {
    for (let cursor: string | null = end; cursor; cursor = parent.get(cursor) ?? null) {
      criticalPath.unshift(cursor);
    }
  }
  const critical = new Set(criticalPath);

  // One barycenter pass orders each layer by the mean row of its parents.
  // ponytail: single pass, crossings still possible on dense graphs; iterate if it matters.
  const layers: string[][] = [];
  for (const id of [...order, ...cycle]) (layers[layer.get(id)!] ??= []).push(id);
  const row = new Map<string, number>();
  layers.forEach((ids, index) => {
    if (index > 0) {
      const score = (id: string) => {
        const rows = byId
          .get(id)!
          .task.dependsOn.filter((d) => row.has(d))
          .map((d) => row.get(d)!);
        return rows.length
          ? rows.reduce((a, b) => a + b, 0) / rows.length
          : Number.MAX_SAFE_INTEGER;
      };
      ids.sort((a, b) => score(a) - score(b));
    }
    ids.forEach((id, r) => row.set(id, r));
  });

  const nodes: DagNode[] = input.map(({ task, attempt, review }) => {
    const nodeStatus = status.get(task.id)!;
    return {
      id: task.id,
      title: task.title,
      status: nodeStatus,
      canonicalStatus: task.status,
      layer: layer.get(task.id)!,
      row: row.get(task.id)!,
      x: layer.get(task.id)! * COL,
      y: row.get(task.id)! * ROW,
      dependsOn: [...task.dependsOn],
      dependents: dependents.get(task.id)!,
      onCriticalPath: critical.has(task.id),
      blockedReason: blockedReason(task, nodeStatus, byId, status),
      capability: task.capability ?? null,
      workerKind: attempt?.workerKind ?? task.workerKind ?? null,
      taskId: task.taskId,
      attempt: attempt ?? null,
      review: review ?? null,
    };
  });

  const edges: DagEdge[] = [];
  for (const { task } of input) {
    for (const dep of task.dependsOn) {
      if (byId.has(dep)) {
        edges.push({
          from: dep,
          to: task.id,
          critical: critical.has(dep) && critical.has(task.id),
        });
      }
    }
  }

  const maxParallelism = Math.max(0, ...layers.map((ids) => ids.length));
  return {
    nodes,
    edges,
    criticalPath,
    criticalRemaining: criticalPath.filter((id) => !isFinished(status.get(id)!)).length,
    roots: layers[0] ?? [],
    cycle,
    danglingDependencies: [...dangling],
    width: Math.max(1, layers.length) * COL - (COL - NODE_W),
    height: Math.max(1, maxParallelism) * ROW - (ROW - NODE_H),
    maxParallelism,
  };
}

function blockedReason(
  task: DagInputTask["task"],
  nodeStatus: NodeStatus,
  byId: ReadonlyMap<string, DagInputTask>,
  status: ReadonlyMap<string, NodeStatus>,
): string | null {
  if (nodeStatus === "ESCALATED") return "Awaiting a human decision.";
  if (nodeStatus !== "PENDING" && nodeStatus !== "BLOCKED") return null;

  const unknownDeps = task.dependsOn.filter((dep) => !byId.has(dep));
  if (unknownDeps.length)
    return `Depends on tasks missing from the graph: ${unknownDeps.join(", ")}.`;

  const failed = task.dependsOn.filter((dep) =>
    ["FAILED_TERMINAL", "CANCELLED", "BLOCKED"].includes(status.get(dep) ?? ""),
  );
  if (failed.length) return `Blocked by ${failed.map((d) => titleOf(byId, d)).join(", ")}.`;

  const waiting = task.dependsOn.filter((dep) => status.get(dep) !== "COMPLETED");
  if (waiting.length) return `Waiting on ${waiting.map((d) => titleOf(byId, d)).join(", ")}.`;

  if (nodeStatus === "BLOCKED")
    return "Canonical status is blocked; the backend does not expose why (BR-09).";
  if (task.status === "draft") return "Draft: not yet queued by ICOS.";
  return null;
}

const titleOf = (byId: ReadonlyMap<string, DagInputTask>, id: string) =>
  `“${byId.get(id)?.task.title ?? id}”`;

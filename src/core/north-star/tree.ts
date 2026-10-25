import { z } from "zod";
import seedData from "./seed/ICOS_NORTH_STAR_TREE_SEED.json";

export const NORTH_STAR_STATUSES = [
  "UNVERIFIED",
  "NOT_STARTED_CONFIRMED",
  "IN_PROGRESS_EVIDENCED",
  "BLOCKED_EVIDENCED",
  "IMPLEMENTED_EVIDENCED",
  "TESTED_EVIDENCED",
  "OPERATIONAL_EVIDENCED",
  "MEASURED_EVIDENCED",
] as const;
export type NorthStarStatus = (typeof NORTH_STAR_STATUSES)[number];

export const NORTH_STAR_NODE_TYPES = ["north_star", "program", "project", "capability"] as const;
export type NorthStarNodeType = (typeof NORTH_STAR_NODE_TYPES)[number];

export type NorthStarPriority = "P0" | "P1" | "P2";

export const NORTH_STAR_SEED_SHA256 =
  "ed8d1f3ba6979758443bc814a002ad1943bf79241b801d7903ffe962b5542387";

export const northStarNodeSchema = z
  .object({
    id: z.string(),
    parent_id: z.string().nullable(),
    type: z.enum(NORTH_STAR_NODE_TYPES),
    title: z.string(),
    priority: z.enum(["P0", "P1", "P2"]),
    visual_panels: z.array(z.number()).optional(),
    target_definition: z.literal("DEFINED"),
    implementation_status: z.enum(NORTH_STAR_STATUSES),
    maturity: z.null(),
    progress: z.null(),
    source: z.string(),
  })
  .strict();

export const northStarSeedSchema = z
  .object({
    schema_version: z.literal("1.0.0"),
    dataset_id: z.string(),
    generated_on: z.string(),
    classification: z.string(),
    authority_warning: z.string(),
    truth_policy: z
      .object({
        source_of_truth: z.string(),
        implementation_default: z.string(),
        statuses: z.array(z.string()),
        completion_rule: z.string(),
        progress_rule: z.string(),
        no_self_certification: z.boolean(),
      })
      .strict(),
    visual_map_panels: z.record(z.string(), z.string()),
    work_os_chain: z.array(z.string()),
    nodes: z.array(northStarNodeSchema).min(1),
    focus_first: z.array(z.string()),
  })
  .strict();

export type NorthStarNode = z.infer<typeof northStarNodeSchema>;
export type NorthStarSeed = z.infer<typeof northStarSeedSchema>;

export interface NorthStarTree {
  seed: NorthStarSeed;
  root: NorthStarNode;
  byId: ReadonlyMap<string, NorthStarNode>;
  childrenOf(id: string): readonly NorthStarNode[];
  pathOf(id: string): readonly NorthStarNode[];
  counts: Record<NorthStarNodeType, number>;
  countsByPriority: Record<NorthStarPriority, number>;
  countsByStatus: Record<NorthStarStatus, number>;
}

export class NorthStarSeedError extends Error {
  constructor(
    public readonly code:
      | "SCHEMA_INVALID"
      | "DUPLICATE_ID"
      | "ORPHAN_PARENT"
      | "MULTIPLE_ROOTS"
      | "CYCLE"
      | "TYPE_HIERARCHY",
    message: string
  ) {
    super(message);
    this.name = "NorthStarSeedError";
  }
}

const EXPECTED_PARENT_TYPE: Record<Exclude<NorthStarNodeType, "north_star">, NorthStarNodeType> = {
  program: "north_star",
  project: "program",
  capability: "project",
};

export function buildNorthStarTree(input: unknown): NorthStarTree {
  const parsed = northStarSeedSchema.safeParse(input);
  if (!parsed.success) {
    throw new NorthStarSeedError("SCHEMA_INVALID", parsed.error.message);
  }
  const seed = parsed.data;
  const nodes = seed.nodes;

  const byId = new Map<string, NorthStarNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      throw new NorthStarSeedError("DUPLICATE_ID", `Duplicate node id: ${node.id}`);
    }
    byId.set(node.id, node);
  }

  for (const node of nodes) {
    if (node.parent_id !== null && !byId.has(node.parent_id)) {
      throw new NorthStarSeedError(
        "ORPHAN_PARENT",
        `Node ${node.id} references unknown parent ${node.parent_id}`
      );
    }
  }

  const roots = nodes.filter((n) => n.parent_id === null);
  if (roots.length !== 1 || roots[0].type !== "north_star") {
    throw new NorthStarSeedError(
      "MULTIPLE_ROOTS",
      `Expected exactly one root node of type north_star, found ${roots.length}`
    );
  }
  const root = roots[0];

  for (const node of nodes) {
    let current: NorthStarNode = node;
    let steps = 0;
    while (current.parent_id !== null) {
      const parent = byId.get(current.parent_id);
      if (!parent) break;
      current = parent;
      steps++;
      if (steps > nodes.length) {
        throw new NorthStarSeedError("CYCLE", `Cycle detected while walking ancestors of ${node.id}`);
      }
    }
  }

  for (const node of nodes) {
    if (node.id === root.id) continue;
    const parent = byId.get(node.parent_id as string)!;
    const expected = EXPECTED_PARENT_TYPE[node.type as Exclude<NorthStarNodeType, "north_star">];
    if (!expected || parent.type !== expected) {
      throw new NorthStarSeedError(
        "TYPE_HIERARCHY",
        `Node ${node.id} of type ${node.type} has invalid parent type ${parent.type}`
      );
    }
  }

  const childrenMap = new Map<string, NorthStarNode[]>();
  for (const node of nodes) {
    if (node.parent_id === null) continue;
    const list = childrenMap.get(node.parent_id) ?? [];
    list.push(node);
    childrenMap.set(node.parent_id, list);
  }

  function childrenOf(id: string): readonly NorthStarNode[] {
    return childrenMap.get(id) ?? [];
  }

  function pathOf(id: string): readonly NorthStarNode[] {
    const node = byId.get(id);
    if (!node) return [];
    const path: NorthStarNode[] = [node];
    let current = node;
    while (current.parent_id !== null) {
      const parent = byId.get(current.parent_id);
      if (!parent) break;
      path.unshift(parent);
      current = parent;
    }
    return path;
  }

  const counts: Record<NorthStarNodeType, number> = {
    north_star: 0,
    program: 0,
    project: 0,
    capability: 0,
  };
  const countsByPriority: Record<NorthStarPriority, number> = { P0: 0, P1: 0, P2: 0 };
  const countsByStatus = NORTH_STAR_STATUSES.reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {} as Record<NorthStarStatus, number>);

  for (const node of nodes) {
    counts[node.type]++;
    countsByPriority[node.priority]++;
    countsByStatus[node.implementation_status]++;
  }

  return { seed, root, byId, childrenOf, pathOf, counts, countsByPriority, countsByStatus };
}

let cachedTree: NorthStarTree | undefined;
export function loadNorthStarTree(): NorthStarTree {
  if (!cachedTree) {
    cachedTree = buildNorthStarTree(seedData);
  }
  return cachedTree;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function searchNorthStar(tree: NorthStarTree, query: string): NorthStarNode[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const needle = normalizeSearchText(trimmed);
  return tree.seed.nodes.filter(
    (node) =>
      normalizeSearchText(node.id).includes(needle) || normalizeSearchText(node.title).includes(needle)
  );
}

export interface NorthStarFilter {
  priority?: NorthStarPriority;
  status?: NorthStarStatus;
  programId?: string;
  type?: NorthStarNodeType;
}

export function filterNorthStar(tree: NorthStarTree, f: NorthStarFilter): NorthStarNode[] {
  return tree.seed.nodes.filter((node) => {
    if (f.priority !== undefined && node.priority !== f.priority) return false;
    if (f.status !== undefined && node.implementation_status !== f.status) return false;
    if (f.type !== undefined && node.type !== f.type) return false;
    if (f.programId !== undefined) {
      const path = tree.pathOf(node.id);
      if (!path.some((n) => n.id === f.programId)) return false;
    }
    return true;
  });
}

export function nextActions(tree: NorthStarTree): NorthStarNode[] {
  return tree.seed.focus_first.map((id) => {
    const node = tree.byId.get(id);
    if (!node) {
      throw new NorthStarSeedError("ORPHAN_PARENT", `focus_first references unknown node id: ${id}`);
    }
    return node;
  });
}

export function evidenceStateOf(node: NorthStarNode): "NO_TELEMETRY" {
  void node; // Tranche 1: no Work OS link exists yet; the parameter is the future binding point.
  return "NO_TELEMETRY";
}

import { describe, expect, it } from "vitest";
import seedData from "./seed/ICOS_NORTH_STAR_TREE_SEED.json";
import {
  NorthStarSeedError,
  buildNorthStarTree,
  evidenceStateOf,
  filterNorthStar,
  loadNorthStarTree,
  nextActions,
  searchNorthStar,
  type NorthStarNode,
  type NorthStarSeed,
} from "./tree";

function expectSeedError(input: unknown, code: string): void {
  try {
    buildNorthStarTree(input);
    throw new Error("expected buildNorthStarTree to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(NorthStarSeedError);
    expect((e as NorthStarSeedError).code).toBe(code);
  }
}

function cloneSeed(): NorthStarSeed {
  return structuredClone(seedData) as unknown as NorthStarSeed;
}

const baseCapability = (overrides: Partial<NorthStarNode>): NorthStarNode => ({
  id: "test-node",
  parent_id: null,
  type: "capability",
  title: "Test node",
  priority: "P0",
  target_definition: "DEFINED",
  implementation_status: "UNVERIFIED",
  maturity: null,
  progress: null,
  source: "test",
  ...overrides,
});

describe("north-star tree", () => {
  const tree = loadNorthStarTree();

  it("has the expected node counts, priority counts, and all-UNVERIFIED statuses", () => {
    expect(tree.counts.north_star).toBe(1);
    expect(tree.counts.program).toBe(10);
    expect(tree.counts.project).toBe(45);
    expect(tree.counts.capability).toBe(225);
    expect(tree.countsByPriority.P0).toBe(96);
    expect(tree.countsByPriority.P1).toBe(146);
    expect(tree.countsByPriority.P2).toBe(39);
    expect(tree.countsByStatus.UNVERIFIED).toBe(281);
  });

  it("has a valid parent for every non-root node, and a 4-level path for capabilities", () => {
    for (const node of tree.seed.nodes) {
      if (node.parent_id !== null) {
        expect(tree.byId.has(node.parent_id)).toBe(true);
      } else {
        expect(node.type).toBe("north_star");
      }
    }

    const capability = tree.seed.nodes.find((n) => n.type === "capability");
    expect(capability).toBeDefined();
    const path = tree.pathOf(capability!.id);
    expect(path.length).toBe(4);
    expect(path.map((n) => n.type)).toEqual([
      "north_star",
      "program",
      "project",
      "capability",
    ]);
  });

  it("rejects a node with an unknown parent id (ORPHAN_PARENT)", () => {
    const clone = cloneSeed();
    clone.nodes.push(
      baseCapability({ id: "orphan-node", parent_id: "does-not-exist" }),
    );
    expectSeedError(clone, "ORPHAN_PARENT");
  });

  it("rejects a duplicate node id (DUPLICATE_ID)", () => {
    const clone = cloneSeed();
    const existing = clone.nodes[clone.nodes.length - 1];
    clone.nodes.push({ ...existing });
    expectSeedError(clone, "DUPLICATE_ID");
  });

  it("rejects a cycle between two nodes", () => {
    const clone = cloneSeed();
    clone.nodes.push(
      baseCapability({ id: "cycle-a", parent_id: "cycle-b" }),
      baseCapability({ id: "cycle-b", parent_id: "cycle-a" }),
    );
    expectSeedError(clone, "CYCLE");
  });

  it("rejects a second root (MULTIPLE_ROOTS)", () => {
    const clone = cloneSeed();
    clone.nodes.push(baseCapability({ id: "second-root", parent_id: null, type: "program" }));
    expectSeedError(clone, "MULTIPLE_ROOTS");
  });

  it("rejects a capability attached directly to a program (TYPE_HIERARCHY)", () => {
    const clone = cloneSeed();
    clone.nodes.push(baseCapability({ id: "misparented", parent_id: "p01" }));
    expectSeedError(clone, "TYPE_HIERARCHY");
  });

  it("rejects a non-null maturity (SCHEMA_INVALID)", () => {
    const clone = cloneSeed();
    const last = clone.nodes[clone.nodes.length - 1];
    (last as unknown as { maturity: string }).maturity = "M3";
    expectSeedError(clone, "SCHEMA_INVALID");
  });

  it("rejects a non-null numeric progress (SCHEMA_INVALID)", () => {
    const clone = cloneSeed();
    const last = clone.nodes[clone.nodes.length - 1];
    (last as unknown as { progress: number }).progress = 42;
    expectSeedError(clone, "SCHEMA_INVALID");
  });

  it("rejects an unknown implementation_status (SCHEMA_INVALID)", () => {
    const clone = cloneSeed();
    const last = clone.nodes[clone.nodes.length - 1];
    (last as unknown as { implementation_status: string }).implementation_status =
      "NOT_A_REAL_STATUS";
    expectSeedError(clone, "SCHEMA_INVALID");
  });

  it("search is case/accent-insensitive and empty query returns []", () => {
    const r1 = searchNorthStar(tree, "cognitif");
    const r2 = searchNorthStar(tree, "COGNITIF");
    const r3 = searchNorthStar(tree, "cognitíf");
    expect(r1.length).toBeGreaterThan(0);
    const ids1 = r1.map((n) => n.id).sort();
    expect(r2.map((n) => n.id).sort()).toEqual(ids1);
    expect(r3.map((n) => n.id).sort()).toEqual(ids1);
    expect(searchNorthStar(tree, "")).toEqual([]);
  });

  it("filterNorthStar matches manual counts and programId scopes to descendants", () => {
    const manualP0Capabilities = tree.seed.nodes.filter(
      (n) => n.priority === "P0" && n.type === "capability",
    ).length;
    expect(
      filterNorthStar(tree, { priority: "P0", type: "capability" }).length,
    ).toBe(manualP0Capabilities);

    const program = tree.seed.nodes.find((n) => n.type === "program");
    expect(program).toBeDefined();
    const scoped = filterNorthStar(tree, { programId: program!.id });
    expect(scoped.length).toBeGreaterThan(0);
    for (const node of scoped) {
      const path = tree.pathOf(node.id);
      expect(path.some((p) => p.id === program!.id)).toBe(true);
    }
  });

  it("nextActions resolves focus_first to 11 capabilities in order", () => {
    const actions = nextActions(tree);
    expect(actions.length).toBe(11);
    expect(actions.every((n) => n.type === "capability")).toBe(true);
    expect(actions.map((n) => n.id)).toEqual(tree.seed.focus_first);
  });

  it("evidenceStateOf always returns NO_TELEMETRY", () => {
    expect(evidenceStateOf(tree.seed.nodes[0])).toBe("NO_TELEMETRY");
  });
});

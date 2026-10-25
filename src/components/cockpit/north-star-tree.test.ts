import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { loadNorthStarTree } from "@/core/north-star/tree";
import { NorthStarTreeView, visibleSetFor } from "./north-star-tree";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const tree = loadNorthStarTree();
const programs = tree.childrenOf(tree.root.id);

describe("NorthStarTreeView", () => {
  it("renders the full tree with every program, capability link and no progress artefact", () => {
    const out = html(h(NorthStarTreeView, { tree, programs, visible: null, openAll: false }));

    expect((out.match(/class="ns-tree__program"/g) ?? []).length).toBe(10);
    expect((out.match(/href="\/cockpit\/north-star\/p[^"]*"/g) ?? []).length).toBe(225);
    expect(out).not.toContain("%");
    expect(out.toLowerCase()).not.toContain("progress");
  });

  it("restricts rendering to a single capability's ancestor chain", () => {
    const capability = tree.seed.nodes.find((n) => n.type === "capability")!;
    const visible = visibleSetFor(tree, [capability]);

    expect(visible.size).toBe(4);

    const out = html(h(NorthStarTreeView, { tree, programs, visible, openAll: true }));
    expect((out.match(/href="\/cockpit\/north-star\/p[^"]*"/g) ?? []).length).toBe(1);
  });

  it("labels every node as UNVERIFIED across program, project and capability levels", () => {
    const out = html(h(NorthStarTreeView, { tree, programs, visible: null, openAll: false }));
    expect((out.match(/UNVERIFIED/g) ?? []).length).toBe(280);
  });
});

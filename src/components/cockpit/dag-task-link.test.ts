import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { buildDag, type DagInputTask } from "@/features/cockpit/dag";

vi.mock("next/navigation", () => ({
  usePathname: () => "/cockpit/missions",
  useRouter: () => ({ refresh: () => {} }),
}));

const { DagView } = await import("./dag-view");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const task = (id: string, over: Partial<DagInputTask["task"]> = {}): DagInputTask => ({
  task: {
    id,
    title: `task ${id}`,
    status: "succeeded",
    dependsOn: [],
    workerKind: null,
    capability: null,
    // The canonical task id differs from the mission-task id: the result page keys on this one.
    taskId: `canonical-${id}`,
    ...over,
  },
});

/**
 * The owner must REACH the result by clicking. `/tasks/[id]` is the only page that renders
 * `execution.result`, so the graph has to link to it or a finished result is unreachable.
 */
describe("DAG node → task result page", () => {
  it("links the inspected node to its canonical task page", () => {
    const out = html(h(DagView, { dag: buildDag([task("a")]) }));
    expect(out).toContain('href="/tasks/canonical-a"');
    // A real link with a discernible name, not a div with an onClick.
    expect(out).toMatch(/<a [^>]*href="\/tasks\/canonical-a"[^>]*>[^<]*[A-Za-z]/);
  });

  it("never links to the mission-task id, which /tasks/[id] cannot resolve", () => {
    const out = html(h(DagView, { dag: buildDag([task("a")]) }));
    expect(out).not.toContain('href="/tasks/a"');
  });

  /**
   * The default selection was the last node of the critical path, and the critical path is
   * the chain of UNFINISHED work — so a mission whose work is DONE selected nothing and
   * offered no link, which is exactly the mission whose result the owner came to read.
   */
  it("still offers a result link when every task is finished", () => {
    const out = html(h(DagView, { dag: buildDag([task("a"), task("b")]) }));
    expect(out).not.toContain("Select a task to inspect it.");
    expect(out).toContain('href="/tasks/canonical-a"');
  });

  it("gives the link an accessible name that names its task", () => {
    const out = html(h(DagView, { dag: buildDag([task("a")]) }));
    expect(out).toContain('aria-label="Open the task page of task a"');
  });

  it("keeps linking the node the reader selected when work is still running", () => {
    const out = html(
      h(DagView, {
        dag: buildDag([task("a"), task("b", { status: "running", dependsOn: ["a"] })]),
      }),
    );
    expect(out).toContain('href="/tasks/canonical-b"');
  });
});

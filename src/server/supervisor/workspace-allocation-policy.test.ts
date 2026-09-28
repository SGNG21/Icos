import { describe, expect, it } from "vitest";

import {
  decideWorkspaceAllocation,
  workspaceSlug,
  type AllocationTaskView,
} from "./workspace-allocation-policy";

/*
 * M9 / DEFECT 23 — WHAT decides that a task needs a governed workspace.
 *
 * The supervisor's previous condition was `routedWorkerKind`, which made WHO executes
 * decide whether the work is governed — so an unrouted task silently skipped governance
 * entirely. These pin the replacement, and pin just as hard the inputs it must ignore.
 */

const task = (over: Partial<AllocationTaskView> = {}): AllocationTaskView => ({
  taskId: "task-abc12345",
  title: "Add the widget",
  riskClass: "reversible",
  allowedFileScope: ["src/widget/**"],
  ...over,
});

describe("M9 governed workspace allocation policy", () => {
  it("A WRITER WITH A DECLARED SCOPE IS GOVERNED, and the scope is carried through", () => {
    const decision = decideWorkspaceAllocation(task({ allowedFileScope: ["src/a/**", "src/b/**"] }));

    expect(decision.kind).toBe("GOVERNED");
    /*
     * The gate REJECTS every changed file outside `owns`, so the declared scope must BE
     * the workspace scope. A generic default would turn each governed run into a rejection.
     */
    if (decision.kind !== "GOVERNED") throw new Error("unreachable");
    expect(decision.fileScope).toEqual({
      owns: ["src/a/**", "src/b/**"],
      shared: [],
      forbidden: [],
    });
  });

  it("A SENSITIVE task is governed too — only read_only is exempt", () => {
    expect(decideWorkspaceAllocation(task({ riskClass: "sensitive" })).kind).toBe("GOVERNED");
    expect(decideWorkspaceAllocation(task({ riskClass: "reversible" })).kind).toBe("GOVERNED");
  });

  it("A READ-ONLY task needs no workspace", () => {
    /* A reader mutates nothing, so a worktree would cost a full checkout for nothing. */
    const decision = decideWorkspaceAllocation(
      task({ riskClass: "read_only", allowedFileScope: [] }),
    );
    expect(decision.kind).toBe("NOT_REQUIRED");
  });

  it("A WRITER WITH NO DECLARED SCOPE IS REFUSED, never silently run ungoverned", () => {
    /*
     * The three options were: invent a permissive scope (an autonomous agent could then
     * write anywhere), fall back to an ad-hoc worktree (the orphan-branch defect), or
     * block. Only blocking is recoverable.
     */
    const decision = decideWorkspaceAllocation(task({ allowedFileScope: [] }));
    expect(decision.kind).toBe("REFUSED");
    if (decision.kind !== "REFUSED") throw new Error("unreachable");
    expect(decision.reason).toContain("WORKSPACE_SCOPE_UNDECLARED");
  });

  it("UNDECLARED RISK IS TREATED AS A WRITER, not as a reader", () => {
    /*
     * Fail closed on absent metadata: guessing "reader" would skip governance for exactly
     * the tasks whose intent nobody wrote down. The canonical contract defaults to
     * `reversible` for the same reason.
     */
    expect(decideWorkspaceAllocation(task({ riskClass: undefined })).kind).toBe("GOVERNED");
    expect(
      decideWorkspaceAllocation(task({ riskClass: undefined, allowedFileScope: [] })).kind,
    ).toBe("REFUSED");
  });

  it("THE DECISION IGNORES PROVIDER, WORKER KIND AND MODEL", () => {
    /*
     * These describe WHO executes, which cannot change what the work is permitted to
     * touch. The policy's input type has no field for any of them, so this asserts the
     * only thing that could still vary: identical metadata decides identically however
     * the task is otherwise described.
     */
    const base = task();
    const decisions = [
      decideWorkspaceAllocation({ ...base, title: "hermes build" }),
      decideWorkspaceAllocation({ ...base, title: "digitalos build" }),
      decideWorkspaceAllocation({ ...base, title: "gpt-4 build" }),
    ];
    expect(decisions.every((d) => d.kind === "GOVERNED")).toBe(true);

    /* And the discriminator really is riskClass: change only that, and only that changes. */
    expect(decideWorkspaceAllocation({ ...base, riskClass: "read_only" }).kind).toBe(
      "NOT_REQUIRED",
    );
  });

  it("THE SLUG IS A VALID WORKER DATABASE NAME, bounded and stable", () => {
    /*
     * The slug becomes both a branch and the worker's dedicated test database, and
     * `assertWorkerDatabaseName` enforces `^icos_test_[a-z0-9_]{1,32}$`. A hyphen there
     * makes workspace creation fail outright — which is what the coordinator's own former
     * default (`task-<id>`) would have done had it ever been reached.
     */
    const slug = workspaceSlug(task({ title: "Add the WIDGET!! (v2)", taskId: "task-abc12345" }));
    expect(slug).toMatch(/^[a-z0-9][a-z0-9_]*$/);
    expect(slug).not.toContain("-");
    expect(slug.length).toBeLessThanOrEqual(32);
    expect(`icos_test_${slug}`).toMatch(/^icos_test_[a-z0-9_]{1,32}$/);
    /* Stable: the same task yields the same slug, so a retry is recognisable in git. */
    expect(workspaceSlug(task())).toBe(workspaceSlug(task()));
  });

  it("A TITLE THAT SLUGIFIES TO NOTHING still yields a valid slug", () => {
    /* `!!!` would otherwise produce an empty or leading-underscore name git refuses. */
    const slug = workspaceSlug(task({ title: "!!!", taskId: "task-zz99" }));
    expect(slug).toMatch(/^[a-z0-9][a-z0-9_]*$/);
    expect(slug.startsWith("task_")).toBe(true);
  });
});

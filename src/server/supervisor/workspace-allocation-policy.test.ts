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

  /**
   * THE SLUG MUST TELL TWO TASKS APART — the defect behind CORRECTION_DAG_E2E and
   * SUPERSEDED_ATTEMPT_WORKSPACE_HELD.
   *
   * These are the real shapes a mission produces: sibling tasks named after their ids, from
   * one generator, so the titles agree well past any cut and the ids agree in their leading
   * characters. The slug was a title cut to 18 plus the id's FIRST 8 alphanumerics, so both
   * tasks got the same slug — the same branch, the same worktree path and the same worker
   * database. It stayed invisible while every predecessor branch was reaped on integration;
   * a REFUSED attempt keeps its branch, and from then on the sibling could never be
   * allocated at all.
   */
  it("TWO SIBLING TASKS NEVER SHARE A SLUG, however late their ids differ", () => {
    const ids = [
      "d36-eo8721b6b94-c1-a",
      "d36-eo8721b6b94-c1-b",
      "d36-eo8721b6b94-c2-a",
      "task-0191f0de-9a1f-7c3e-8d2b-000000000001",
      "task-0191f0de-9a1f-7c3e-8d2b-000000000002",
    ];
    const slugs = ids.map((taskId) => workspaceSlug(task({ taskId, title: `Add ${taskId} feature` })));

    expect(new Set(slugs).size).toBe(ids.length);
    for (const slug of slugs) {
      expect(slug.length).toBeLessThanOrEqual(32);
      expect(`icos_test_${slug}`).toMatch(/^icos_test_[a-z0-9_]{1,32}$/);
    }
  });

  it("TWO TASKS WITH THE SAME TITLE are still distinct work", () => {
    const one = workspaceSlug(task({ taskId: "task-aaaaaaaa-1", title: "Repair the gate" }));
    const two = workspaceSlug(task({ taskId: "task-aaaaaaaa-2", title: "Repair the gate" }));

    expect(one).not.toBe(two);
  });

  /**
   * IDENTITY IS BUDGETED BEFORE READABILITY. The 32-character bound used to be applied to
   * the finished name, so a long title ate the discriminator and `_a10` could be cut to
   * `_a1` — two different attempts under one name, which is the collision this is about.
   */
  it("NEITHER THE DISCRIMINATOR NOR THE ATTEMPT IS EVER TRUNCATED AWAY", () => {
    const long = task({
      taskId: "task-abc12345",
      title: "Rewrite the entire integration gate and its applier end to end",
    });
    const first = workspaceSlug(long);
    const tenth = workspaceSlug(long, 10);
    const hundredth = workspaceSlug(long, 100);

    expect(new Set([first, tenth, hundredth]).size).toBe(3);
    expect(tenth.endsWith("_a10")).toBe(true);
    expect(hundredth.endsWith("_a100")).toBe(true);
    /* The attempts of one task differ ONLY by that suffix: same task, same discriminator. */
    expect(tenth.slice(0, -4)).toBe(hundredth.slice(0, -5));
    for (const slug of [first, tenth, hundredth]) {
      expect(slug).toMatch(/^[a-z0-9][a-z0-9_]*$/);
      expect(slug.length).toBeLessThanOrEqual(32);
    }
  });

  it("A TITLE THAT SLUGIFIES TO NOTHING still yields a valid slug", () => {
    /* `!!!` would otherwise produce an empty or leading-underscore name git refuses. */
    const slug = workspaceSlug(task({ title: "!!!", taskId: "task-zz99" }));
    expect(slug).toMatch(/^[a-z0-9][a-z0-9_]*$/);
    expect(slug.startsWith("task_")).toBe(true);
  });
});

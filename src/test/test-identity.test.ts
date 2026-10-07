import { describe, expect, it } from "vitest";

import { idSchema } from "@/core/contracts/common";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";

import { identities, sequentialIdentities, testIdentity, testRunId } from "./test-identity";

/**
 * The helper has one job: make a test's identities unique in a namespace it does not own,
 * without making its assertions non-deterministic. Both halves are tested, because
 * getting either one wrong reintroduces the failure it exists to prevent — a collision,
 * or a flaky assertion.
 */
describe("test identity", () => {
  it("namespaces by run and by case", () => {
    const a = testIdentity("d36", "two-task-dag");
    const b = testIdentity("d36", "correction-dag");

    expect(a.task("a")).not.toBe(b.task("a"));
    expect(a.task("a")).toContain(testRunId());
    expect(a.task("a")).toContain("two-task-dag");
  });

  it("is DETERMINISTIC within one identity, so assertions stay exact", () => {
    const ids = testIdentity("d36", "case-1");

    expect(ids.task("a")).toBe(ids.task("a"));
    expect(ids.mission()).toBe(ids.mission());
    expect(ids.workflow(ids.task("a"), 1)).toBe(ids.workflow(ids.task("a"), 1));
  });

  it("keeps task, mission task and mission ids distinct from one another", () => {
    const ids = testIdentity("d36", "case-1");
    const all = new Set([ids.task("a"), ids.missionTask("a"), ids.mission()]);

    expect(all.size).toBe(3);
  });

  it("separates the business names a case asks for", () => {
    const ids = testIdentity("d36", "case-1");

    expect(ids.task("a")).not.toBe(ids.task("b"));
  });

  it("produces ids ICOS itself accepts", () => {
    const ids = testIdentity("DEFECT 36", "A cancelled: B is never admitted");

    for (const value of [ids.task("a"), ids.missionTask("a"), ids.mission(), ids.label("q")]) {
      expect(idSchema.safeParse(value).success).toBe(true);
      /* Also a safe path segment: test workers write `src/<taskId>/…` in their worktree. */
      expect(value).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it("leaves room inside Temporal's 255-character workflow id limit", () => {
    const ids = testIdentity(
      "a-very-long-file-label-that-someone-will-eventually-write",
      "and an equally long case label describing the whole scenario in prose",
    );

    expect(ids.workflow(ids.task("some-task-name"), 12).length).toBeLessThan(200);
  });

  it("derives workflow ids from the PRODUCTION helper, never its own shape", () => {
    /*
     * Load-bearing: a test that invented its own `icos-task-…` spelling could pass while
     * production used another, which is precisely the kind of divergence that let an
     * entire family of tests agree with each other and with nothing real.
     */
    const ids = testIdentity("d36", "case-1");
    const taskId = ids.task("a");

    expect(ids.workflow(taskId, 1)).toBe(workflowIdForAttempt(taskId, 1));
    expect(ids.workflow(taskId, 2)).toBe(workflowIdForAttempt(taskId, 2));
    /* And the attempt really is part of the identity. */
    expect(ids.workflow(taskId, 1)).not.toBe(ids.workflow(taskId, 2));
  });

  it("gives a distinct namespace to every case of a file", () => {
    const file = identities("d36");
    const seen = new Set(["a", "b", "c", "d"].map((label) => file.forCase(label).task("subject")));

    expect(seen.size).toBe(4);
  });

  it("gives a distinct namespace to every case of a sequential suite", () => {
    const suite = sequentialIdentities("qc");
    const seen = new Set([suite.next(), suite.next(), suite.next()].map((ids) => ids.task("a")));

    expect(seen.size).toBe(3);
  });

  it("does not collide across many cases of the same file", () => {
    /* TEMPORAL_GLOBAL_COLLISIONS=0 is the property; this is its cheap mechanical check. */
    const file = identities("stress");
    const workflows = new Set<string>();
    for (let c = 0; c < 200; c += 1) {
      const ids = file.forCase(`case-${c}`);
      for (const name of ["a", "b"]) {
        for (const attempt of [1, 2, 3]) {
          workflows.add(ids.workflow(ids.task(name), attempt));
        }
      }
    }

    expect(workflows.size).toBe(200 * 2 * 3);
  });
});

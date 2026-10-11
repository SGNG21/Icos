import { describe, expect, it } from "vitest";

import { ExecutionScopeMismatchError } from "@/core/execution/execution-scope";

import { ExecutionScopeReader } from "./execution-scope-reader";

const goalWith = (metadata: Record<string, string>) => ({
  goal: { metadata } as never,
  preview: {} as never,
});

function reader(opts: {
  goals: Record<string, Record<string, string>>;
  missions: Record<string, string | undefined>;
  tasks?: Record<string, { goalId?: string; missionId?: string }>;
}) {
  return new ExecutionScopeReader({
    goals: {
      getById: async (id) => (opts.goals[id] ? goalWith(opts.goals[id]) : null),
    },
    missions: {
      findById: async (id) => (id in opts.missions ? { id, goalId: opts.missions[id] } : null),
    },
    tasks: opts.tasks
      ? { getById: async (id) => (opts.tasks![id] ? { id, ...opts.tasks![id] } : null) }
      : undefined,
  });
}

describe("ExecutionScopeReader — the goal is the one source", () => {
  it("a mission's scope is its goal's", async () => {
    const r = reader({ goals: { g1: { clientId: "lds-renov" } }, missions: { m1: "g1" } });
    expect(await r.forMission("m1")).toMatchObject({
      clientId: "lds-renov",
      goalId: "g1",
      missionId: "m1",
    });
    expect(await r.forMission("missing")).toBeNull();
  });

  it("a generic mission with no goal is unscoped", async () => {
    const r = reader({ goals: {}, missions: { m1: undefined } });
    expect(await r.forMission("m1")).toMatchObject({ clientId: null, allowedDataScope: "tenant" });
  });

  it("FAIL_CLOSED: a goal that cannot be read is an unknown scope, refused — not unscoped", async () => {
    const r = reader({ goals: {}, missions: { m1: "gone" } });
    await expect(r.forMission("m1")).rejects.toBeInstanceOf(ExecutionScopeMismatchError);
  });

  it("a task inherits its mission's goal scope", async () => {
    const r = reader({
      goals: { g1: { clientId: "lds-renov", projectId: "lds-seo" } },
      missions: { m1: "g1" },
      tasks: { t1: { goalId: "g1", missionId: "m1" } },
    });
    expect(await r.forTask("m1", "t1")).toMatchObject({
      clientId: "lds-renov",
      projectId: "lds-seo",
      taskId: "t1",
    });
  });

  it("FAIL_CLOSED: a task whose goal declares ANOTHER client is never presented under either", async () => {
    const r = reader({
      goals: { g1: { clientId: "lds-renov" }, g2: { clientId: "editions-du-mecene" } },
      missions: { m1: "g1" },
      tasks: { t1: { goalId: "g2", missionId: "m1" } },
    });
    await expect(r.forTask("m1", "t1")).rejects.toThrow("EXECUTION_SCOPE_MISMATCH:goalId");
  });

  it("FAIL_CLOSED: a task of another mission, or claiming a goal its mission lacks, is refused", async () => {
    const other = reader({
      goals: { g1: { clientId: "lds-renov" } },
      missions: { m1: "g1" },
      tasks: { t1: { goalId: "g1", missionId: "m2" } },
    });
    await expect(other.forTask("m1", "t1")).rejects.toThrow("EXECUTION_SCOPE_MISMATCH:missionId");
    const orphan = reader({
      goals: { g1: { clientId: "lds-renov" } },
      missions: { m1: undefined },
      tasks: { t1: { goalId: "g1", missionId: "m1" } },
    });
    await expect(orphan.forTask("m1", "t1")).rejects.toThrow("EXECUTION_SCOPE_MISMATCH:goalId");
  });

  it("two goals declaring the SAME scope are tolerated (lineage, not a client change)", async () => {
    const r = reader({
      goals: { g1: { clientId: "lds-renov" }, g2: { clientId: "lds-renov" } },
      missions: { m1: "g1" },
      tasks: { t1: { goalId: "g2", missionId: "m1" } },
    });
    expect(await r.forTask("m1", "t1")).toMatchObject({ clientId: "lds-renov", goalId: "g1" });
  });
});

import { describe, expect, it } from "vitest";

import type { AgentScope } from "@/server/repositories/ports";

import { isMissionInScope } from "./mission-scope";

const restricted: AgentScope = { kind: "linked", agentIds: new Set(["agent-a"]) };
const global: AgentScope = { kind: "global" };

/** Canonical tasks by id → assignee (null = unassigned); same rule as `getByIdForScope`. */
function deps(missionTasks: string[], canonical: Record<string, string | null>) {
  return {
    mission: { listTasks: async () => missionTasks.map((taskId) => ({ taskId })) } as never,
    tasks: {
      getByIdForScope: async (id: string, scope: AgentScope) => {
        if (!(id in canonical)) return null;
        if (scope.kind === "global") return { id };
        const assignee = canonical[id];
        return assignee === null || scope.agentIds.has(assignee) ? { id } : null;
      },
    } as never,
  };
}

describe("isMissionInScope", () => {
  it("restricted + mission without any task: denied (fail closed)", async () => {
    expect(await isMissionInScope(deps([], {}), "m", restricted)).toBe(false);
  });

  it("restricted + mission without any task, tasks preloaded by the list view: denied", async () => {
    expect(await isMissionInScope(deps(["t1"], { t1: "agent-a" }), "m", restricted, [])).toBe(
      false,
    );
  });

  it("restricted + no linked agent + mission without any task: denied", async () => {
    const none: AgentScope = { kind: "linked", agentIds: new Set() };
    expect(await isMissionInScope(deps([], {}), "m", none)).toBe(false);
  });

  it("restricted + task in scope: allowed", async () => {
    expect(await isMissionInScope(deps(["t1"], { t1: "agent-a" }), "m", restricted)).toBe(true);
  });

  it("restricted + unassigned task: allowed (unassigned work is reachable)", async () => {
    expect(await isMissionInScope(deps(["t1"], { t1: null }), "m", restricted)).toBe(true);
  });

  it("restricted + only out-of-scope tasks: denied", async () => {
    expect(
      await isMissionInScope(deps(["t1", "t2"], { t1: "agent-b", t2: "agent-c" }), "m", restricted),
    ).toBe(false);
  });

  it("restricted + in-scope and out-of-scope tasks: denied", async () => {
    expect(
      await isMissionInScope(deps(["t1", "t2"], { t1: "agent-a", t2: "agent-b" }), "m", restricted),
    ).toBe(false);
  });

  it("restricted + dangling canonical task: denied", async () => {
    expect(await isMissionInScope(deps(["t1"], {}), "m", restricted)).toBe(false);
  });

  it("global + mission without any task: allowed (current behaviour preserved)", async () => {
    expect(await isMissionInScope(deps([], {}), "m", global)).toBe(true);
  });

  it("global + out-of-scope tasks: allowed (current behaviour preserved)", async () => {
    expect(await isMissionInScope(deps(["t1"], { t1: "agent-b" }), "m", global)).toBe(true);
  });
});

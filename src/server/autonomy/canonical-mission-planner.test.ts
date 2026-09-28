import { describe, expect, it, vi } from "vitest";

import {
  CanonicalAutonomousMissionPlanner,
  plannerError,
  type PlannerCompletionProvider,
} from "./canonical-mission-planner";

const PLAN = JSON.stringify({
  version: 1,
  tasks: [{ key: "a", title: "A", dependsOn: [], riskClass: "reversible", allowedFileScope: ["docs/"] }],
});

const input = {
  mission: { id: "m1", title: "t", objective: "o", status: "running" },
  tasks: [],
  reason: "initial",
} as unknown as Parameters<CanonicalAutonomousMissionPlanner["plan"]>[0];

const provider = (complete: PlannerCompletionProvider["complete"]): PlannerCompletionProvider => ({
  name: "stub",
  complete,
});

const plan = (p: PlannerCompletionProvider) =>
  new CanonicalAutonomousMissionPlanner({ provider: p, timeoutMs: 1000 }).plan(input);

describe("CanonicalAutonomousMissionPlanner — bounded retry on a SHAPE failure", () => {
  it("RETRIES a malformed answer: a real model fails a strict schema some of the time", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce("Here is the plan, boss.")
      .mockResolvedValueOnce(JSON.stringify({ version: 1, tasks: [{ key: "a", nope: true }] }))
      .mockResolvedValueOnce(PLAN);

    await expect(plan(provider(complete))).resolves.toMatchObject({ version: 1 });
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("IS BOUNDED: it gives up rather than asking for ever", async () => {
    const complete = vi.fn().mockResolvedValue("still not json");

    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_INVALID_OUTPUT");
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a timeout, an abort or a provider failure — asking again cannot help", async () => {
    for (const error of [
      plannerError("TIMEOUT"),
      plannerError("ABORTED"),
      plannerError("PROVIDER_FAILURE"),
    ]) {
      const complete = vi.fn().mockRejectedValue(error);
      await expect(plan(provider(complete))).rejects.toThrow(error.message);
      expect(complete).toHaveBeenCalledTimes(1);
    }
  });

  it("does NOT retry a schema-valid plan that is not a valid DAG: the model was heard correctly", async () => {
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({ version: 1, tasks: [{ key: "a", title: "A", dependsOn: ["ghost"] }] }),
    );

    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_INVALID_PLAN");
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

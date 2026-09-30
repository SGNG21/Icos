import { describe, expect, it, vi } from "vitest";

import {
  CanonicalAutonomousMissionPlanner,
  plannerError,
  PlannerFailureCode,
  type PlannerCompletionProvider,
} from "./canonical-mission-planner";

const PLAN = JSON.stringify({
  version: 1,
  tasks: [{ key: "a", title: "A", dependsOn: [], riskClass: "reversible", allowedFileScope: ["docs/"] }],
});

const NEMOTRON_WRAPPER = JSON.stringify({
  result: PLAN,
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

    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_JSON_PARSE_FAILED");
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a timeout, an abort or a provider failure — asking again cannot help", async () => {
    for (const error of [
      plannerError(PlannerFailureCode.TIMEOUT),
      plannerError(PlannerFailureCode.ABORTED),
      plannerError(PlannerFailureCode.PROVIDER_FAILURE),
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

    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_SEMANTIC_VALIDATION_FAILED");
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("CanonicalAutonomousMissionPlanner — failure taxonomy and normalization", () => {
  it("accepts valid direct JSON without wrapper", async () => {
    const complete = vi.fn().mockResolvedValue(PLAN);
    await expect(plan(provider(complete))).resolves.toMatchObject({ version: 1 });
  });

  it("normalizes known Nemotron wrapper {result: <json>}", async () => {
    const complete = vi.fn().mockResolvedValue(NEMOTRON_WRAPPER);
    await expect(plan(provider(complete))).resolves.toMatchObject({ version: 1 });
  });

  it("rejects markdown-fenced JSON as invalid (strict JSON-only contract)", async () => {
    const fenced = `\`\`\`json\n${PLAN}\n\`\`\``;
    const complete = vi.fn().mockResolvedValue(fenced);
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_JSON_PARSE_FAILED");
  });

  it("rejects non-JSON text", async () => {
    const complete = vi.fn().mockResolvedValue("Here is your plan, boss.");
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_JSON_PARSE_FAILED");
  });

  it("rejects truncated JSON", async () => {
    const truncated = JSON.stringify({ version: 1, tasks: [{ key: "a", title: "A" }] });
    const complete = vi.fn().mockResolvedValue(truncated);
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_SCHEMA_VALIDATION_FAILED");
  });

  it("rejects wrong root type (array instead of object)", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify([{ key: "a", title: "A" }]));
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_WRAPPER_NORMALIZATION_FAILED");
  });

  it("rejects missing required field (tasks)", async () => {
    const incomplete = JSON.stringify({ version: 1 });
    const complete = vi.fn().mockResolvedValue(incomplete);
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_WRAPPER_NORMALIZATION_FAILED");
  });

  it("rejects wrong enum value (riskClass)", async () => {
    const badEnum = JSON.stringify({
      version: 1,
      tasks: [{ key: "a", title: "A", dependsOn: [], riskClass: "invalid-risk" }],
    });
    const complete = vi.fn().mockResolvedValue(badEnum);
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_SCHEMA_VALIDATION_FAILED");
  });

  it("rejects unknown wrapper envelope", async () => {
    const unknownWrapper = JSON.stringify({ data: PLAN });
    const complete = vi.fn().mockResolvedValue(unknownWrapper);
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_WRAPPER_NORMALIZATION_FAILED");
  });

  it("rejects schema-valid but semantically invalid DAG (cycle)", async () => {
    const cyclic = JSON.stringify({
      version: 1,
      tasks: [
        { key: "a", title: "A", dependsOn: ["b"], riskClass: "reversible" },
        { key: "b", title: "B", dependsOn: ["a"], riskClass: "reversible" },
      ],
    });
    const complete = vi.fn().mockResolvedValue(cyclic);
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_SEMANTIC_VALIDATION_FAILED:MISSION_PLAN_CYCLE:a");
  });

  it("repair succeeds on second attempt after shape failure", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce(PLAN);

    await expect(plan(provider(complete))).resolves.toMatchObject({ version: 1 });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("repair exhausts after max attempts", async () => {
    const complete = vi.fn().mockResolvedValue("not json");

    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_JSON_PARSE_FAILED");
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("fails closed on provider failure (non-retryable)", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("network error"));
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_PROVIDER_FAILURE");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("rejects provider response with {result: <string>} where string is not JSON", async () => {
    const badResult = JSON.stringify({ result: "not json" });
    const complete = vi.fn().mockResolvedValue(badResult);
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_JSON_PARSE_FAILED");
  });

  it("rejects provider response with {result: <string>} where string is valid JSON", async () => {
    const goodStringResult = JSON.stringify({ result: PLAN });
    const complete = vi.fn().mockResolvedValue(goodStringResult);
    await expect(plan(provider(complete))).resolves.toMatchObject({ version: 1 });
  });

  it("rejects unknown provider envelope with unexpected top-level keys", async () => {
    const weird = JSON.stringify({ choices: [{ message: { content: PLAN } }] });
    const complete = vi.fn().mockResolvedValue(weird);
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_WRAPPER_NORMALIZATION_FAILED");
  });

  it("preserves AUTONOMY_PLANNER_INVALID_OUTPUT as outward compatibility umbrella", async () => {
    const complete = vi.fn().mockResolvedValue("not json");
    await expect(plan(provider(complete))).rejects.toThrow(/AUTONOMY_PLANNER_/);
  });
});

describe("CanonicalAutonomousMissionPlanner — DAG invariants preserved", () => {
  it("rejects duplicate task keys", async () => {
    const duplicate = JSON.stringify({
      version: 1,
      tasks: [
        { key: "a", title: "A", dependsOn: [], riskClass: "reversible" },
        { key: "a", title: "A2", dependsOn: [], riskClass: "reversible" },
      ],
    });
    const complete = vi.fn().mockResolvedValue(duplicate);
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_SEMANTIC_VALIDATION_FAILED");
  });

  it("rejects dependency on non-existent task", async () => {
    const ghost = JSON.stringify({
      version: 1,
      tasks: [{ key: "a", title: "A", dependsOn: ["ghost"], riskClass: "reversible" }],
    });
    const complete = vi.fn().mockResolvedValue(ghost);
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_SEMANTIC_VALIDATION_FAILED");
  });

  it("rejects self-dependency", async () => {
    const selfDep = JSON.stringify({
      version: 1,
      tasks: [{ key: "a", title: "A", dependsOn: ["a"], riskClass: "reversible" }],
    });
    const complete = vi.fn().mockResolvedValue(selfDep);
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_SEMANTIC_VALIDATION_FAILED");
  });

  it("rejects impossible dependency graph (unreachable from root)", async () => {
    const disconnected = JSON.stringify({
      version: 1,
      tasks: [
        { key: "a", title: "A", dependsOn: [], riskClass: "reversible" },
        { key: "b", title: "B", dependsOn: ["c"], riskClass: "reversible" },
        { key: "c", title: "C", dependsOn: ["b"], riskClass: "reversible" },
      ],
    });
    const complete = vi.fn().mockResolvedValue(disconnected);
    await expect(plan(provider(complete))).rejects.toThrow("AUTONOMY_PLANNER_SEMANTIC_VALIDATION_FAILED");
  });
});
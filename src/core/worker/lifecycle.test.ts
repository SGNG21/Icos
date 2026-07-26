import { describe, expect, it } from "vitest";

import { isWorkerTransitionAllowed, isWorkerTerminal, allowedWorkerTransitionsFrom } from "./lifecycle";
import type { WorkerStatus } from "./contract";

describe("isWorkerTransitionAllowed", () => {
  const allowedCases: Array<[WorkerStatus, WorkerStatus]> = [
    ["CREATED", "RUNNING"],
    ["CREATED", "FAILED"],
    ["CREATED", "CANCELLED"],
    ["RUNNING", "SUCCEEDED"],
    ["RUNNING", "FAILED"],
    ["RUNNING", "TIMED_OUT"],
    ["RUNNING", "CANCELLED"],
    ["RUNNING", "LOST"],
  ];

  for (const [from, to] of allowedCases) {
    it(`allows ${from} → ${to}`, () => {
      expect(isWorkerTransitionAllowed(from, to)).toBe(true);
    });
  }

  const deniedCases: Array<[WorkerStatus, WorkerStatus]> = [
    ["CREATED", "SUCCEEDED"],
    ["CREATED", "TIMED_OUT"],
    ["SUCCEEDED", "RUNNING"],
    ["FAILED", "RUNNING"],
    ["TIMED_OUT", "SUCCEEDED"],
    ["CANCELLED", "CREATED"],
    ["LOST", "RUNNING"],
  ];

  for (const [from, to] of deniedCases) {
    it(`denies ${from} → ${to}`, () => {
      expect(isWorkerTransitionAllowed(from, to)).toBe(false);
    });
  }
});

describe("allowedWorkerTransitionsFrom", () => {
  it("returns valid targets for CREATED", () => {
    const allowed = allowedWorkerTransitionsFrom("CREATED");
    expect(allowed).toContain("RUNNING");
    expect(allowed).not.toContain("SUCCEEDED");
  });

  it("returns empty for terminal states", () => {
    expect(allowedWorkerTransitionsFrom("SUCCEEDED")).toEqual([]);
    expect(allowedWorkerTransitionsFrom("FAILED")).toEqual([]);
    expect(allowedWorkerTransitionsFrom("CANCELLED")).toEqual([]);
  });
});

describe("isWorkerTerminal", () => {
  it("identifies terminal states", () => {
    expect(isWorkerTerminal("SUCCEEDED")).toBe(true);
    expect(isWorkerTerminal("FAILED")).toBe(true);
    expect(isWorkerTerminal("TIMED_OUT")).toBe(true);
    expect(isWorkerTerminal("CANCELLED")).toBe(true);
    expect(isWorkerTerminal("LOST")).toBe(true);
  });

  it("identifies non-terminal states", () => {
    expect(isWorkerTerminal("CREATED")).toBe(false);
    expect(isWorkerTerminal("RUNNING")).toBe(false);
  });
});

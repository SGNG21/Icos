import { describe, expect, it } from "vitest";

import { OBJECTIVE_STATES, UNKNOWN, WORK_CLASSES } from "./contracts";

describe("supervisor contracts", () => {
  it("names the seven doctrine work classes in doctrine order", () => {
    expect(WORK_CLASSES).toEqual([
      "USER",
      "CLIENT",
      "REVENUE",
      "SECURITY",
      "MAINTENANCE",
      "SELF_IMPROVEMENT",
      "RESEARCH",
    ]);
  });

  it("covers every objective state the design declares", () => {
    expect(new Set(OBJECTIVE_STATES)).toEqual(
      new Set([
        "RECEIVED",
        "CONTEXTUALIZED",
        "PLANNING",
        "DELEGATING",
        "EXECUTING",
        "REVIEWING",
        "REPAIRING",
        "DECISION_READY",
        "COMPLETED",
        "BLOCKED",
        "WAITING_FOR_HUMAN",
        "DEGRADED",
        "RECOVERING",
        "CANCELLED",
        "FAILED",
      ]),
    );
  });

  it("exposes one sentinel for absent evidence", () => {
    expect(UNKNOWN).toBe("UNKNOWN");
  });
});

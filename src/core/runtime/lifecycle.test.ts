import { describe, expect, it } from "vitest";

import {
  allowedExecutionTransitionsFrom,
  isExecutionTerminal,
  isExecutionTransitionAllowed,
  type ExecutionStatus,
} from "@/core/runtime";

// ─────────────────────────────────────
// Transition Validation
// ─────────────────────────────────────

describe("D4 — state machine transitions", () => {
  it("D4-01: STARTING → RUNNING est autorisée", () => {
    expect(isExecutionTransitionAllowed("STARTING", "RUNNING")).toBe(true);
  });

  it("D4-02: STARTING → FAILED est autorisée (setup failure)", () => {
    expect(isExecutionTransitionAllowed("STARTING", "FAILED")).toBe(true);
  });

  it("D4-02b: STARTING → CANCELLED est autorisée", () => {
    expect(isExecutionTransitionAllowed("STARTING", "CANCELLED")).toBe(true);
  });

  it("D4-03: RUNNING → SUCCEEDED est autorisée", () => {
    expect(isExecutionTransitionAllowed("RUNNING", "SUCCEEDED")).toBe(true);
  });

  it("RUNNING → FAILED est autorisée", () => {
    expect(isExecutionTransitionAllowed("RUNNING", "FAILED")).toBe(true);
  });

  it("RUNNING → CANCELLED est autorisée", () => {
    expect(isExecutionTransitionAllowed("RUNNING", "CANCELLED")).toBe(true);
  });

  it("RUNNING → TIMED_OUT est autorisée", () => {
    expect(isExecutionTransitionAllowed("RUNNING", "TIMED_OUT")).toBe(true);
  });

  it("RUNNING → LOST est autorisée (worker disparu)", () => {
    expect(isExecutionTransitionAllowed("RUNNING", "LOST")).toBe(true);
  });

  it("D4-04: STARTING → SUCCEEDED est refusée (transition impossible)", () => {
    expect(isExecutionTransitionAllowed("STARTING", "SUCCEEDED")).toBe(false);
  });

  it("D4-04b: STARTING → TIMED_OUT est refusée (timeout pendant setup)", () => {
    expect(isExecutionTransitionAllowed("STARTING", "TIMED_OUT")).toBe(false);
  });

  it("D4-04c: STARTING → LOST est refusée", () => {
    expect(isExecutionTransitionAllowed("STARTING", "LOST")).toBe(false);
  });

  it("FAILED → RUNNING est refusée (terminal → run impossible)", () => {
    expect(isExecutionTransitionAllowed("FAILED", "RUNNING")).toBe(false);
  });

  it("SUCCEEDED → FAILED est refusée (terminal)", () => {
    expect(isExecutionTransitionAllowed("SUCCEEDED", "FAILED")).toBe(false);
  });

  it("CANCELLED → RUNNING est refusée (terminal)", () => {
    expect(isExecutionTransitionAllowed("CANCELLED", "RUNNING")).toBe(false);
  });

  it("TIMED_OUT → RUNNING est refusée (terminal)", () => {
    expect(isExecutionTransitionAllowed("TIMED_OUT", "RUNNING")).toBe(false);
  });

  it("LOST → RUNNING est refusée (terminal)", () => {
    expect(isExecutionTransitionAllowed("LOST", "RUNNING")).toBe(false);
  });
});

// ─────────────────────────────────────
// Terminal State Detection
// ─────────────────────────────────────

describe("D4 — isExecutionTerminal", () => {
  it("SUCCEEDED est terminal", () => {
    expect(isExecutionTerminal("SUCCEEDED")).toBe(true);
  });

  it("FAILED est terminal", () => {
    expect(isExecutionTerminal("FAILED")).toBe(true);
  });

  it("CANCELLED est terminal", () => {
    expect(isExecutionTerminal("CANCELLED")).toBe(true);
  });

  it("TIMED_OUT est terminal", () => {
    expect(isExecutionTerminal("TIMED_OUT")).toBe(true);
  });

  it("LOST est terminal", () => {
    expect(isExecutionTerminal("LOST")).toBe(true);
  });

  it("STARTING n'est pas terminal", () => {
    expect(isExecutionTerminal("STARTING")).toBe(false);
  });

  it("RUNNING n'est pas terminal", () => {
    expect(isExecutionTerminal("RUNNING")).toBe(false);
  });
});

// ─────────────────────────────────────
// Allowed Transitions
// ─────────────────────────────────────

describe("D4 — allowedExecutionTransitionsFrom", () => {
  it("STARTING permet RUNNING, FAILED, CANCELLED", () => {
    const allowed = allowedExecutionTransitionsFrom("STARTING");
    expect(allowed).toEqual(["RUNNING", "FAILED", "CANCELLED"]);
  });

  it("RUNNING permet SUCCEEDED, FAILED, CANCELLED, TIMED_OUT, LOST", () => {
    const allowed = allowedExecutionTransitionsFrom("RUNNING");
    expect(allowed).toEqual(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "LOST"]);
  });

  it("SUCCEEDED n'a aucune transition", () => {
    expect(allowedExecutionTransitionsFrom("SUCCEEDED")).toEqual([]);
  });

  it("FAILED n'a aucune transition", () => {
    expect(allowedExecutionTransitionsFrom("FAILED")).toEqual([]);
  });

  it("CANCELLED n'a aucune transition", () => {
    expect(allowedExecutionTransitionsFrom("CANCELLED")).toEqual([]);
  });

  it("TIMED_OUT n'a aucune transition", () => {
    expect(allowedExecutionTransitionsFrom("TIMED_OUT")).toEqual([]);
  });

  it("LOST n'a aucune transition", () => {
    expect(allowedExecutionTransitionsFrom("LOST")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { isTransitionAllowed, allowedTransitionsFrom, isTerminal, isSuspended } from "./lifecycle";
import type { MissionStatus } from "./contract";

// ─────────────────────────────────────
// Mission status transitions
// ─────────────────────────────────────

describe("isTransitionAllowed", () => {
  const allowedCases: Array<[MissionStatus, MissionStatus]> = [
    ["CREATED", "PLANNING"],
    ["CREATED", "FAILED"],
    ["PLANNING", "PLANNED"],
    ["PLANNING", "FAILED"],
    ["PLANNED", "IN_PROGRESS"],
    ["PLANNED", "CANCELLED"],
    ["IN_PROGRESS", "COMPLETED"],
    ["IN_PROGRESS", "FAILED"],
    ["IN_PROGRESS", "WAITING_FOR_APPROVAL"],
    ["IN_PROGRESS", "BLOCKED_BY_POLICY"],
    ["IN_PROGRESS", "PROVIDER_UNAVAILABLE"],
    ["IN_PROGRESS", "TOOL_FAILED"],
    ["IN_PROGRESS", "SKILL_REVOKED"],
    ["IN_PROGRESS", "STALE_ATTESTATION"],
    ["IN_PROGRESS", "MISSION_RECOVERABLE"],
    ["WAITING_FOR_APPROVAL", "IN_PROGRESS"],
    ["WAITING_FOR_APPROVAL", "CANCELLED"],
    ["BLOCKED_BY_POLICY", "IN_PROGRESS"],
    ["BLOCKED_BY_POLICY", "CANCELLED"],
    ["BLOCKED_BY_POLICY", "FAILED"],
    ["PROVIDER_UNAVAILABLE", "IN_PROGRESS"],
    ["PROVIDER_UNAVAILABLE", "FAILED"],
    ["PROVIDER_UNAVAILABLE", "CANCELLED"],
    ["TOOL_FAILED", "IN_PROGRESS"],
    ["TOOL_FAILED", "FAILED"],
    ["TOOL_FAILED", "CANCELLED"],
    ["SKILL_REVOKED", "FAILED"],
    ["STALE_ATTESTATION", "WAITING_FOR_APPROVAL"],
    ["STALE_ATTESTATION", "FAILED"],
    ["MISSION_RECOVERABLE", "IN_PROGRESS"],
    ["MISSION_RECOVERABLE", "CANCELLED"],
    ["MISSION_RECOVERABLE", "FAILED"],
  ];

  for (const [from, to] of allowedCases) {
    it(`allows ${from} → ${to}`, () => {
      expect(isTransitionAllowed(from, to)).toBe(true);
    });
  }

  const deniedCases: Array<[MissionStatus, MissionStatus]> = [
    ["CREATED", "IN_PROGRESS"],
    ["CREATED", "COMPLETED"],
    ["COMPLETED", "CREATED"],
    ["COMPLETED", "FAILED"],
    ["FAILED", "CREATED"],
    ["CANCELLED", "CREATED"],
    ["PLANNED", "FAILED"],
    ["PLANNING", "IN_PROGRESS"],
    ["IN_PROGRESS", "PLANNING"],
    ["WAITING_FOR_APPROVAL", "FAILED"],
    ["WAITING_FOR_APPROVAL", "PLANNED"],
  ];

  for (const [from, to] of deniedCases) {
    it(`denies ${from} → ${to}`, () => {
      expect(isTransitionAllowed(from, to)).toBe(false);
    });
  }
});

describe("allowedTransitionsFrom", () => {
  it("returns valid targets for CREATED", () => {
    const allowed = allowedTransitionsFrom("CREATED");
    expect(allowed).toContain("PLANNING");
    expect(allowed).toContain("FAILED");
    expect(allowed).not.toContain("COMPLETED");
  });

  it("returns valid targets for IN_PROGRESS", () => {
    const allowed = allowedTransitionsFrom("IN_PROGRESS");
    expect(allowed).toContain("COMPLETED");
    expect(allowed).toContain("FAILED");
    expect(allowed).toContain("WAITING_FOR_APPROVAL");
    expect(allowed).toContain("BLOCKED_BY_POLICY");
    expect(allowed).not.toContain("PLANNING");
  });

  it("returns empty for terminal states", () => {
    expect(allowedTransitionsFrom("COMPLETED")).toEqual([]);
    expect(allowedTransitionsFrom("FAILED")).toEqual([]);
    expect(allowedTransitionsFrom("CANCELLED")).toEqual([]);
  });
});

// ─────────────────────────────────────
// Terminal states
// ─────────────────────────────────────

describe("isTerminal", () => {
  it("identifies terminal states", () => {
    expect(isTerminal("COMPLETED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
    expect(isTerminal("CANCELLED")).toBe(true);
  });

  it("identifies non-terminal states", () => {
    expect(isTerminal("CREATED")).toBe(false);
    expect(isTerminal("PLANNING")).toBe(false);
    expect(isTerminal("PLANNED")).toBe(false);
    expect(isTerminal("IN_PROGRESS")).toBe(false);
    expect(isTerminal("WAITING_FOR_APPROVAL")).toBe(false);
    expect(isTerminal("BLOCKED_BY_POLICY")).toBe(false);
    expect(isTerminal("PROVIDER_UNAVAILABLE")).toBe(false);
    expect(isTerminal("TOOL_FAILED")).toBe(false);
    expect(isTerminal("SKILL_REVOKED")).toBe(false);
    expect(isTerminal("STALE_ATTESTATION")).toBe(false);
    expect(isTerminal("MISSION_RECOVERABLE")).toBe(false);
  });
});

// ─────────────────────────────────────
// Suspended states
// ─────────────────────────────────────

describe("isSuspended", () => {
  it("identifies suspended states", () => {
    expect(isSuspended("WAITING_FOR_APPROVAL")).toBe(true);
    expect(isSuspended("BLOCKED_BY_POLICY")).toBe(true);
    expect(isSuspended("PROVIDER_UNAVAILABLE")).toBe(true);
    expect(isSuspended("TOOL_FAILED")).toBe(true);
    expect(isSuspended("SKILL_REVOKED")).toBe(true);
    expect(isSuspended("STALE_ATTESTATION")).toBe(true);
    expect(isSuspended("MISSION_RECOVERABLE")).toBe(true);
  });

  it("identifies non-suspended states", () => {
    expect(isSuspended("CREATED")).toBe(false);
    expect(isSuspended("PLANNING")).toBe(false);
    expect(isSuspended("PLANNED")).toBe(false);
    expect(isSuspended("IN_PROGRESS")).toBe(false);
    expect(isSuspended("COMPLETED")).toBe(false);
    expect(isSuspended("FAILED")).toBe(false);
    expect(isSuspended("CANCELLED")).toBe(false);
  });
});

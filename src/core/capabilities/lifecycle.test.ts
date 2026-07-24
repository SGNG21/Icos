import { describe, expect, it } from "vitest";

import type { Capability, CapabilityStatus } from "@/core/contracts/capability";

import { isTransitionAllowed, resolveActiveCapability } from "./lifecycle";

function makeCapability(status: CapabilityStatus): Capability {
  return {
    id: "cap-001",
    key: "code.review",
    name: "Code Review",
    category: "code",
    status,
    createdAt: "2026-07-23T08:00:00.000Z",
    updatedAt: "2026-07-23T08:00:00.000Z",
  };
}

describe("isTransitionAllowed", () => {
  const valid: Array<[CapabilityStatus, CapabilityStatus]> = [
    ["proposed", "active"],
    ["active", "deprecated"],
    ["active", "retired"],
    ["deprecated", "active"],
    ["deprecated", "retired"],
  ];

  for (const [from, to] of valid) {
    it(`autorise ${from} → ${to}`, () => {
      expect(isTransitionAllowed(from, to)).toBe(true);
    });
  }

  const invalid: Array<[CapabilityStatus, CapabilityStatus]> = [
    ["proposed", "deprecated"],
    ["proposed", "retired"],
    ["active", "proposed"],
    ["deprecated", "proposed"],
  ];

  for (const [from, to] of invalid) {
    it(`interdit ${from} → ${to}`, () => {
      expect(isTransitionAllowed(from, to)).toBe(false);
    });
  }

  it("interdit toute sortie de retired (état terminal)", () => {
    for (const target of ["proposed", "active", "deprecated"] as const) {
      expect(isTransitionAllowed("retired", target)).toBe(false);
    }
  });
});

describe("resolveActiveCapability", () => {
  it("retourne unknown pour une clé inconnue", async () => {
    const result = await resolveActiveCapability("unknown.key", async () => null);
    expect(result).toEqual({ usable: false, reason: "unknown" });
  });

  const nonActive: CapabilityStatus[] = ["proposed", "deprecated", "retired"];

  for (const status of nonActive) {
    it(`retourne not_active pour une capacité ${status}`, async () => {
      const cap = makeCapability(status);
      const result = await resolveActiveCapability(cap.key, async () => cap);
      expect(result).toEqual({ usable: false, reason: "not_active" });
    });
  }

  it("retourne usable pour une capacité active", async () => {
    const cap = makeCapability("active");
    const result = await resolveActiveCapability(cap.key, async () => cap);
    expect(result).toEqual({ usable: true, capability: cap });
  });
});

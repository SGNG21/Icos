import { describe, expect, it } from "vitest";

import type { ActivationState, TrustState } from "@/core/contracts/skill";

import {
  isTrustTransitionAllowed,
  isActivationTransitionAllowed,
  isStateValid,
  isContentMutable,
  isContentImmutable,
  isAttestationValid,
} from "./lifecycle";

function t(from: TrustState, to: TrustState): [TrustState, TrustState] {
  return [from, to];
}

function a(from: ActivationState, to: ActivationState): [ActivationState, ActivationState] {
  return [from, to];
}

describe("isTrustTransitionAllowed", () => {
  const valid: Array<[TrustState, TrustState]> = [
    t("untrusted", "quarantined"),
    t("quarantined", "reviewed"),
    t("quarantined", "rejected"),
    t("reviewed", "approved"),
    t("reviewed", "rejected"),
    t("approved", "rejected"),
  ];

  for (const [from, to] of valid) {
    it(`autorise ${from} → ${to}`, () => {
      expect(isTrustTransitionAllowed(from, to)).toBe(true);
    });
  }

  const invalid: Array<[TrustState, TrustState]> = [
    t("untrusted", "reviewed"),
    t("untrusted", "approved"),
    t("untrusted", "rejected"),
    t("quarantined", "approved"),
    t("reviewed", "quarantined"),
    t("approved", "reviewed"),
    t("approved", "quarantined"),
  ];

  for (const [from, to] of invalid) {
    it(`interdit ${from} → ${to}`, () => {
      expect(isTrustTransitionAllowed(from, to)).toBe(false);
    });
  }

  it("interdit toute sortie de rejected (état terminal)", () => {
    const targets: TrustState[] = ["untrusted", "quarantined", "reviewed", "approved"];
    for (const target of targets) {
      expect(isTrustTransitionAllowed("rejected", target)).toBe(false);
    }
  });
});

describe("isActivationTransitionAllowed", () => {
  const valid: Array<[ActivationState, ActivationState]> = [
    a("inactive", "active"),
    a("inactive", "revoked"),
    a("active", "suspended"),
    a("active", "inactive"),
    a("active", "revoked"),
    a("suspended", "active"),
    a("suspended", "revoked"),
  ];

  for (const [from, to] of valid) {
    it(`autorise ${from} → ${to}`, () => {
      expect(isActivationTransitionAllowed(from, to)).toBe(true);
    });
  }

  const invalid: Array<[ActivationState, ActivationState]> = [
    a("inactive", "suspended"),
    a("revoked", "active"),
    a("revoked", "inactive"),
    a("revoked", "suspended"),
  ];

  for (const [from, to] of invalid) {
    it(`interdit ${from} → ${to}`, () => {
      expect(isActivationTransitionAllowed(from, to)).toBe(false);
    });
  }

  it("interdit toute sortie de revoked (état terminal)", () => {
    const targets: ActivationState[] = ["inactive", "active", "suspended"];
    for (const target of targets) {
      expect(isActivationTransitionAllowed("revoked", target)).toBe(false);
    }
  });
});

describe("isStateValid — cross-invariants", () => {
  it("CROSS-I-1 : active ⇒ approved", () => {
    expect(isStateValid("approved", "active")).toBe(true);
    expect(isStateValid("untrusted", "active")).toBe(false);
    expect(isStateValid("quarantined", "active")).toBe(false);
    expect(isStateValid("reviewed", "active")).toBe(false);
    expect(isStateValid("rejected", "active")).toBe(false);
  });

  it("CROSS-I-2 : rejected ⇒ revoked", () => {
    expect(isStateValid("rejected", "revoked")).toBe(true);
    expect(isStateValid("rejected", "inactive")).toBe(false);
    expect(isStateValid("rejected", "active")).toBe(false);
    expect(isStateValid("rejected", "suspended")).toBe(false);
  });

  it("accepte les états valides sans croisement", () => {
    expect(isStateValid("approved", "inactive")).toBe(true);
    expect(isStateValid("approved", "suspended")).toBe(true);
    expect(isStateValid("untrusted", "inactive")).toBe(true);
    expect(isStateValid("reviewed", "inactive")).toBe(true);
    expect(isStateValid("quarantined", "inactive")).toBe(true);
    expect(isStateValid("rejected", "revoked")).toBe(true);
  });
});

describe("isContentMutable / isContentImmutable", () => {
  it("définit correctement les états mutables", () => {
    expect(isContentMutable("untrusted")).toBe(true);
    expect(isContentMutable("quarantined")).toBe(true);
    expect(isContentMutable("reviewed")).toBe(true);
  });

  it("définit correctement les états immutables", () => {
    expect(isContentImmutable("approved")).toBe(true);
    expect(isContentImmutable("rejected")).toBe(true);
  });

  it("les états mutables ne sont pas immutables et vice-versa", () => {
    expect(isContentImmutable("untrusted")).toBe(false);
    expect(isContentImmutable("quarantined")).toBe(false);
    expect(isContentImmutable("reviewed")).toBe(false);
    expect(isContentMutable("approved")).toBe(false);
    expect(isContentMutable("rejected")).toBe(false);
  });
});

describe("isAttestationValid — stale attestation", () => {
  it("retourne true si les hash sont identiques", () => {
    expect(isAttestationValid("abc123", "abc123")).toBe(true);
  });

  it("retourne false si les hash sont différents (stale)", () => {
    expect(isAttestationValid("abc123", "def456")).toBe(false);
    expect(isAttestationValid("old_hash", "new_hash")).toBe(false);
  });

  it("est sensible à la casse", () => {
    expect(isAttestationValid("ABC", "abc")).toBe(false);
  });
});

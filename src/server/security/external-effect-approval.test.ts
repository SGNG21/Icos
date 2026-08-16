import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXTERNAL_EFFECT_SCOPE_PUSH_PR,
  branchMatches,
  evaluateExternalEffectApproval,
  loadExternalEffectApproval,
} from "./external-effect-approval";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const EXPECTED = {
  scope: EXTERNAL_EFFECT_SCOPE_PUSH_PR,
  branch: "integration/dag-1234",
};

function validApproval(overrides?: Record<string, unknown>) {
  return {
    approved: true,
    scope: EXTERNAL_EFFECT_SCOPE_PUSH_PR,
    branch: "integration/dag-1234",
    approvedBy: "owner@icos",
    approvedAt: "2026-08-15T10:00:00.000Z",
    expiresAt: "2026-08-15T18:00:00.000Z",
    ...overrides,
  };
}

// ─────────────────────────────────────
// Évaluation pure — cas positif unique
// ─────────────────────────────────────

describe("evaluateExternalEffectApproval — grant", () => {
  it("grants a valid, exact-branch, unexpired human approval", () => {
    const decision = evaluateExternalEffectApproval(validApproval(), EXPECTED, NOW);
    expect(decision.granted).toBe(true);
  });

  it("grants an explicit prefix pattern covering the branch", () => {
    const decision = evaluateExternalEffectApproval(
      validApproval({ branch: "integration/*" }),
      EXPECTED,
      NOW,
    );
    expect(decision.granted).toBe(true);
  });
});

// ─────────────────────────────────────
// NÉGATIF (F2) : missing / denied / malformed / stale / mismatch
// ─────────────────────────────────────

describe("evaluateExternalEffectApproval — fail-closed", () => {
  it("blocks when approval is missing (null)", () => {
    const decision = evaluateExternalEffectApproval(null, EXPECTED, NOW);
    expect(decision).toMatchObject({ granted: false, code: "missing" });
  });

  it("blocks when approval is missing (undefined)", () => {
    const decision = evaluateExternalEffectApproval(undefined, EXPECTED, NOW);
    expect(decision).toMatchObject({ granted: false, code: "missing" });
  });

  it("blocks when approval is explicitly denied (approved: false)", () => {
    const decision = evaluateExternalEffectApproval(
      validApproval({ approved: false }),
      EXPECTED,
      NOW,
    );
    expect(decision).toMatchObject({ granted: false, code: "denied" });
  });

  it("blocks a malformed approval — approved is a string, not a boolean", () => {
    const decision = evaluateExternalEffectApproval(
      validApproval({ approved: "true" }),
      EXPECTED,
      NOW,
    );
    expect(decision).toMatchObject({ granted: false, code: "malformed" });
  });

  it("blocks a malformed approval — required fields absent", () => {
    const decision = evaluateExternalEffectApproval({ approved: true }, EXPECTED, NOW);
    expect(decision).toMatchObject({ granted: false, code: "malformed" });
  });

  it("blocks a malformed approval — invalid expiry timestamp", () => {
    const decision = evaluateExternalEffectApproval(
      validApproval({ expiresAt: "pas-une-date" }),
      EXPECTED,
      NOW,
    );
    expect(decision).toMatchObject({ granted: false, code: "malformed" });
  });

  it("blocks a stale approval (expired before now)", () => {
    const decision = evaluateExternalEffectApproval(
      validApproval({ expiresAt: "2026-08-15T11:59:59.000Z" }),
      EXPECTED,
      NOW,
    );
    expect(decision).toMatchObject({ granted: false, code: "stale" });
  });

  it("blocks an approval expiring exactly now (boundary is exclusive)", () => {
    const decision = evaluateExternalEffectApproval(
      validApproval({ expiresAt: NOW.toISOString() }),
      EXPECTED,
      NOW,
    );
    expect(decision).toMatchObject({ granted: false, code: "stale" });
  });

  it("blocks a scope mismatch", () => {
    const decision = evaluateExternalEffectApproval(
      validApproval({ scope: "deploy-production" }),
      EXPECTED,
      NOW,
    );
    expect(decision).toMatchObject({ granted: false, code: "scope_mismatch" });
  });

  it("blocks a branch mismatch (different branch)", () => {
    const decision = evaluateExternalEffectApproval(
      validApproval({ branch: "main" }),
      EXPECTED,
      NOW,
    );
    expect(decision).toMatchObject({ granted: false, code: "branch_mismatch" });
  });

  it("blocks a prefix pattern that does not cover the branch", () => {
    const decision = evaluateExternalEffectApproval(
      validApproval({ branch: "release/*" }),
      EXPECTED,
      NOW,
    );
    expect(decision).toMatchObject({ granted: false, code: "branch_mismatch" });
  });
});

// ─────────────────────────────────────
// branchMatches — pas de joker implicite
// ─────────────────────────────────────

describe("branchMatches", () => {
  it("matches exact branch", () => {
    expect(branchMatches("integration/dag-1", "integration/dag-1")).toBe(true);
  });

  it("matches explicit prefix pattern", () => {
    expect(branchMatches("integration/*", "integration/dag-1")).toBe(true);
  });

  it("rejects the bare wildcard '*' (no implicit universal wildcard)", () => {
    expect(branchMatches("*", "integration/dag-1")).toBe(false);
  });

  it("rejects '/*' (empty namespace)", () => {
    expect(branchMatches("/*", "anything")).toBe(false);
  });

  it("rejects a pattern matching only its own prefix (no branch segment)", () => {
    expect(branchMatches("integration/*", "integration/")).toBe(false);
  });

  it("rejects non-prefix partial matches", () => {
    expect(branchMatches("integration/*", "integration-evil/dag-1")).toBe(false);
  });
});

// ─────────────────────────────────────
// Chargement disque — missing / unavailable / malformed
// ─────────────────────────────────────

describe("loadExternalEffectApproval", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "icos-approval-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("blocks with 'missing' when the file does not exist", async () => {
    const decision = await loadExternalEffectApproval(path.join(dir, "absent.json"), EXPECTED, NOW);
    expect(decision).toMatchObject({ granted: false, code: "missing" });
  });

  it("blocks with 'malformed' when the file is not JSON", async () => {
    const file = path.join(dir, "broken.json");
    await writeFile(file, "{ pas du json", "utf-8");
    const decision = await loadExternalEffectApproval(file, EXPECTED, NOW);
    expect(decision).toMatchObject({ granted: false, code: "malformed" });
  });

  it("blocks with 'unavailable' when the file cannot be read", async () => {
    const file = path.join(dir, "unreadable.json");
    await writeFile(file, JSON.stringify(validApproval()), "utf-8");
    await chmod(file, 0o000);
    try {
      const decision = await loadExternalEffectApproval(file, EXPECTED, NOW);
      // Sous root (CI), chmod 000 peut rester lisible — dans ce cas le
      // grant est légitime ; sinon le refus doit être 'unavailable'.
      if (!decision.granted) {
        expect(decision.code).toBe("unavailable");
      }
    } finally {
      await chmod(file, 0o600);
    }
  });

  it("grants from a valid approval artifact on disk", async () => {
    const file = path.join(dir, "approval.json");
    await writeFile(file, JSON.stringify(validApproval()), "utf-8");
    const decision = await loadExternalEffectApproval(file, EXPECTED, NOW);
    expect(decision.granted).toBe(true);
  });
});

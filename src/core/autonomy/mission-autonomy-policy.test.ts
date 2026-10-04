import { describe, expect, it } from "vitest";

import { classifyMissionAutonomy } from "./mission-autonomy-policy";

/**
 * The asker must never be able to grant itself permission.
 *
 * `mission.launch` used to be unconditionally APPROVAL_REQUIRED because the only risk
 * signal came from the model. These pin the replacement: the verdict comes from the
 * capabilities a goal DECLARES, checked against a fixed allowlist, and an assertion about
 * risk may only ever tighten the result.
 */
const classOf = (input: Parameters<typeof classifyMissionAutonomy>[0]) =>
  classifyMissionAutonomy(input).policyClass;

describe("mission autonomy policy", () => {
  it("starts verifiably read-only internal work on its own", () => {
    expect(classOf({ capabilities: ["research", "planning"] })).toBe("AUTO_ALLOWED");
    expect(classOf({ capabilities: ["independent_review"] })).toBe("AUTO_ALLOWED");
  });

  it("starts isolated-worktree coding on its own", () => {
    /* Safe because the writer is confined and its branch reaches the repo through review. */
    expect(classOf({ capabilities: ["code_write"] })).toBe("AUTO_ALLOWED");
  });

  it("always asks before an external, destructive or irreversible effect", () => {
    for (const capability of [
      "deploy",
      "merge",
      "payment",
      "purchase",
      "customer_communication",
      "account_change",
      "data_delete",
      "production_change",
    ]) {
      expect(classOf({ capabilities: [capability] }), capability).toBe("APPROVAL_REQUIRED");
    }
  });

  it("one gated capability contaminates an otherwise safe goal", () => {
    expect(classOf({ capabilities: ["research", "planning", "deploy"] })).toBe(
      "APPROVAL_REQUIRED",
    );
  });

  it("refuses to treat an unclassified goal as harmless", () => {
    /* Declaring nothing is not declaring safety. */
    expect(classOf({ capabilities: [] })).toBe("APPROVAL_REQUIRED");
    expect(classOf({ capabilities: ["  "] })).toBe("APPROVAL_REQUIRED");
  });

  it("sends a capability nobody classified to deployment policy, not to autonomy", () => {
    expect(classOf({ capabilities: ["research", "quantum_teleport"] })).toBe("POLICY_GATED");
  });

  describe("the model cannot grant itself authority", () => {
    it("a claim of harmlessness buys nothing", () => {
      /* `read_only` on a gated capability must not unlock it. */
      expect(classOf({ capabilities: ["deploy"], assertedRisk: "read_only" })).toBe(
        "APPROVAL_REQUIRED",
      );
      expect(classOf({ capabilities: ["quantum_teleport"], assertedRisk: "read_only" })).toBe(
        "POLICY_GATED",
      );
      expect(classOf({ capabilities: [], assertedRisk: "read_only" })).toBe("APPROVAL_REQUIRED");
    });

    it("a claim of danger is believed, because it only tightens", () => {
      expect(classOf({ capabilities: ["research"], assertedRisk: "sensitive" })).toBe(
        "APPROVAL_REQUIRED",
      );
    });

    it("the owner may always demand to be asked", () => {
      expect(classOf({ capabilities: ["research"], humanApprovalPolicy: "always" })).toBe(
        "APPROVAL_REQUIRED",
      );
    });
  });

  it("is deterministic: the same goal always gets the same verdict", () => {
    const input = { capabilities: ["research", "planning"], assertedRisk: "reversible" } as const;
    const verdicts = Array.from({ length: 5 }, () => classifyMissionAutonomy(input));
    expect(new Set(verdicts.map((v) => v.policyClass)).size).toBe(1);
    expect(new Set(verdicts.map((v) => v.reason)).size).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import {
  ACTION_RISK_CLASSES,
  CAPABILITY_RISK_TABLE,
  POLICY_VERSION,
  capabilityRiskClass,
  classifyTaskRisk,
  decideActionAutonomy,
  decideTaskAutonomy,
  mostSevereClass,
  type ActionAutonomyContext,
  type ActionAutonomyDecision,
  type ActionRiskClass,
} from "./execution-risk-policy";
import {
  APPROVAL_REQUIRED_CAPABILITIES,
  AUTO_ALLOWED_CAPABILITIES,
  classifyMissionAutonomy,
} from "./mission-autonomy-policy";
import { PROTECTED_DOMAINS } from "./self-modification-policy";

const decide = (c: ActionRiskClass, ctx?: ActionAutonomyContext) =>
  decideActionAutonomy(c, ctx).decision;

describe("decideActionAutonomy — the exhaustive table", () => {
  /* [class, context, expected] — every class, both sides of every condition. */
  const table: Array<[ActionRiskClass, ActionAutonomyContext, ActionAutonomyDecision]> = [
    ["READ_ONLY", {}, "AUTONOMOUS"],
    ["READ_ONLY", { isolatedWorkspace: false }, "AUTONOMOUS"],
    ["REVERSIBLE_ISOLATED", { isolatedWorkspace: true }, "AUTONOMOUS"],
    ["REVERSIBLE_ISOLATED", { isolatedWorkspace: false }, "APPROVAL_REQUIRED"],
    ["REVERSIBLE_ISOLATED", {}, "APPROVAL_REQUIRED"],
    ["REVERSIBLE_EXTERNAL", { externalPermitted: true, rollbackAvailable: true }, "AUTONOMOUS"],
    ["REVERSIBLE_EXTERNAL", { externalPermitted: true, rollbackAvailable: false }, "APPROVAL_REQUIRED"],
    ["REVERSIBLE_EXTERNAL", { externalPermitted: false, rollbackAvailable: true }, "APPROVAL_REQUIRED"],
    ["REVERSIBLE_EXTERNAL", {}, "APPROVAL_REQUIRED"],
    ["PRIVILEGED", {}, "GOVERNED"],
    ["PRIVILEGED", { isolatedWorkspace: true, externalPermitted: true }, "GOVERNED"],
    ["SECRET_SENSITIVE", {}, "APPROVAL_REQUIRED"],
    [
      "SECRET_SENSITIVE",
      { requestedSecretScopes: ["github:read"], preAuthorizedSecretScopes: ["github:read"] },
      "GOVERNED",
    ],
    [
      "SECRET_SENSITIVE",
      { requestedSecretScopes: ["github:write"], preAuthorizedSecretScopes: ["github:read"] },
      "APPROVAL_REQUIRED",
    ],
    [
      /* A wildcard is not a NARROW pre-authorization. */
      "SECRET_SENSITIVE",
      { requestedSecretScopes: ["github:read"], preAuthorizedSecretScopes: ["*", "github:read"] },
      "APPROVAL_REQUIRED",
    ],
    [
      /* Nothing requested is not something authorized. */
      "SECRET_SENSITIVE",
      { requestedSecretScopes: [], preAuthorizedSecretScopes: ["github:read"] },
      "APPROVAL_REQUIRED",
    ],
    ["DESTRUCTIVE", {}, "APPROVAL_REQUIRED"],
    ["DESTRUCTIVE", { isolatedWorkspace: true, externalPermitted: true, rollbackAvailable: true }, "APPROVAL_REQUIRED"],
    ["FINANCIAL", {}, "APPROVAL_REQUIRED"],
    ["FINANCIAL", { externalPermitted: true, rollbackAvailable: true }, "APPROVAL_REQUIRED"],
    ["IRREVERSIBLE", {}, "APPROVAL_REQUIRED"],
    ["IRREVERSIBLE", { externalPermitted: true, rollbackAvailable: true }, "APPROVAL_REQUIRED"],
  ];

  for (const [riskClass, ctx, expected] of table) {
    it(`${riskClass} ${JSON.stringify(ctx)} → ${expected}`, () => {
      expect(decide(riskClass, ctx)).toBe(expected);
    });
  }

  it("covers all eight classes", () => {
    expect(new Set(table.map(([c]) => c))).toEqual(new Set(ACTION_RISK_CLASSES));
    expect(ACTION_RISK_CLASSES).toHaveLength(8);
  });

  it("owner policy `always` makes every class APPROVAL_REQUIRED, whatever the context", () => {
    const permissive: ActionAutonomyContext = {
      isolatedWorkspace: true,
      externalPermitted: true,
      rollbackAvailable: true,
      requestedSecretScopes: ["a"],
      preAuthorizedSecretScopes: ["a"],
      ownerPolicy: "always",
    };
    for (const c of ACTION_RISK_CLASSES) expect(decide(c, permissive), c).toBe("APPROVAL_REQUIRED");
  });

  it("owner policy `never` relaxes nothing", () => {
    for (const c of ACTION_RISK_CLASSES) {
      expect(decide(c, { ownerPolicy: "never" }), c).toBe(decide(c, {}));
    }
  });

  it("a value outside the union fails closed", () => {
    expect(decide("TELEPORT" as ActionRiskClass)).toBe("APPROVAL_REQUIRED");
  });
});

describe("the capability table", () => {
  it("maps the seeded capabilities as specified", () => {
    const expected: Record<string, ActionRiskClass> = {
      research: "READ_ONLY",
      planning: "READ_ONLY",
      architecture_design: "READ_ONLY",
      synthesis: "READ_ONLY",
      independent_review: "READ_ONLY",
      seo_audit: "READ_ONLY",
      sales_strategy: "READ_ONLY",
      code_write: "REVERSIBLE_ISOLATED",
      deploy: "IRREVERSIBLE",
      production_change: "IRREVERSIBLE",
      merge: "IRREVERSIBLE",
      customer_communication: "IRREVERSIBLE",
      data_delete: "DESTRUCTIVE",
      payment: "FINANCIAL",
      purchase: "FINANCIAL",
      account_change: "PRIVILEGED",
      review: "READ_ONLY",
      audit: "READ_ONLY",
      analysis: "READ_ONLY",
      "deep-research": "READ_ONLY",
      "code-generation": "REVERSIBLE_ISOLATED",
      code_editing: "REVERSIBLE_ISOLATED",
      credential_access: "SECRET_SENSITIVE",
      secret_access: "SECRET_SENSITIVE",
      "credential-secrets-authority": "SECRET_SENSITIVE",
      "kernel-authority": "PRIVILEGED",
      "security-policy": "PRIVILEGED",
      "global-governance-policy": "PRIVILEGED",
      "completion-certification-authority": "PRIVILEGED",
    };
    for (const [capability, riskClass] of Object.entries(expected)) {
      expect(capabilityRiskClass(capability), capability).toBe(riskClass);
    }
    /* Total and explicit: nothing in the table that this test does not name. */
    expect(new Set(Object.keys(CAPABILITY_RISK_TABLE))).toEqual(new Set(Object.keys(expected)));
  });

  it("classifies every protected self-modification domain strictly", () => {
    for (const domain of PROTECTED_DOMAINS) {
      expect(["PRIVILEGED", "SECRET_SENSITIVE"]).toContain(capabilityRiskClass(domain));
    }
  });

  it("knows nothing it was not told (prototype keys included)", () => {
    expect(capabilityRiskClass("quantum_teleport")).toBeUndefined();
    expect(capabilityRiskClass("toString")).toBeUndefined();
    expect(capabilityRiskClass("__proto__")).toBeUndefined();
  });
});

describe("classifyTaskRisk", () => {
  it("takes the MOST severe class", () => {
    const c = classifyTaskRisk({ capabilities: ["research", "code_write", "deploy"] });
    expect(c.riskClass).toBe("IRREVERSIBLE");
    expect(c.classes).toEqual(["READ_ONLY", "REVERSIBLE_ISOLATED", "IRREVERSIBLE"]);
    expect(mostSevereClass(c.classes)).toBe("IRREVERSIBLE");
  });

  it("a task that declares nothing and writes nothing is READ_ONLY", () => {
    expect(classifyTaskRisk({ capabilities: [] }).classes).toEqual(["READ_ONLY"]);
  });

  it("a repository write is an effect whether or not a capability names it", () => {
    expect(classifyTaskRisk({ capabilities: [], repositoryWrite: true }).classes).toEqual([
      "REVERSIBLE_ISOLATED",
    ]);
  });

  it("records unclassified capabilities (fail closed)", () => {
    expect(classifyTaskRisk({ capabilities: ["research", "quantum_teleport"] }).unclassified).toEqual([
      "quantum_teleport",
    ]);
  });

  it("records capabilities outside the goal's allowlist, implicit code_write included", () => {
    expect(
      classifyTaskRisk({
        capabilities: ["research", "deploy"],
        repositoryWrite: true,
        allowedCapabilities: ["research"],
      }).outsideAllowlist,
    ).toEqual(["deploy", "code_write"]);
    /* No allowlist declared: nothing is outside it. */
    expect(classifyTaskRisk({ capabilities: ["deploy"] }).outsideAllowlist).toEqual([]);
  });

  it("kernel and asserted risk only escalate", () => {
    expect(classifyTaskRisk({ capabilities: ["deploy"], riskLevel: "read_only" }).riskClass).toBe(
      "IRREVERSIBLE",
    );
    expect(
      classifyTaskRisk({ capabilities: [], riskLevel: "sensitive", assertedRisk: "sensitive" })
        .escalatedBy,
    ).toEqual(["riskLevel", "assertedRisk"]);
  });
});

describe("decideTaskAutonomy", () => {
  const verdict = (
    input: Parameters<typeof classifyTaskRisk>[0],
    ctx: ActionAutonomyContext = { isolatedWorkspace: true },
  ) => decideTaskAutonomy(classifyTaskRisk(input), ctx);

  it("read-only and isolated writing are AUTONOMOUS", () => {
    expect(verdict({ capabilities: ["research"] }).decision).toBe("AUTONOMOUS");
    expect(verdict({ capabilities: [], repositoryWrite: true }).decision).toBe("AUTONOMOUS");
  });

  it("an un-isolated writer is escalated", () => {
    expect(verdict({ capabilities: [], repositoryWrite: true }, {}).decision).toBe(
      "APPROVAL_REQUIRED",
    );
  });

  it("destructive, financial and irreversible capabilities need a human", () => {
    for (const c of ["data_delete", "payment", "purchase", "deploy", "merge", "production_change", "customer_communication"]) {
      expect(verdict({ capabilities: ["research", c] }).decision, c).toBe("APPROVAL_REQUIRED");
    }
  });

  it("privileged work is GOVERNED, secret work needs a human", () => {
    expect(verdict({ capabilities: ["account_change"] }).decision).toBe("GOVERNED");
    expect(verdict({ capabilities: ["secret_access"] }).decision).toBe("APPROVAL_REQUIRED");
  });

  it("the strictest decision over ALL classes wins, not the most severe class's", () => {
    /* PRIVILEGED is more severe than REVERSIBLE_EXTERNAL but is only GOVERNED. */
    const c = { riskClass: "PRIVILEGED", classes: ["REVERSIBLE_EXTERNAL", "PRIVILEGED"], unclassified: [], outsideAllowlist: [], escalatedBy: [] } as const;
    expect(decideTaskAutonomy(c, {}).decision).toBe("APPROVAL_REQUIRED");
  });

  it("unknown, outside-allowlist, sensitive or owner-always all fail closed", () => {
    expect(verdict({ capabilities: ["quantum_teleport"] }).decision).toBe("APPROVAL_REQUIRED");
    expect(verdict({ capabilities: ["research"], allowedCapabilities: ["planning"] }).decision).toBe(
      "APPROVAL_REQUIRED",
    );
    expect(verdict({ capabilities: ["research"], riskLevel: "sensitive" }).decision).toBe(
      "APPROVAL_REQUIRED",
    );
    expect(verdict({ capabilities: ["research"], assertedRisk: "sensitive" }).decision).toBe(
      "APPROVAL_REQUIRED",
    );
    expect(
      verdict({ capabilities: ["research"] }, { isolatedWorkspace: true, ownerPolicy: "always" })
        .decision,
    ).toBe("APPROVAL_REQUIRED");
  });

  it("carries the policy version and a fingerprint that changes with what was classified", () => {
    const a = verdict({ capabilities: ["deploy"] });
    const b = verdict({ capabilities: ["data_delete"] });
    expect(a.policyVersion).toBe(POLICY_VERSION);
    expect(a.fingerprint).toContain(POLICY_VERSION);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(verdict({ capabilities: ["deploy"] }).fingerprint).toBe(a.fingerprint);
  });
});

describe("classifyMissionAutonomy is derived from the table, unchanged", () => {
  it("keeps the exact launch vocabulary, in order", () => {
    expect([...AUTO_ALLOWED_CAPABILITIES]).toEqual([
      "research",
      "planning",
      "architecture_design",
      "synthesis",
      "independent_review",
      "seo_audit",
      "sales_strategy",
      "code_write",
    ]);
    expect([...APPROVAL_REQUIRED_CAPABILITIES]).toEqual([
      "deploy",
      "merge",
      "payment",
      "purchase",
      "customer_communication",
      "account_change",
      "data_delete",
      "production_change",
    ]);
  });

  it("AUTO_ALLOWED ⇔ the task policy is AUTONOMOUS in an isolated workspace", () => {
    for (const [capability, entry] of Object.entries(CAPABILITY_RISK_TABLE)) {
      if (!entry.declarable) continue;
      const launch = classifyMissionAutonomy({ capabilities: [capability] }).policyClass;
      const task = decideActionAutonomy(entry.riskClass, { isolatedWorkspace: true }).decision;
      expect(launch === "AUTO_ALLOWED", capability).toBe(task === "AUTONOMOUS");
      expect(launch === "APPROVAL_REQUIRED", capability).toBe(task !== "AUTONOMOUS");
    }
  });

  it("non-declarable classified capabilities stay POLICY_GATED at launch, as before", () => {
    expect(classifyMissionAutonomy({ capabilities: ["secret_access"] }).policyClass).toBe(
      "POLICY_GATED",
    );
  });
});

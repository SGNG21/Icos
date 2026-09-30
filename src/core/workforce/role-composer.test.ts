import { describe, expect, it } from "vitest";

import {
  activateRole,
  certifyRole,
  composeRole,
  coverCapabilities,
  requiredRoleTests,
} from "./role-composer";
import { NOW, asAgent, owner, role, skill } from "./test-fixtures";

// "Create an expert in French BTP tenders." — the decomposer (a model, NOT_CONNECTED here)
// would return these capabilities; everything after it is deterministic.
const BTP_CAPABILITIES = ["public_procurement_fr", "tender_analysis", "btp_costing", "copywriting"];

const skills = [
  skill({
    skillId: "FRENCH_PUBLIC_PROCUREMENT",
    capabilities: ["public_procurement_fr", "tender_analysis"],
    risk: "MEDIUM",
    requiredTools: ["web_research"],
    tests: ["skill.fpp.dce_fixture"],
  }),
  skill({
    skillId: "BTP_COSTING",
    capabilities: ["btp_costing"],
    risk: "HIGH",
    requiredTools: ["finance_read"],
    tests: ["skill.btp.costing_fixture"],
  }),
  skill({
    skillId: "COPYWRITING",
    capabilities: ["copywriting", "tone_of_voice"],
    risk: "LOW",
    requiredTools: [],
    tests: ["skill.copy.fixture"],
  }),
  skill({
    skillId: "RETIRED_SKILL",
    capabilities: ["btp_costing"],
    risk: "LOW",
    status: "retired",
  }),
];
const creator = { kind: "agent" as const, id: "agent-central" };

const compose = (
  capabilities = BTP_CAPABILITIES,
  existingRoles = [] as ReturnType<typeof role>[],
) =>
  composeRole({
    need: "Create an expert in French BTP tenders",
    roleId: "FRENCH_BTP_TENDER_EXPERT",
    name: "French BTP tender expert",
    capabilities,
    agentKinds: ["EPHEMERAL_SPECIALIST"],
    skills,
    existingRoles,
    createdBy: creator,
  });

describe("dynamic role creation — need → capabilities → skills → role → policy → certification → registration", () => {
  it("covers capabilities with active skills only, deterministically", () => {
    const { chosen, uncovered } = coverCapabilities(BTP_CAPABILITIES, skills);
    expect(chosen.map((s) => s.skillId)).toEqual([
      "FRENCH_PUBLIC_PROCUREMENT",
      "COPYWRITING",
      "BTP_COSTING",
    ]);
    expect(uncovered).toEqual([]);
  });

  it("composes a DRAFT role with no tools and a ceiling bounded by the riskiest skill", () => {
    const result = compose();
    expect(result.kind).toBe("DRAFT");
    if (result.kind !== "DRAFT") return;
    expect(result.role).toMatchObject({
      status: "draft",
      autonomyCeiling: 2,
      provenance: { source: "dynamic_composition", createdBy: creator },
    });
    expect(JSON.stringify(result.role)).not.toMatch(/web_research|finance_read|toolGrants/);
  });

  it("reports a missing competence instead of inventing one", () => {
    expect(compose([...BTP_CAPABILITIES, "chorus_pro_submission"])).toEqual({
      kind: "INCOMPLETE",
      coveredBy: ["FRENCH_PUBLIC_PROCUREMENT", "COPYWRITING", "BTP_COSTING"],
      uncoveredCapabilities: ["chorus_pro_submission"],
    });
  });

  it("reuses an existing active role that already covers the need", () => {
    const existing = role({
      roleId: "TENDER_EXPERT",
      skills: ["FRENCH_PUBLIC_PROCUREMENT", "BTP_COSTING", "COPYWRITING"],
      agentKinds: ["EPHEMERAL_SPECIALIST"],
    });
    expect(compose(BTP_CAPABILITIES, [existing])).toMatchObject({
      kind: "REUSE_EXISTING",
      roleId: "TENDER_EXPERT",
    });
  });

  describe("certification and registration", () => {
    const draft = (() => {
      const r = compose();
      if (r.kind !== "DRAFT") throw new Error("expected draft");
      return r.role;
    })();
    const allTests = requiredRoleTests(draft, skills);

    it("requires every skill test", () => {
      expect(allTests).toEqual([
        "skill.btp.costing_fixture",
        "skill.copy.fixture",
        "skill.fpp.dce_fixture",
      ]);
      const r = certifyRole({
        role: draft,
        skills,
        certifier: owner(),
        testsPassed: allTests.slice(1),
        now: NOW,
      });
      expect(r).toEqual({ ok: false, violations: ["MISSING_TESTS"] });
    });
    it("the creator cannot certify its own role", () => {
      const r = certifyRole({
        role: draft,
        skills,
        certifier: asAgent(creator.id),
        testsPassed: allTests,
        now: NOW,
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.violations).toContain("SELF_CERTIFICATION");
    });
    it("a HIGH-risk role needs a human certifier", () => {
      const r = certifyRole({
        role: draft,
        skills,
        certifier: asAgent("agent-reviewer"),
        testsPassed: allTests,
        now: NOW,
      });
      expect(!r.ok && r.violations).toEqual(["HUMAN_CERTIFICATION_REQUIRED"]);
    });
    it("a human certifies, then a workforce admin activates; the result still grants nothing", () => {
      const certified = certifyRole({
        role: draft,
        skills,
        certifier: owner({ id: "reviewer-1", permissions: [] }),
        testsPassed: allTests,
        now: NOW,
      });
      expect(certified.ok).toBe(true);
      if (!certified.ok) return;
      expect(activateRole(certified.role, owner({ permissions: ["cockpit.read"] }))).toEqual({
        ok: false,
        violations: ["ACTOR_NOT_AUTHORIZED"],
      });
      expect(activateRole(draft, owner())).toEqual({ ok: false, violations: ["NOT_CERTIFIED"] });
      const active = activateRole(certified.role, owner());
      expect(active.ok && active.role.status).toBe("active");
      expect(
        Object.keys(active.ok ? active.role : {}).filter((k) => /tool|grant/i.test(k)),
      ).toEqual([]);
    });
    it("policy validation rejects a ceiling above the skills' risk", () => {
      const r = certifyRole({
        role: { ...draft, autonomyCeiling: 3 },
        skills,
        certifier: owner({ id: "reviewer-1" }),
        testsPassed: allTests,
        now: NOW,
      });
      expect(!r.ok && r.violations).toContain("CEILING_ABOVE_RISK");
    });
  });
});

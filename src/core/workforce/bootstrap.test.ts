import { describe, expect, it } from "vitest";

import rolesData from "./bootstrap/roles.json";
import skillsData from "./bootstrap/skills.json";
import { loadWorkforceBootstrap } from "./bootstrap";
import { validateRole } from "./role-composer";

describe("workforce bootstrap templates (data, not architecture)", () => {
  const b = loadWorkforceBootstrap();

  it("loads and cross-checks", () => {
    expect(b.skills).toHaveLength(25);
    expect(b.roles).toHaveLength(24);
    expect(b.departments).toHaveLength(10);
    for (const id of [
      "CYBER_SECURITY_LEAD",
      "ART_DIRECTOR",
      "SALES_DIRECTOR",
      "SDR",
      "SEO_SPECIALIST",
      "FULLSTACK_ENGINEER",
      "DEVOPS_ENGINEER",
      "FINANCE_ANALYST",
      "OPERATIONS_MANAGER",
      "RESEARCHER",
      "COPYWRITER",
      "CUSTOMER_SUPPORT",
    ]) {
      expect(b.roles.map((r) => r.roleId)).toContain(id);
    }
  });

  it("every role passes the same policy validation as a composed role", () => {
    for (const role of b.roles)
      expect([role.roleId, validateRole(role, b.skills)]).toEqual([role.roleId, []]);
  });

  it("ships roles as draft and names no agent and no tool on a role", () => {
    expect(b.roles.every((r) => r.status === "draft" && !r.certification)).toBe(true);
    expect(b.departments.every((d) => d.supervisorAgentId === null)).toBe(true);
    for (const r of rolesData)
      expect(Object.keys(r).filter((k) => /tool|grant/i.test(k))).toEqual([]);
  });

  it("binds no organisational identity to a model", () => {
    expect(JSON.stringify([skillsData, rolesData])).not.toMatch(
      /opus|sonnet|haiku|gpt|nemotron|claude|gemini/i,
    );
  });

  it("CYBER_SECURITY_AUDIT matches the mission example", () => {
    expect(b.skills.find((s) => s.skillId === "CYBER_SECURITY_AUDIT")).toMatchObject({
      capabilities: [
        "threat_modeling",
        "appsec",
        "secrets_audit",
        "iam_review",
        "dependency_review",
      ],
      requiredTools: ["repo_read", "scanners", "logs"],
      risk: "HIGH",
      approvalRequiredFor: ["destructive_remediation"],
    });
    expect(b.skills.every((s) => s.tests.length > 0 && s.evidenceRequirements.length > 0)).toBe(
      true,
    );
  });
});

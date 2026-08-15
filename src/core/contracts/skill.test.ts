import { describe, expect, it } from "vitest";

import {
  skillSchema,
  skillProvenanceSchema,
  skillNetworkRequirementSchema,
  skillCredentialRequirementSchema,
  skillDependencyDeclarationSchema,
  trustStateSchema,
  activationStateSchema,
  securityScanSchema,
  evaluationSchema,
} from "./skill";
import { dataCategorySchema, sensitivityLevelSchema } from "./tenant";

describe("dataCategorySchema — alignement COMPLIANCE-0", () => {
  const valid = [
    "PUBLIC",
    "INTERNAL",
    "PERSONAL",
    "SENSITIVE_PERSONAL",
    "CONFIDENTIAL_CLIENT",
    "AUTH_SECRET",
    "FINANCIAL",
    "LEGAL",
    "HEALTH",
    "HR",
    "CHILD_DATA",
    "BIOMETRIC",
    "DERIVED_PROFILE",
  ];

  for (const cat of valid) {
    it(`accepte ${cat}`, () => {
      expect(dataCategorySchema.safeParse(cat).success).toBe(true);
    });
  }

  it("rejette C0 comme data category (inversion de concept)", () => {
    expect(dataCategorySchema.safeParse("C0").success).toBe(false);
  });

  it("rejette C3 comme data category (inversion de concept)", () => {
    expect(dataCategorySchema.safeParse("C3").success).toBe(false);
  });

  it("rejette empty string", () => {
    expect(dataCategorySchema.safeParse("").success).toBe(false);
  });
});

describe("sensitivityLevelSchema — alignement COMPLIANCE-0", () => {
  for (const level of ["C0", "C1", "C2", "C3"]) {
    it(`accepte ${level}`, () => {
      expect(sensitivityLevelSchema.safeParse(level).success).toBe(true);
    });
  }

  it("rejette PUBLIC comme sensitivity level (inversion de concept)", () => {
    expect(sensitivityLevelSchema.safeParse("PUBLIC").success).toBe(false);
  });

  it("rejette PERSONAL comme sensitivity level (inversion de concept)", () => {
    expect(sensitivityLevelSchema.safeParse("PERSONAL").success).toBe(false);
  });
});

describe("trustStateSchema", () => {
  const valid = ["untrusted", "quarantined", "reviewed", "approved", "rejected"];
  for (const s of valid) {
    it(`accepte ${s}`, () => {
      expect(trustStateSchema.safeParse(s).success).toBe(true);
    });
  }

  it("rejette un état invalide", () => {
    expect(trustStateSchema.safeParse("invalid").success).toBe(false);
  });
});

describe("activationStateSchema", () => {
  const valid = ["inactive", "active", "suspended", "revoked"];
  for (const s of valid) {
    it(`accepte ${s}`, () => {
      expect(activationStateSchema.safeParse(s).success).toBe(true);
    });
  }

  it("rejette un état invalide", () => {
    expect(activationStateSchema.safeParse("invalid").success).toBe(false);
  });
});

describe("skillProvenanceSchema", () => {
  const valid = {
    source: "url",
    origin: "human",
    contentHash: "abc123",
    importedAt: "2026-07-25T08:00:00.000Z",
  };

  it("accepte une provenance minimale", () => {
    expect(skillProvenanceSchema.safeParse(valid).success).toBe(true);
  });

  it("accepte une provenance avec originalManifest", () => {
    const withManifest = {
      ...valid,
      originalManifest: { name: "ext-skill", version: "1.0", scripts: [] },
    };
    const result = skillProvenanceSchema.safeParse(withManifest);
    expect(result.success).toBe(true);
  });

  it("rejette provenance sans source", () => {
    const { source: _unused, ...noSource } = valid;
    void _unused;
    expect(skillProvenanceSchema.safeParse(noSource).success).toBe(false);
  });
});

describe("requirements déclaratifs", () => {
  it("SkillNetworkRequirement : valide", () => {
    const req = { requiredDomain: "api.github.com", purpose: "fetch PRs", required: true };
    expect(skillNetworkRequirementSchema.safeParse(req).success).toBe(true);
  });

  it("SkillCredentialRequirement : valide", () => {
    const req = {
      requiredCredentialKind: "github_token",
      purpose: "auth",
      requiredScope: "repo:read",
      required: true,
    };
    expect(skillCredentialRequirementSchema.safeParse(req).success).toBe(true);
  });

  it("SkillDependencyDeclaration : valide", () => {
    const dep = {
      dependencySkillKey: "code.review.base",
      versionConstraint: ">=1.0.0",
      optional: false,
    };
    expect(skillDependencyDeclarationSchema.safeParse(dep).success).toBe(true);
  });

  it("SkillCredentialRequirement ne peut pas contenir de credentialValue (interdiction)", () => {
    const req = {
      requiredCredentialKind: "github_token",
      purpose: "auth",
      requiredScope: "repo:read",
      required: true,
      credentialValue: "ghp_abc123",
    };
    // Zod strict() n'est pas utilisé, mais le schéma ignore les champs inconnus
    const result = skillCredentialRequirementSchema.safeParse(req);
    expect(result.success).toBe(true);
    // Vérification : le champ extra n'est PAS dans le résultat parsé
    const parsed = result.data as Record<string, unknown>;
    expect(parsed.credentialValue).toBeUndefined();
  });
});

describe("skillSchema — entité complète", () => {
  const validSkill = {
    id: "skill-001",
    tenantId: "default",
    skillKey: "code.review.agent",
    version: "1.0.0",
    name: "Code Review Agent",
    category: "cognitive",
    capabilityKeys: ["code.review"],
    trustState: "untrusted",
    activationState: "inactive",
    contentHash: "a".repeat(64),
    provenance: {
      source: "internal",
      origin: "human",
      contentHash: "a".repeat(64),
      importedAt: "2026-07-25T08:00:00.000Z",
    },
    createdAt: "2026-07-25T08:00:00.000Z",
    updatedAt: "2026-07-25T08:00:00.000Z",
  };

  it("accepte un skill valide minimal", () => {
    const result = skillSchema.safeParse(validSkill);
    expect(result.success).toBe(true);
  });

  it("accepte un skill avec tous les champs optionnels", () => {
    const full = {
      ...validSkill,
      description: "Full skill",
      scripts: [
        { name: "main", language: "typescript", entrypoint: true, content: "console.log('hello')" },
      ],
      resources: [{ path: "/config.yaml", type: "config" }],
      references: [{ url: "https://example.com/docs", description: "Docs", type: "documentation" }],
      dependencyDeclarations: [{ dependencySkillKey: "base.skill", optional: false }],
      networkRequirements: [{ requiredDomain: "api.example.com", purpose: "data", required: true }],
      credentialRequirements: [
        { requiredCredentialKind: "token", purpose: "auth", requiredScope: "read", required: true },
      ],
      toolRequirements: [{ requiredTool: "gmail.send", required: true, purpose: "send email" }],
      dataCategory: "PERSONAL",
      sensitivityLevel: "C3",
    };
    const result = skillSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  it("rejette un id trop court", () => {
    expect(skillSchema.safeParse({ ...validSkill, id: "ab" }).success).toBe(false);
  });

  it("rejette trustState invalide", () => {
    expect(skillSchema.safeParse({ ...validSkill, trustState: "invalid" }).success).toBe(false);
  });
});

describe("securityScanSchema", () => {
  it("accepte un scan valide", () => {
    const scan = {
      id: "scan-001",
      tenantId: "default",
      skillId: "skill-001",
      evaluatedContentHash: "abc123",
      scannerId: "skillspector",
      status: "passed",
      startedAt: "2026-07-25T08:00:00.000Z",
      createdAt: "2026-07-25T08:00:00.000Z",
    };
    expect(securityScanSchema.safeParse(scan).success).toBe(true);
  });

  it("rejette status de scan invalide", () => {
    const scan = {
      id: "scan-001",
      tenantId: "default",
      skillId: "skill-001",
      evaluatedContentHash: "abc123",
      scannerId: "skillspector",
      status: "unknown",
      startedAt: "2026-07-25T08:00:00.000Z",
      createdAt: "2026-07-25T08:00:00.000Z",
    };
    expect(securityScanSchema.safeParse(scan).success).toBe(false);
  });
});

describe("evaluationSchema", () => {
  it("accepte une eval valide", () => {
    const evalRecord = {
      id: "eval-001",
      tenantId: "default",
      skillId: "skill-001",
      evaluatedContentHash: "abc123",
      evaluatorType: "behavioral",
      status: "passed",
      score: { accuracy: 0.95 },
      startedAt: "2026-07-25T08:00:00.000Z",
      createdAt: "2026-07-25T08:00:00.000Z",
    };
    expect(evaluationSchema.safeParse(evalRecord).success).toBe(true);
  });
});

describe("skillDependency — requirement ≠ permission", () => {
  it("skillDependencyDeclaration n'accorde pas de permission", () => {
    const dep = skillDependencyDeclarationSchema.parse({
      dependencySkillKey: "some.skill",
      optional: false,
    });
    // Aucun champ de permission dans le type
    expect(dep).not.toHaveProperty("permission");
    expect(dep).not.toHaveProperty("grant");
    expect(dep).not.toHaveProperty("authorization");
  });
});

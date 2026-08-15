import { describe, expect, it } from "vitest";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import {
  InMemorySkillRepository,
  InMemorySkillSecurityScanRepository,
  InMemorySkillEvaluationRepository,
} from "@/server/services/in-memory/skill-repository";
import { InMemorySkillUnitOfWork } from "@/server/uow/in-memory-skill-uow";
import { SkillService, type ActorInfo } from "./skill-service";

const HUMAN: ActorInfo = { actorKind: "human", actorLabel: "test-user" };
const AGENT: ActorInfo = { actorKind: "agent", actorLabel: "agent-001" };

function createService() {
  const auditLog = new InMemoryAuditLog();
  const audit = new InMemoryAuditRepository(auditLog);
  const skills = new InMemorySkillRepository();
  const scans = new InMemorySkillSecurityScanRepository();
  const evals = new InMemorySkillEvaluationRepository();
  const uow = new InMemorySkillUnitOfWork(skills, auditLog);
  const service = new SkillService(skills, scans, evals, audit, uow);
  return { service, audit, skills, scans, evals };
}

const baseSkill = {
  tenantId: "default",
  skillKey: "code.review.agent",
  version: "1.0.0",
  name: "Code Review Agent",
  category: "cognitive",
  capabilityKeys: ["code.review"],
  provenance: {
    source: "internal" as const,
    origin: "human" as const,
    contentHash: "",
    importedAt: "2026-07-25T08:00:00.000Z",
  },
};

async function createTestSkill(service: SkillService) {
  const result = await service.createSkill({ skill: baseSkill, actor: HUMAN });
  if (!result.ok) throw new Error(`createSkill failed: ${result.message}`);
  return result.data.skill;
}

function expectOk<T>(result: { ok: true; data: T } | { ok: false; reason: string }): T {
  if (!result.ok) throw new Error(`Expected ok but got: ${result.reason}`);
  return result.data;
}

// ─────────────────────────────────────
// Création / Import
// ─────────────────────────────────────

describe("createSkill", () => {
  it("crée un skill avec trustState = untrusted", async () => {
    const { service } = createService();
    const result = await service.createSkill({ skill: baseSkill, actor: HUMAN });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skill.trustState).toBe("untrusted");
    }
  });

  it("crée un skill avec activationState = inactive", async () => {
    const { service } = createService();
    const result = await service.createSkill({ skill: baseSkill, actor: HUMAN });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skill.activationState).toBe("inactive");
    }
  });

  it("crée un skill avec un contentHash valide", async () => {
    const { service } = createService();
    const result = await service.createSkill({ skill: baseSkill, actor: HUMAN });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skill.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rejette un skill avec des champs invalides (via Zod)", async () => {
    const { service } = createService();
    await expect(
      service.createSkill({
        skill: { ...baseSkill, name: "" },
        actor: HUMAN,
      }),
    ).rejects.toThrow();
  });
});

describe("importSkill", () => {
  it("importe un skill avec trustState = untrusted", async () => {
    const { service } = createService();
    const result = await service.importSkill({
      skill: {
        ...baseSkill,
        provenance: {
          ...baseSkill.provenance,
          source: "url",
          sourceUrl: "https://example.com/skill",
        },
      },
      actor: HUMAN,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skill.trustState).toBe("untrusted");
      expect(result.data.skill.provenance.source).toBe("url");
    }
  });
});

// ─────────────────────────────────────
// Trust transitions
// ─────────────────────────────────────

describe("trust transitions", () => {
  async function approvedSkill(service: SkillService) {
    const s = await createTestSkill(service);
    await service.quarantineSkill(s.id, HUMAN);
    await service.reviewSkill(s.id, HUMAN);
    const result = await service.approveSkill(s.id, HUMAN);
    return expectOk(result);
  }

  it("quarantine → reviewed → approved", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);

    const q = await service.quarantineSkill(skill.id, HUMAN);
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.data.skill.trustState).toBe("quarantined");

    const r = await service.reviewSkill(skill.id, HUMAN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.skill.trustState).toBe("reviewed");

    const a = await service.approveSkill(skill.id, HUMAN);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.data.skill.trustState).toBe("approved");
  });

  it("refuse approved par un agent (human-only)", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);
    await service.reviewSkill(skill.id, HUMAN);

    const result = await service.approveSkill(skill.id, AGENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("human_only");
  });

  it("refuse une transition invalide (untrusted → reviewed via API publique)", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    // reviewSkill appelle transitionTrust(id, "reviewed", ...) en interne.
    // Depuis untrusted, seule quarantined est autorisée ; reviewed est refusé
    const result = await service.reviewSkill(skill.id, HUMAN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_transition");
  });

  it("rejected est terminal : aucune autre transition possible", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);
    await service.reviewSkill(skill.id, HUMAN);
    const rejected = await service.rejectSkillAction(skill.id, HUMAN);
    expect(rejected.ok).toBe(true);

    // Tenter de passer de rejected → autre chose doit échouer
    const tryReview = await service.reviewSkill(skill.id, HUMAN);
    expect(tryReview.ok).toBe(false);
    if (!tryReview.ok) expect(tryReview.reason).toBe("invalid_transition");

    const tryApprove = await service.approveSkill(skill.id, HUMAN);
    expect(tryApprove.ok).toBe(false);
  });
});

// ─────────────────────────────────────
// Activation transitions
// ─────────────────────────────────────

describe("activation transitions", () => {
  it("active un skill approved", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);
    await service.reviewSkill(skill.id, HUMAN);
    await service.approveSkill(skill.id, HUMAN);

    const result = await service.activateSkill(skill.id, HUMAN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skill.activationState).toBe("active");
    }
  });

  it("refuse d'activer un skill non approved", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);

    const result = await service.activateSkill(skill.id, HUMAN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("trust_not_approved");
  });

  it("suspended → active (reactivation)", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);
    await service.reviewSkill(skill.id, HUMAN);
    await service.approveSkill(skill.id, HUMAN);
    await service.activateSkill(skill.id, HUMAN);

    await service.suspendSkill(skill.id, HUMAN);
    const r = await service.reactivateSkill(skill.id, HUMAN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.skill.activationState).toBe("active");
  });

  it("revoked est terminal : active → revoked ne peut pas revenir", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);
    await service.reviewSkill(skill.id, HUMAN);
    await service.approveSkill(skill.id, HUMAN);
    await service.activateSkill(skill.id, HUMAN);

    await service.revokeSkill(skill.id, HUMAN);
    const r = await service.activateSkill(skill.id, HUMAN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_transition");
  });

  it("refuse activate par un agent (human-only)", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);
    await service.reviewSkill(skill.id, HUMAN);
    await service.approveSkill(skill.id, HUMAN);

    const result = await service.activateSkill(skill.id, AGENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("human_only");
  });

  it("inactive → revoked permet la révocation sans activation", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    // Revoke directement depuis inactive
    const result = await service.revokeSkill(skill.id, HUMAN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skill.activationState).toBe("revoked");
    }
  });
});

// ─────────────────────────────────────
// Cross-invariants
// ─────────────────────────────────────

describe("cross-invariants", () => {
  it("CROSS-I-2 : approved + active → rejected → rejected + revoked", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);
    await service.reviewSkill(skill.id, HUMAN);
    await service.approveSkill(skill.id, HUMAN);
    await service.activateSkill(skill.id, HUMAN);

    await service.rejectSkillAction(skill.id, HUMAN);
    const s = await service.getSkill(skill.id);
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect(s.data.skill.trustState).toBe("rejected");
      expect(s.data.skill.activationState).toBe("revoked");
    }
  });

  it("CROSS-I-2 : approved + inactive → rejected → rejected + revoked", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);
    await service.reviewSkill(skill.id, HUMAN);
    await service.approveSkill(skill.id, HUMAN);

    // Rejeter alors que jamais activé
    await service.rejectSkillAction(skill.id, HUMAN);
    const s = await service.getSkill(skill.id);
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect(s.data.skill.trustState).toBe("rejected");
      expect(s.data.skill.activationState).toBe("revoked");
    }
  });
});

// ─────────────────────────────────────
// Content immutability
// ─────────────────────────────────────

describe("content update", () => {
  it("modifie le contenu en état mutable (untrusted)", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);

    const result = await service.updateSkillContent(
      skill.id,
      { ...baseSkill, name: "Updated Name" },
      HUMAN,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skill.name).toBe("Updated Name");
      expect(result.data.skill.trustState).toBe("untrusted");
    }
  });

  it("refuse de modifier le contenu en état approved (immutable)", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);
    await service.reviewSkill(skill.id, HUMAN);
    await service.approveSkill(skill.id, HUMAN);

    const result = await service.updateSkillContent(
      skill.id,
      { ...baseSkill, name: "Should Fail" },
      HUMAN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("immutable_version");
  });

  it("recalcule le hash après modification", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    const originalHash = skill.contentHash;

    const result = await service.updateSkillContent(
      skill.id,
      { ...baseSkill, name: "New Name" },
      HUMAN,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skill.contentHash).not.toBe(originalHash);
    }
  });

  it("refuse modification après approved → activé", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);
    await service.reviewSkill(skill.id, HUMAN);
    await service.approveSkill(skill.id, HUMAN);
    await service.activateSkill(skill.id, HUMAN);

    const result = await service.updateSkillContent(skill.id, { ...baseSkill, name: "New" }, HUMAN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("immutable_version");
  });
});

// ─────────────────────────────────────
// Audit
// ─────────────────────────────────────

describe("audit events", () => {
  it("produit skill.created après création", async () => {
    const { service, audit } = createService();
    await createTestSkill(service);

    const entries = await audit.list();
    const created = entries.find((e) => e.eventType === "skill.created");
    expect(created).toBeDefined();
    expect(created!.details.skillKey).toBe("code.review.agent");
  });

  it("produit skill.trust_changed après transitions", async () => {
    const { service, audit } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);

    const entries = await audit.list();
    const trustChanged = entries.filter((e) => e.eventType === "skill.trust_changed");
    expect(trustChanged.length).toBeGreaterThanOrEqual(1);
  });

  it("produit des audit events pour rejected (trust + activation)", async () => {
    const { service, audit } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);
    await service.reviewSkill(skill.id, HUMAN);
    await service.approveSkill(skill.id, HUMAN);
    await service.rejectSkillAction(skill.id, HUMAN);

    const entries = await audit.list();
    const activationChanged = entries.filter((e) => e.eventType === "skill.activation_changed");
    expect(activationChanged.length).toBeGreaterThanOrEqual(1);
  });

  it("ne contient pas de données sensibles dans les audits", async () => {
    const { service, audit } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);

    const entries = await audit.list();
    for (const entry of entries) {
      const str = JSON.stringify(entry.details);
      expect(str).not.toContain("secret");
      expect(str).not.toContain("password");
      expect(str).not.toContain("token");
      expect(str).not.toContain("credential");
    }
  });
});

// ─────────────────────────────────────
// Délétion
// ─────────────────────────────────────

describe("deleteSkill", () => {
  it("supprime un skill inactif", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);

    const result = await service.deleteSkill(skill.id, HUMAN);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.deleted).toBe(true);
  });

  it("refuse de supprimer un skill actif", async () => {
    const { service } = createService();
    const skill = await createTestSkill(service);
    await service.quarantineSkill(skill.id, HUMAN);
    await service.reviewSkill(skill.id, HUMAN);
    await service.approveSkill(skill.id, HUMAN);
    await service.activateSkill(skill.id, HUMAN);

    const result = await service.deleteSkill(skill.id, HUMAN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cannot_delete_active");
  });
});

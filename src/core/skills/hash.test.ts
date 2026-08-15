import { describe, expect, it } from "vitest";

import type { Skill } from "@/core/contracts/skill";
import { computeSkillHash, buildHashPayload } from "./hash";

function makeSkill(
  overrides?: Partial<Skill>,
): Omit<Skill, "id" | "tenantId" | "createdAt" | "updatedAt"> {
  return {
    skillKey: "code.review.agent",
    version: "1.0.0",
    name: "Code Review Agent",
    description: "Reviews code changes",
    category: "cognitive",
    capabilityKeys: ["code.review"],
    trustState: "untrusted",
    activationState: "inactive",
    contentHash: "",
    provenance: {
      source: "internal",
      origin: "human",
      contentHash: "",
      importedAt: "2026-07-25T08:00:00.000Z",
    },
    ...overrides,
  };
}

describe("computeSkillHash", () => {
  it("produit un hash SHA-256 hexastring", () => {
    const hash = computeSkillHash(makeSkill());
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("est déterministe : même entrée → même hash", () => {
    const a = computeSkillHash(makeSkill());
    const b = computeSkillHash(makeSkill());
    expect(a).toBe(b);
  });

  it("produit un hash différent pour un nom différent", () => {
    const a = computeSkillHash(makeSkill({ name: "Agent A" }));
    const b = computeSkillHash(makeSkill({ name: "Agent B" }));
    expect(a).not.toBe(b);
  });

  it("produit un hash différent pour une version différente", () => {
    const a = computeSkillHash(makeSkill({ version: "1.0.0" }));
    const b = computeSkillHash(makeSkill({ version: "2.0.0" }));
    expect(a).not.toBe(b);
  });

  it("produit un hash différent pour des capabilityKeys différents", () => {
    const a = computeSkillHash(makeSkill({ capabilityKeys: ["code.review"] }));
    const b = computeSkillHash(makeSkill({ capabilityKeys: ["code.review", "code.write"] }));
    expect(a).not.toBe(b);
  });

  it("est insensible à l'ordre des capabilityKeys (tri stable)", () => {
    const a = computeSkillHash(makeSkill({ capabilityKeys: ["code.review", "code.write"] }));
    const b = computeSkillHash(makeSkill({ capabilityKeys: ["code.write", "code.review"] }));
    // Les deux tableaux sont triés avant hash → même résultat
    expect(a).toBe(b);
  });

  it("n'inclut PAS trustState dans le hash", () => {
    const a = computeSkillHash(makeSkill({ trustState: "untrusted" }));
    const b = computeSkillHash(makeSkill({ trustState: "approved" }));
    expect(a).toBe(b);
  });

  it("n'inclut PAS activationState dans le hash", () => {
    const a = computeSkillHash(makeSkill({ activationState: "inactive" }));
    const b = computeSkillHash(makeSkill({ activationState: "active" }));
    expect(a).toBe(b);
  });

  it("n'inclut PAS contentHash dans le hash (auto-référence évitée)", () => {
    const a = computeSkillHash(makeSkill({ contentHash: "abc" }));
    const b = computeSkillHash(makeSkill({ contentHash: "xyz" }));
    expect(a).toBe(b);
  });

  it("inclut originalManifest dans le hash s'il est présent", () => {
    const a = computeSkillHash(
      makeSkill({
        provenance: {
          source: "url",
          origin: "human",
          contentHash: "",
          importedAt: "2026-07-25T08:00:00.000Z",
          originalManifest: { name: "ext-skill", version: "1.0" },
        },
      }),
    );
    const b = computeSkillHash(
      makeSkill({
        provenance: {
          source: "url",
          origin: "human",
          contentHash: "",
          importedAt: "2026-07-25T08:00:00.000Z",
          originalManifest: { name: "ext-skill", version: "2.0" },
        },
      }),
    );
    expect(a).not.toBe(b);
  });

  it("inclut description null (pas de différence avec absent)", () => {
    const a = computeSkillHash(makeSkill({ description: undefined }));
    const b = computeSkillHash(makeSkill({ description: "something" }));
    expect(a).not.toBe(b);
  });
});

describe("buildHashPayload", () => {
  it("ne contient pas id, tenantId, createdAt, updatedAt", () => {
    const skill = makeSkill();
    const payload = buildHashPayload(skill);
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("tenantId");
    expect(payload).not.toHaveProperty("createdAt");
    expect(payload).not.toHaveProperty("updatedAt");
  });

  it("ne contient pas trustState ni activationState", () => {
    const payload = buildHashPayload(makeSkill());
    expect(payload).not.toHaveProperty("trustState");
    expect(payload).not.toHaveProperty("activationState");
  });
});

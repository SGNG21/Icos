import { describe, expect, it } from "vitest";

import {
  CONTEXT_LIMITS,
  conversationContextSchema,
  memoryReferenceSchema,
  missionContextSchema,
} from "./index";

const VALID_MISSION_CONTEXT = {
  tenantId: "tenant-1",
  missionId: "mission-abc",
  version: 0,
  confirmedObjective: "Livrer le rapport trimestriel",
  confirmedConstraints: [],
  assumptions: [],
  openQuestions: [],
  boundedSummary: "Livrer le rapport trimestriel",
  memoryReferences: [],
  builtAt: "2026-07-26T10:00:00.000Z",
  builtByLabel: "context-builder",
};

describe("CTX-SUP-1 — missionContextSchema", () => {
  it("accepte un MissionContext valide minimal", () => {
    const parsed = missionContextSchema.safeParse(VALID_MISSION_CONTEXT);
    expect(parsed.success).toBe(true);
  });

  it("rejette tout champ d'autorité superflu (strict)", () => {
    for (const authorityField of [
      "grant",
      "executionGrant",
      "token",
      "credential",
      "approved",
      "policyDecision",
    ]) {
      const parsed = missionContextSchema.safeParse({
        ...VALID_MISSION_CONTEXT,
        [authorityField]: "x",
      });
      expect(parsed.success, `${authorityField} doit être rejeté`).toBe(false);
    }
  });

  it("rejette un objectif vide (fail-closed sur l'absence de contenu)", () => {
    const parsed = missionContextSchema.safeParse({
      ...VALID_MISSION_CONTEXT,
      confirmedObjective: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejette un boundedSummary au-delà de la borne", () => {
    const parsed = missionContextSchema.safeParse({
      ...VALID_MISSION_CONTEXT,
      boundedSummary: "x".repeat(CONTEXT_LIMITS.summaryMaxLength + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejette une version négative", () => {
    const parsed = missionContextSchema.safeParse({
      ...VALID_MISSION_CONTEXT,
      version: -1,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("CTX-SUP-1 — memoryReferenceSchema", () => {
  it("n'accepte que source = memory_reference", () => {
    const ok = memoryReferenceSchema.safeParse({
      source: "memory_reference",
      ref: "mem-1",
      observedAt: "2026-07-26T10:00:00.000Z",
    });
    expect(ok.success).toBe(true);

    const bad = memoryReferenceSchema.safeParse({
      source: "user_message",
      ref: "mem-1",
      observedAt: "2026-07-26T10:00:00.000Z",
    });
    expect(bad.success).toBe(false);
  });
});

describe("CTX-SUP-1 — conversationContextSchema", () => {
  it("accepte une conversation valide et applique confirmed=false par défaut", () => {
    const parsed = conversationContextSchema.safeParse({
      tenantId: "tenant-1",
      turns: [
        {
          id: "turn-1",
          role: "user",
          text: "Bonjour",
          observedAt: "2026-07-26T10:00:00.000Z",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.turns[0]?.confirmed).toBe(false);
      expect(parsed.data.memoryReferences).toEqual([]);
    }
  });

  it("rejette un tour avec un champ inconnu (strict)", () => {
    const parsed = conversationContextSchema.safeParse({
      tenantId: "tenant-1",
      turns: [
        {
          id: "turn-1",
          role: "user",
          text: "Bonjour",
          observedAt: "2026-07-26T10:00:00.000Z",
          grantsAuthority: true,
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

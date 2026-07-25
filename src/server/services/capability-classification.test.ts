import { describe, expect, it } from "vitest";

import { capabilitySchema } from "@/core/contracts/capability";

const validCapability = {
  id: "cap-test-1",
  key: "compliance.test",
  name: "Test Capability",
  category: "cognitive",
  status: "proposed" as const,
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
};

describe("CAP-CLASS-01 — créer capability sans classification → accepté", () => {
  it("capability sans sensitivityLevel est valide", () => {
    const result = capabilitySchema.safeParse(validCapability);
    expect(result.success).toBe(true);
  });

  it("capability sans dataCategory est valide", () => {
    const result = capabilitySchema.safeParse(validCapability);
    expect(result.success).toBe(true);
  });
});

describe("CAP-CLASS-02 — créer capability avec sensitivityLevel=C3 → accepté", () => {
  it("capability avec C3 sensitivityLevel est valide", () => {
    const result = capabilitySchema.safeParse({
      ...validCapability,
      sensitivityLevel: "C3",
    });
    expect(result.success).toBe(true);
  });

  it("capability avec dataCategory PERSONAL est valide", () => {
    const result = capabilitySchema.safeParse({
      ...validCapability,
      dataCategory: "PERSONAL",
      sensitivityLevel: "C3",
    });
    expect(result.success).toBe(true);
  });
});

describe("CAP-CLASS-03 — sensitivityLevel invalide refusé", () => {
  it("C4 n'est pas un niveau valide", () => {
    const result = capabilitySchema.safeParse({
      ...validCapability,
      sensitivityLevel: "C4",
    });
    expect(result.success).toBe(false);
  });

  it("empty string n'est pas un niveau valide", () => {
    const result = capabilitySchema.safeParse({
      ...validCapability,
      sensitivityLevel: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("CAP-CLASS-04 — dataCategory invalide refusé", () => {
  it("catégorie inconnue est refusée", () => {
    const result = capabilitySchema.safeParse({
      ...validCapability,
      dataCategory: "INVALID_CATEGORY",
    });
    expect(result.success).toBe(false);
  });
});

describe("CAP-CLASS-05 — retentionPolicyRef pour C3", () => {
  it("retentionPolicyRef valide est accepté", () => {
    const result = capabilitySchema.safeParse({
      ...validCapability,
      sensitivityLevel: "C3",
      retentionPolicyRef: {
        maxRetentionDays: 90,
        legalBasis: "consent" as const,
        purpose: "Traitement de données personnelles pour analyse commerciale",
      },
    });
    expect(result.success).toBe(true);
  });

  it("retentionPolicyRef sans maxRetentionDays est refusé", () => {
    const result = capabilitySchema.safeParse({
      ...validCapability,
      sensitivityLevel: "C3",
      retentionPolicyRef: {
        legalBasis: "consent",
        purpose: "Test",
      },
    });
    expect(result.success).toBe(false);
  });

  it("retentionPolicyRef avec legalBasis invalide est refusé", () => {
    const result = capabilitySchema.safeParse({
      ...validCapability,
      sensitivityLevel: "C3",
      retentionPolicyRef: {
        maxRetentionDays: 90,
        legalBasis: "invalid_basis",
        purpose: "Test",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("CAP-CLASS-06 — C3 sans retentionPolicyRef est valide au niveau contrat", () => {
  it("une capability C3 sans retentionPolicyRef est valide (validation au changement de statut)", () => {
    // Le contrat accepte une capability C3 sans retentionRef.
    // La validation au changement de statut (active) est dans CapabilityService.
    const result = capabilitySchema.safeParse({
      ...validCapability,
      sensitivityLevel: "C3",
    });
    expect(result.success).toBe(true);
    expect(result.data?.retentionPolicyRef).toBeUndefined();
  });
});

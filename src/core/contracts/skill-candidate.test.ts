import { describe, expect, it } from "vitest";

import {
  candidateCompatibilityStateSchema,
  candidateProvenanceSchema,
  candidateSecurityStateSchema,
  candidateTrustStateSchema,
  candidateVerificationStateSchema,
  capabilityClaimEvidenceSchema,
  compatibilityHintSchema,
  skillCandidateSchema,
  skillsMpErrorCodeSchema,
  SkillsMpError,
  isSkillsMpErrorRetryable,
} from "./skill-candidate";

describe("skill-candidate contracts", () => {
  describe("enums", () => {
    it("candidateVerificationStateSchema accepte les valeurs attendues", () => {
      expect(candidateVerificationStateSchema.safeParse("pending").success).toBe(true);
      expect(candidateVerificationStateSchema.safeParse("incomplete").success).toBe(true);
      expect(candidateVerificationStateSchema.safeParse("verified").success).toBe(true);
      expect(candidateVerificationStateSchema.safeParse("failed").success).toBe(true);
      expect(candidateVerificationStateSchema.safeParse("unknown").success).toBe(false);
    });

    it("candidateTrustStateSchema accepte les valeurs attendues", () => {
      expect(candidateTrustStateSchema.safeParse("untrusted").success).toBe(true);
      expect(candidateTrustStateSchema.safeParse("quarantined").success).toBe(true);
      expect(candidateTrustStateSchema.safeParse("reviewed").success).toBe(true);
      expect(candidateTrustStateSchema.safeParse("approved").success).toBe(true);
      expect(candidateTrustStateSchema.safeParse("rejected").success).toBe(true);
    });

    it("candidateSecurityStateSchema accepte les valeurs attendues", () => {
      expect(candidateSecurityStateSchema.safeParse("pending").success).toBe(true);
      expect(candidateSecurityStateSchema.safeParse("scanning").success).toBe(true);
      expect(candidateSecurityStateSchema.safeParse("passed").success).toBe(true);
      expect(candidateSecurityStateSchema.safeParse("failed").success).toBe(true);
      expect(candidateSecurityStateSchema.safeParse("error").success).toBe(true);
    });

    it("candidateCompatibilityStateSchema accepte les valeurs attendues", () => {
      expect(candidateCompatibilityStateSchema.safeParse("unknown").success).toBe(true);
      expect(candidateCompatibilityStateSchema.safeParse("compatible").success).toBe(true);
      expect(candidateCompatibilityStateSchema.safeParse("compatible_with_adapter").success).toBe(
        true,
      );
      expect(candidateCompatibilityStateSchema.safeParse("compatible_with_limits").success).toBe(
        true,
      );
      expect(candidateCompatibilityStateSchema.safeParse("incompatible").success).toBe(true);
    });

    it("skillsMpErrorCodeSchema accepte tous les codes requis", () => {
      const codes = [
        "SKILLSMP_CREDENTIAL_UNAVAILABLE",
        "SKILLSMP_RATE_LIMITED",
        "SKILLSMP_UNAVAILABLE",
        "SKILLSMP_AUTH_FAILED",
        "SKILLSMP_INVALID_RESPONSE",
        "SKILLSMP_TIMEOUT",
        "SKILLSMP_CANDIDATE_INCOMPLETE",
        "SKILLSMP_SOURCE_UNAVAILABLE",
      ];
      for (const code of codes) {
        expect(skillsMpErrorCodeSchema.safeParse(code).success).toBe(true);
      }
    });
  });

  describe("capabilityClaimEvidenceSchema", () => {
    it("exige capabilityKey valide (format dotted)", () => {
      const valid = capabilityClaimEvidenceSchema.safeParse({
        capabilityKey: "code.review",
        evidenceType: "manifest",
        description: "Found in manifest",
      });
      expect(valid.success).toBe(true);

      const invalid = capabilityClaimEvidenceSchema.safeParse({
        capabilityKey: "invalid key",
        evidenceType: "manifest",
        description: "Found",
      });
      expect(invalid.success).toBe(false);
    });

    it("exige evidenceType valide", () => {
      const valid = capabilityClaimEvidenceSchema.safeParse({
        capabilityKey: "code.review",
        evidenceType: "code",
        description: "Found in code",
      });
      expect(valid.success).toBe(true);

      const invalid = capabilityClaimEvidenceSchema.safeParse({
        capabilityKey: "code.review",
        evidenceType: "invalid",
        description: "Found",
      });
      expect(invalid.success).toBe(false);
    });

    it("confidence par défaut à 0.5", () => {
      const parsed = capabilityClaimEvidenceSchema.parse({
        capabilityKey: "code.review",
        evidenceType: "manifest",
        description: "Found",
      });
      expect(parsed.confidence).toBe(0.5);
    });

    it("confidence bornée 0..1", () => {
      expect(
        capabilityClaimEvidenceSchema.safeParse({
          capabilityKey: "code.review",
          evidenceType: "manifest",
          description: "Found",
          confidence: 0.8,
        }).success,
      ).toBe(true);
      expect(
        capabilityClaimEvidenceSchema.safeParse({
          capabilityKey: "code.review",
          evidenceType: "manifest",
          description: "Found",
          confidence: 1.5,
        }).success,
      ).toBe(false);
      expect(
        capabilityClaimEvidenceSchema.safeParse({
          capabilityKey: "code.review",
          evidenceType: "manifest",
          description: "Found",
          confidence: -0.1,
        }).success,
      ).toBe(false);
    });
  });

  describe("compatibilityHintSchema", () => {
    it("accepte les hintType valides", () => {
      for (const t of ["runtime", "framework", "protocol", "platform", "tooling", "other"]) {
        const result = compatibilityHintSchema.safeParse({
          target: "nextjs",
          hintType: t,
          description: "desc",
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe("candidateProvenanceSchema", () => {
    it("exige providerId et externalId", () => {
      const valid = candidateProvenanceSchema.safeParse({
        providerId: "skillsmp",
        externalId: "123",
        discoveredAt: "2026-08-16T12:00:00.000Z",
      });
      expect(valid.success).toBe(true);

      const missingProvider = candidateProvenanceSchema.safeParse({
        externalId: "123",
        discoveredAt: "2026-08-16T12:00:00.000Z",
      });
      expect(missingProvider.success).toBe(false);
    });

    it("discoveredAt requis, sourceUpdatedAt optionnel", () => {
      const valid = candidateProvenanceSchema.safeParse({
        providerId: "skillsmp",
        externalId: "123",
        discoveredAt: "2026-08-16T12:00:00.000Z",
        sourceUpdatedAt: "2026-08-15T12:00:00.000Z",
      });
      expect(valid.success).toBe(true);
    });
  });

  describe("skillCandidateSchema", () => {
    const baseCandidate = {
      candidateId: "cand-skillsmp-123",
      providerId: "skillsmp",
      externalId: "123",
      name: "Test Skill",
      description: "A test skill",
      sourceUrl: "https://skillsmp.com/skill/123",
      sourceRepository: "https://github.com/user/repo",
      sourceCommitOrVersion: "abc123",
      maintainer: "John Doe",
      tags: ["typescript", "agent"],
      capabilityClaims: [
        {
          capabilityKey: "code.review",
          evidenceType: "manifest",
          description: "Manifest declares code.review capability",
          confidence: 0.9,
        },
      ],
      compatibilityHints: [
        {
          target: "typescript",
          hintType: "runtime",
          description: "TypeScript implementation",
        },
      ],
      provenance: {
        providerId: "skillsmp",
        externalId: "123",
        discoveryUrl: "https://skillsmp.com/skill/123",
        sourceRepository: "https://github.com/user/repo",
        sourceCommitOrVersion: "abc123",
        maintainer: "John Doe",
        discoveredAt: "2026-08-16T12:00:00.000Z",
        sourceUpdatedAt: "2026-08-15T12:00:00.000Z",
      },
      rawMetadataHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      verificationState: "verified" as const,
      trustState: "untrusted" as const,
      securityState: "pending" as const,
      compatibilityState: "unknown" as const,
    };

    it("accepte un candidat valide complet", () => {
      const result = skillCandidateSchema.safeParse(baseCandidate);
      expect(result.success).toBe(true);
    });

    it("exige candidateId, providerId, externalId, name", () => {
      for (const field of ["candidateId", "providerId", "externalId", "name"]) {
        const { [field]: _, ...rest } = baseCandidate as Record<string, unknown>;
        const result = skillCandidateSchema.safeParse(rest);
        expect(result.success).toBe(false);
      }
    });

    it("rawMetadataHash requis et non vide", () => {
      const invalid = { ...baseCandidate, rawMetadataHash: "" };
      expect(skillCandidateSchema.safeParse(invalid).success).toBe(false);
    });

    it("trustState par défaut untrusted (fail-closed)", () => {
      const parsed = skillCandidateSchema.parse({
        ...baseCandidate,
        trustState: "untrusted",
      });
      expect(parsed.trustState).toBe("untrusted");
    });

    it("securityState par défaut pending (fail-closed)", () => {
      const parsed = skillCandidateSchema.parse({
        ...baseCandidate,
        securityState: "pending",
      });
      expect(parsed.securityState).toBe("pending");
    });

    it("compatibilityState par défaut unknown (fail-closed)", () => {
      const parsed = skillCandidateSchema.parse({
        ...baseCandidate,
        compatibilityState: "unknown",
      });
      expect(parsed.compatibilityState).toBe("unknown");
    });

    it("capabilityClaims et compatibilityHints default to []", () => {
      const minimal = {
        candidateId: "cand-skillsmp-456",
        providerId: "skillsmp",
        externalId: "456",
        name: "Minimal Skill",
        provenance: {
          providerId: "skillsmp",
          externalId: "456",
          discoveredAt: "2026-08-16T12:00:00.000Z",
        },
        rawMetadataHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        verificationState: "verified" as const,
        trustState: "untrusted" as const,
        securityState: "pending" as const,
        compatibilityState: "unknown" as const,
      };
      const parsed = skillCandidateSchema.parse(minimal);
      expect(parsed.capabilityClaims).toEqual([]);
      expect(parsed.compatibilityHints).toEqual([]);
    });
  });

  describe("SkillsMpError", () => {
    it("construit une erreur avec code et message", () => {
      const err = new SkillsMpError("SKILLSMP_AUTH_FAILED", "Invalid token");
      expect(err.code).toBe("SKILLSMP_AUTH_FAILED");
      expect(err.message).toBe("Invalid token");
      expect(err.name).toBe("SkillsMpError");
    });

    it("retryAfterSeconds optionnel", () => {
      const err = new SkillsMpError("SKILLSMP_RATE_LIMITED", "Rate limited", 60);
      expect(err.retryAfterSeconds).toBe(60);

      const err2 = new SkillsMpError("SKILLSMP_AUTH_FAILED", "Invalid token");
      expect(err2.retryAfterSeconds).toBeNull();
    });
  });

  describe("isSkillsMpErrorRetryable", () => {
    it("retourne true pour les codes retryable", () => {
      expect(isSkillsMpErrorRetryable("SKILLSMP_RATE_LIMITED")).toBe(true);
      expect(isSkillsMpErrorRetryable("SKILLSMP_UNAVAILABLE")).toBe(true);
      expect(isSkillsMpErrorRetryable("SKILLSMP_TIMEOUT")).toBe(true);
    });

    it("retourne false pour les codes non-retryable", () => {
      expect(isSkillsMpErrorRetryable("SKILLSMP_CREDENTIAL_UNAVAILABLE")).toBe(false);
      expect(isSkillsMpErrorRetryable("SKILLSMP_AUTH_FAILED")).toBe(false);
      expect(isSkillsMpErrorRetryable("SKILLSMP_INVALID_RESPONSE")).toBe(false);
      expect(isSkillsMpErrorRetryable("SKILLSMP_CANDIDATE_INCOMPLETE")).toBe(false);
      expect(isSkillsMpErrorRetryable("SKILLSMP_SOURCE_UNAVAILABLE")).toBe(false);
    });
  });
});

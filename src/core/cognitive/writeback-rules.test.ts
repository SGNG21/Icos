import { describe, expect, it } from "vitest";

import type {
  CognitiveMemoryType,
  Epistemic,
  MemoryCandidate,
  MemoryRecord,
  MemoryStatus,
  OriginTrust,
  StatementKind,
} from "./contracts";
import { classifyCandidate, decideAgainstExisting } from "./writeback-rules";

describe("writeback-rules", () => {
  const now = new Date("2026-09-29T12:00:00.000Z");

  // Helper to create a base memory record
  const baseMemoryRecord = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
    id: "test-id",
    tenantId: "t1",
    type: "semantic" as CognitiveMemoryType,
    subjectKey: "test-subject",
    entityId: null,
    content: "test content",
    epistemic: "MODEL_INFERRED" as Epistemic,
    statementKind: "fact" as StatementKind,
    status: "active" as MemoryStatus,
    confidence: 0.8,
    originTrust: "trusted" as OriginTrust,
    provenance: {
      sourceType: "turn",
      sourceId: "turn-1",
      conversationId: "conv-1",
      turnId: "turn-1",
      engine: null,
    },
    clientId: null,
    projectId: null,
    ownerUserId: null,
    conversationId: null,
    missionId: null,
    tags: [],
    sensitivity: "normal" as const,
    retention: "standard" as const,
    validFrom: now.toISOString(),
    validUntil: null,
    expiresAt: null,
    supersedesId: null,
    contradictsId: null,
    recordedBy: "system",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    ...overrides,
  });

  // Helper to create a base memory candidate
  const baseMemoryCandidate = (overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
    type: "semantic" as CognitiveMemoryType,
    subjectKey: "test-subject",
    content: "test content",
    epistemic: "MODEL_INFERRED" as Epistemic,
    statementKind: "fact" as StatementKind,
    confidence: 0.8,
    originTrust: "trusted" as OriginTrust,
    provenance: {
      sourceType: "turn",
      sourceId: "turn-1",
      conversationId: "conv-1",
      turnId: "turn-1",
      engine: null,
    },
    ...overrides,
  });

  describe("classifyCandidate", () => {
    it("should reject missing provenance sourceId", () => {
      const candidate = baseMemoryCandidate({
        provenance: {
          ...baseMemoryCandidate().provenance,
          sourceId: undefined as unknown as string,
        },
      });
      const result = classifyCandidate(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result as { reason: string }).reason).toBe("missing_provenance");
      }
    });

    it("should detect secret content", () => {
      const candidate = baseMemoryCandidate({
        content: "sk-abcdefghijklmnopqrstuvwxyz123456", // sk- + 28 chars
      });
      const result = classifyCandidate(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result as { reason: string }).reason).toBe("secret_detected");
      }
    });

    it("should reject invalid confidence", () => {
      let candidate = baseMemoryCandidate({ confidence: -0.1 });
      let result = classifyCandidate(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result as { reason: string }).reason).toBe("invalid_confidence");
      }

      candidate = baseMemoryCandidate({ confidence: 1.1 });
      result = classifyCandidate(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result as { reason: string }).reason).toBe("invalid_confidence");
      }
    });

    it("should convert MODEL_INFERRED fact to inference", () => {
      const candidate = baseMemoryCandidate({
        epistemic: "MODEL_INFERRED",
        statementKind: "fact",
      });
      const result = classifyCandidate(candidate);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(
          (result as { statementKind: StatementKind; confidence: number; status: MemoryStatus })
            .statementKind,
        ).toBe("inference");
        expect((result as { confidence: number }).confidence).toBe(0.6); // capped at 0.6 for MODEL_INFERRED
        expect((result as { status: MemoryStatus }).status).toBe("candidate");
      }
    });

    it("should convert DERIVED to inference", () => {
      const candidate = baseMemoryCandidate({
        epistemic: "DERIVED",
        statementKind: "fact",
      });
      const result = classifyCandidate(candidate);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result as { statementKind: StatementKind }).statementKind).toBe("inference");
        expect((result as { confidence: number }).confidence).toBeCloseTo(0.8, 4); // capped at 0.8 for DERIVED
        expect((result as { status: MemoryStatus }).status).toBe("active"); // DERIVED with trusted origin goes to active
      }
    });

    it("should reject untrusted instruction", () => {
      const candidate = baseMemoryCandidate({
        originTrust: "untrusted",
        statementKind: "instruction",
      });
      const result = classifyCandidate(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result as { reason: string }).reason).toBe("untrusted_instruction");
      }
    });

    it("should reject USER_ASSERTED with tool provenance", () => {
      const candidate = baseMemoryCandidate({
        epistemic: "USER_ASSERTED",
        provenance: {
          sourceType: "tool",
          sourceId: "tool-1",
          conversationId: "conv-1",
          turnId: null,
          engine: null,
        },
      });
      const result = classifyCandidate(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result as { reason: string }).reason).toBe("provenance_mismatch");
      }
    });

    it("should accept valid USER_ASSERTED fact (human API channel only)", () => {
      const candidate = baseMemoryCandidate({
        epistemic: "USER_ASSERTED",
        statementKind: "fact",
        originTrust: "trusted",
        provenance: {
          sourceType: "api",
          sourceId: "user:u1",
          conversationId: null,
          turnId: null,
          engine: null,
        },
      });
      expect(
        classifyCandidate(
          baseMemoryCandidate({ epistemic: "USER_ASSERTED", statementKind: "fact" }),
        ),
      ).toEqual({ ok: false, reason: "provenance_mismatch" }); // a turn/model cannot claim a human assertion
      const result = classifyCandidate(candidate);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result as { statementKind: StatementKind }).statementKind).toBe("fact");
        expect((result as { confidence: number }).confidence).toBe(0.8);
        expect((result as { status: MemoryStatus }).status).toBe("active");
      }
    });

    it("should accept MODEL_INFERRED suggestion", () => {
      const candidate = baseMemoryCandidate({
        epistemic: "MODEL_INFERRED",
        statementKind: "suggestion",
      });
      const result = classifyCandidate(candidate);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result as { statementKind: StatementKind }).statementKind).toBe("suggestion"); // suggestion stays suggestion
        expect((result as { confidence: number }).confidence).toBeCloseTo(0.6, 4);
        expect((result as { status: MemoryStatus }).status).toBe("candidate");
      }
    });
  });

  describe("decideAgainstExisting", () => {
    it("should return duplicate for same content (case/space-insensitive)", () => {
      const existing = [baseMemoryRecord({ id: "existing-1", content: "Hello World" })];
      const candidate = baseMemoryCandidate({
        content: "  hello   world  ", // normalized becomes "hello world"
        type: "semantic",
        epistemic: "USER_ASSERTED",
      });
      const result = decideAgainstExisting(candidate, "active", existing);
      expect(result).toEqual({ kind: "duplicate", existingId: "existing-1" });
    });

    it("should insert for non-single-valued type even if exists", () => {
      const existing = [baseMemoryRecord({ id: "existing-1", type: "episodic" })]; // episodic is multi-valued
      const candidate = baseMemoryCandidate({
        type: "episodic",
        content: "different content",
        epistemic: "USER_ASSERTED",
      });
      const result = decideAgainstExisting(candidate, "active", existing);
      expect(result).toEqual({ kind: "insert" });
    });

    it("should insert when no active record for single-valued type", () => {
      const existing = [baseMemoryRecord({ id: "existing-1", status: "superseded" })]; // not active
      const candidate = baseMemoryCandidate({
        type: "semantic",
        content: "new content",
        epistemic: "USER_ASSERTED",
      });
      const result = decideAgainstExisting(candidate, "candidate", existing);
      expect(result).toEqual({ kind: "insert" });
    });

    it("should supersede when candidate has sufficient rank", () => {
      const existing = [baseMemoryRecord({ id: "existing-1", epistemic: "MODEL_INFERRED" })]; // rank 1
      const candidate = baseMemoryCandidate({
        content: "updated content",
        type: "semantic",
        epistemic: "SYSTEM_OBSERVED", // rank 3 >= SUPERSEDE_MIN_RANK (3) and >= existing rank (1)
      });
      const result = decideAgainstExisting(candidate, "active", existing);
      expect(result).toEqual({ kind: "supersede", previousId: "existing-1" });
    });

    it("should not supersede when candidate rank too low", () => {
      const existing = [baseMemoryRecord({ id: "existing-1", epistemic: "SYSTEM_OBSERVED" })]; // rank 3
      const candidate = baseMemoryCandidate({
        content: "updated content",
        type: "semantic",
        epistemic: "MODEL_INFERRED", // rank 1 < SUPERSEDE_MIN_RANK (3)
      });
      const result = decideAgainstExisting(candidate, "active", existing);
      expect(result).toEqual({ kind: "conflict", conflictsWith: "existing-1" });
    });

    it("should not supersede when existing rank higher", () => {
      const existing = [baseMemoryRecord({ id: "existing-1", epistemic: "USER_ASSERTED" })]; // rank 4
      const candidate = baseMemoryCandidate({
        content: "updated content",
        type: "semantic",
        epistemic: "SYSTEM_OBSERVED", // rank 3 < existing rank (4)
      });
      const result = decideAgainstExisting(candidate, "active", existing);
      expect(result).toEqual({ kind: "conflict", conflictsWith: "existing-1" });
    });

    it("episodic: identical content is a duplicate (idempotent writeback), different content is inserted, never a conflict", () => {
      const existing = [
        baseMemoryRecord({
          id: "ep-1",
          type: "episodic",
          content: "Même   Observation",
          epistemic: "USER_ASSERTED",
        }),
      ];
      expect(
        decideAgainstExisting(
          baseMemoryCandidate({ type: "episodic", content: "même observation" }),
          "candidate",
          existing,
        ),
      ).toEqual({ kind: "duplicate", existingId: "ep-1" });
      expect(
        decideAgainstExisting(
          baseMemoryCandidate({ type: "episodic", content: "autre observation" }),
          "candidate",
          existing,
        ),
      ).toEqual({ kind: "insert" });
    });

    it("a tool never silently overrides a human; a human may correct a tool", () => {
      const human = [
        baseMemoryRecord({ id: "h-1", epistemic: "USER_ASSERTED", content: "HubSpot" }),
      ];
      expect(
        decideAgainstExisting(
          baseMemoryCandidate({ epistemic: "TOOL_CONFIRMED", content: "Pipedrive" }),
          "active",
          human,
        ),
      ).toEqual({ kind: "conflict", conflictsWith: "h-1" });
      const tool = [
        baseMemoryRecord({ id: "t-1", epistemic: "TOOL_CONFIRMED", content: "HubSpot" }),
      ];
      expect(
        decideAgainstExisting(
          baseMemoryCandidate({ epistemic: "USER_ASSERTED", content: "Pipedrive" }),
          "active",
          tool,
        ),
      ).toEqual({ kind: "supersede", previousId: "t-1" });
    });

    it("untrusted instruction is rejected even when a model labelled it (no laundering into an inference)", () => {
      expect(
        classifyCandidate(
          baseMemoryCandidate({
            epistemic: "MODEL_INFERRED",
            originTrust: "untrusted",
            statementKind: "instruction",
          }),
        ),
      ).toEqual({ ok: false, reason: "untrusted_instruction" });
    });

    it("should handle USER_ASSERTED over active MODEL_INFERRED => supersede", () => {
      const existing = [
        baseMemoryRecord({ id: "existing-1", epistemic: "MODEL_INFERRED", content: "old content" }),
      ];
      const candidate = baseMemoryCandidate({
        type: "semantic",
        content: "new content",
        epistemic: "USER_ASSERTED", // rank 4 > MODEL_INFERRED rank 1
      });
      const result = decideAgainstExisting(candidate, "active", existing);
      expect(result).toEqual({ kind: "supersede", previousId: "existing-1" });
    });

    it("should handle MODEL_INFERRED (status candidate) vs active USER_ASSERTED => conflict", () => {
      const existing = [
        baseMemoryRecord({
          id: "existing-1",
          epistemic: "USER_ASSERTED",
          content: "existing content",
        }),
      ];
      const candidate = baseMemoryCandidate({
        type: "semantic",
        content: "new content",
        epistemic: "MODEL_INFERRED",
        originTrust: "untrusted", // This makes it candidate status
      });
      const result = decideAgainstExisting(candidate, "candidate", existing);
      expect(result).toEqual({ kind: "conflict", conflictsWith: "existing-1" });
    });

    it("should handle SYSTEM_OBSERVED vs active USER_ASSERTED => conflict", () => {
      const existing = [
        baseMemoryRecord({
          id: "existing-1",
          epistemic: "USER_ASSERTED",
          content: "existing content",
        }),
      ];
      const candidate = baseMemoryCandidate({
        type: "semantic",
        content: "new content",
        epistemic: "SYSTEM_OBSERVED", // rank 3 < USER_ASSERTED rank 4
      });
      const result = decideAgainstExisting(candidate, "active", existing);
      expect(result).toEqual({ kind: "conflict", conflictsWith: "existing-1" });
    });
  });
});

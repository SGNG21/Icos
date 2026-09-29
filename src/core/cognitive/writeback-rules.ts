import { containsSecret } from "@/core/memory";

import type {
  CognitiveMemoryType,
  Epistemic,
  MemoryCandidate,
  MemoryRecord,
  MemoryStatus,
  StatementKind,
} from "./contracts";

/**
 * Governed memory writeback — pure decision rules (decision 0056).
 *
 * candidate → classify → provenance → confidence → deduplicate → contradiction check
 * → accept / reject / update(supersede) / hold as conflict.
 *
 * The store applies these decisions inside one transaction under an advisory lock.
 */

/**
 * Authority used to settle contradictions. A model never outranks a human or a tool, and
 * a tool never silently overrides a human (it lands as a conflict for review).
 */
export const EPISTEMIC_RANK: Record<Epistemic, number> = {
  USER_ASSERTED: 5,
  TOOL_CONFIRMED: 4,
  SYSTEM_OBSERVED: 3,
  DERIVED: 2,
  MODEL_INFERRED: 1,
};

/** Minimum rank allowed to replace an active record without human review. */
const SUPERSEDE_MIN_RANK = 3;

const CONFIDENCE_CAP: Partial<Record<Epistemic, number>> = { MODEL_INFERRED: 0.6, DERIVED: 0.8 };

/** Types where one subject has one current truth (a new value contradicts the old one). */
export const SINGLE_VALUED_TYPES: ReadonlySet<CognitiveMemoryType> = new Set([
  "semantic",
  "entity",
  "decision",
  "procedural",
  "project",
  "self",
]);

export type Classified =
  | {
      readonly ok: true;
      readonly statementKind: StatementKind;
      readonly confidence: number;
      readonly status: Extract<MemoryStatus, "active" | "candidate">;
    }
  | { readonly ok: false; readonly reason: string };

export function classifyCandidate(c: MemoryCandidate): Classified {
  if (!c.provenance?.sourceId) return { ok: false, reason: "missing_provenance" };
  if (containsSecret(c.content)) return { ok: false, reason: "secret_detected" };
  if (!(c.confidence >= 0 && c.confidence <= 1)) return { ok: false, reason: "invalid_confidence" };

  // Retrieved/tool text is a prompt-injection surface: an instruction from it is refused
  // outright (checked BEFORE any re-labelling, so it cannot be laundered as an inference).
  if (c.originTrust === "untrusted" && c.statementKind === "instruction") {
    return { ok: false, reason: "untrusted_instruction" };
  }
  let statementKind = c.statementKind;
  // A model can only infer or suggest; it cannot state facts or issue instructions.
  if (c.epistemic === "MODEL_INFERRED" && statementKind !== "suggestion")
    statementKind = "inference";
  if (c.epistemic === "DERIVED") statementKind = "inference";
  // USER_ASSERTED is only ever produced by an authenticated human through the API.
  if (c.epistemic === "USER_ASSERTED" && c.provenance.sourceType !== "api") {
    return { ok: false, reason: "provenance_mismatch" };
  }

  const cap = CONFIDENCE_CAP[c.epistemic] ?? 1;
  const confidence = Math.min(c.confidence, cap);
  const status =
    c.epistemic === "MODEL_INFERRED" || c.originTrust === "untrusted" ? "candidate" : "active";
  return { ok: true, statementKind, confidence, status };
}

export const normalizeContent = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export type ExistingDecision =
  | { readonly kind: "insert" }
  | { readonly kind: "duplicate"; readonly existingId: string }
  | { readonly kind: "supersede"; readonly previousId: string }
  | { readonly kind: "conflict"; readonly conflictsWith: string };

/**
 * Compare a classified candidate with what already exists for the same subject in the
 * same scope (active and candidate records). Never overwrites a stronger truth.
 */
export function decideAgainstExisting(
  candidate: Pick<MemoryCandidate, "type" | "content" | "epistemic">,
  status: "active" | "candidate",
  existing: readonly Pick<MemoryRecord, "id" | "content" | "epistemic" | "status">[],
): ExistingDecision {
  const norm = normalizeContent(candidate.content);
  const same = existing.find((e) => normalizeContent(e.content) === norm);
  if (same) return { kind: "duplicate", existingId: same.id };
  if (!SINGLE_VALUED_TYPES.has(candidate.type)) return { kind: "insert" };

  const active = existing.find((e) => e.status === "active");
  if (!active) return { kind: "insert" };
  const rank = EPISTEMIC_RANK[candidate.epistemic];
  if (
    status === "active" &&
    rank >= SUPERSEDE_MIN_RANK &&
    rank >= EPISTEMIC_RANK[active.epistemic]
  ) {
    return { kind: "supersede", previousId: active.id };
  }
  return { kind: "conflict", conflictsWith: active.id };
}

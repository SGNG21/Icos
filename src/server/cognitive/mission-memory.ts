import type { CognitiveScope, MemoryCandidate, WritebackOutcome } from "@/core/cognitive/contracts";

/**
 * MISSION MEMORY (decision 0067 item 8; design in docs/icos/mission-memory-integration.md).
 *
 * Conversation turns write memory; mission settlement does not. A settled mission wrote zero
 * `memory_records` on the live system, so ICOS could execute work and then not remember
 * having done it. This is the one durable record a settlement leaves behind.
 *
 * It is a WRITER, not a hook: it knows nothing about the supervisor, the sweep or the
 * settlement lock. The critical path calls it once with facts it already holds; this file
 * only decides what the record says and guarantees that saying it twice writes it once.
 */
export interface MissionSettlementFact {
  readonly missionId: string;
  readonly goalId: string | null;
  readonly title: string;
  /** CORE3's terminal status, verbatim. */
  readonly outcome: "succeeded" | "failed" | "cancelled";
  /** The independent reviewer's verdict when one was given. */
  readonly reviewVerdict: string | null;
  /** Where the result lives (workspace branch, artifact id, result row). Never the content. */
  readonly resultRef: string | null;
  /** From the goal's launch metadata, so the memory lands in the client's scope. */
  readonly clientId: string | null;
  readonly projectId: string | null;
  readonly settledAt: string;
}

/** `mission.<id>.outcome`: one subject per mission, so a replay supersedes nothing and duplicates nothing. */
export const missionOutcomeSubjectKey = (missionId: string) => `mission.${missionId}.outcome`;

/** The record as the model will later read it. Deterministic: same fact, same text. */
export function renderMissionOutcome(f: MissionSettlementFact): string {
  const verdict = f.reviewVerdict ? `, revue ${f.reviewVerdict}` : ", sans revue";
  const result = f.resultRef ? ` Résultat : ${f.resultRef}.` : "";
  const goal = f.goalId ? ` (objectif ${f.goalId})` : "";
  return `Mission « ${f.title} »${goal} ${f.outcome === "succeeded" ? "réussie" : f.outcome === "failed" ? "échouée" : "annulée"}${verdict}, le ${f.settledAt}.${result}`;
}

export function missionOutcomeCandidate(f: MissionSettlementFact): MemoryCandidate {
  return {
    type: "episodic",
    subjectKey: missionOutcomeSubjectKey(f.missionId),
    content: renderMissionOutcome(f),
    // Read from CORE3's own tables: observed by the system, not inferred by a model.
    epistemic: "SYSTEM_OBSERVED",
    statementKind: "fact",
    confidence: 1,
    originTrust: "trusted",
    provenance: {
      sourceType: "mission",
      sourceId: f.missionId,
      conversationId: null,
      turnId: null,
      engine: null,
    },
    missionId: f.missionId,
    tags: ["mission", f.outcome],
    // A settled mission is history worth keeping past the standard window.
    retention: "long_term",
  };
}

export interface MissionMemoryPort {
  write(scope: CognitiveScope, candidate: MemoryCandidate): Promise<WritebackOutcome>;
}

/**
 * Idempotent on the mission: the subject key is the mission id and the content is a pure
 * function of the fact, so the memory store's own duplicate detection (same subject, same
 * normalized content, same scope) makes a replayed settlement a `duplicate`, never a second
 * row. A failure here is reported, never thrown: memory must not un-settle a mission.
 */
export async function recordMissionSettlement(
  memory: MissionMemoryPort,
  tenantId: string,
  userId: string,
  fact: MissionSettlementFact,
): Promise<WritebackOutcome> {
  const scope: CognitiveScope = {
    tenantId,
    userId,
    clientId: fact.clientId,
    projectId: fact.projectId,
  };
  try {
    return await memory.write(scope, missionOutcomeCandidate(fact));
  } catch (error) {
    return {
      kind: "rejected",
      reason: `write_failed: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        300,
      ),
    };
  }
}

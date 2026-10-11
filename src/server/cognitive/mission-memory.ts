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
  readonly outcome: "succeeded" | "failed" | "cancelled" | "blocked";
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
  const outcome = {
    succeeded: "réussie",
    failed: "échouée",
    cancelled: "annulée",
    blocked: "bloquée",
  }[f.outcome];
  return `Mission « ${f.title} »${goal} ${outcome}${verdict}, le ${f.settledAt}.${result}`;
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

/** Terminal mission statuses a settlement memory is written for (CORE3 `TERMINAL_MISSION_STATUSES`). */
const SETTLED: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "blocked"]);

/**
 * THE PRODUCTION SETTLEMENT HOOK (decision 0067 item 8, wired by decision 0063 amendment A).
 *
 * Called by the supervisor's terminal-settlement seam right after CORE3 moved the mission to a
 * terminal status. Everything it writes comes from CORE3's own tables: the mission (title,
 * status), its goal's scope (`ExecutionScopeReader` — so the memory lands in the client's scope
 * and nowhere else), and the last review verdict. It NEVER throws: a memory failure must not
 * un-settle a mission or block the workforce release that shares the seam.
 */
export function missionSettlementRecorder(deps: {
  readonly missions: {
    findById(
      id: string,
    ): Promise<{ id: string; title: string; status: string; updatedAt: Date } | null>;
  };
  readonly scope: {
    forMission(missionId: string): Promise<{
      tenantId: string;
      clientId: string | null;
      projectId: string | null;
      goalId: string | null;
    } | null>;
  };
  readonly reviews?: {
    listByMissionId(missionId: string): Promise<{ decision: string; createdAt: string }[]>;
  };
  readonly memory: MissionMemoryPort;
  readonly log?: (line: string) => void;
}): (missionId: string) => Promise<WritebackOutcome | null> {
  const log = deps.log ?? ((line: string) => console.error(line));
  return async (missionId) => {
    try {
      const mission = await deps.missions.findById(missionId);
      if (!mission || !SETTLED.has(mission.status)) return null;
      const scope = await deps.scope.forMission(missionId);
      if (!scope) return null;
      const reviews = deps.reviews ? await deps.reviews.listByMissionId(missionId) : [];
      const last = [...reviews].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      const outcome = await recordMissionSettlement(
        deps.memory,
        scope.tenantId,
        "system:mission-settlement",
        {
          missionId,
          goalId: scope.goalId,
          title: mission.title,
          outcome: mission.status as MissionSettlementFact["outcome"],
          reviewVerdict: last?.decision ?? null,
          resultRef: null,
          clientId: scope.clientId,
          projectId: scope.projectId,
          // The moment CORE3 wrote the terminal status: deterministic, so a replayed
          // settlement renders the same text and is a `duplicate`, never a second row.
          settledAt: mission.updatedAt.toISOString(),
        },
      );
      if (outcome.kind === "rejected") {
        log(
          JSON.stringify({ event: "MISSION_MEMORY_REJECTED", missionId, reason: outcome.reason }),
        );
      }
      return outcome;
    } catch (error) {
      log(
        JSON.stringify({
          event: "MISSION_MEMORY_FAILED",
          missionId,
          error: `${error instanceof Error ? error.name : "Error"}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
        }),
      );
      return null;
    }
  };
}

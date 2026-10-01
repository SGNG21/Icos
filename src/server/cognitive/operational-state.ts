import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { CognitiveScope } from "@/core/cognitive/contracts";
import type { ContextCandidate } from "@/core/cognitive/context-selection";
import type { Database } from "@/server/database/client";
import { goals, missions, missionTasks } from "@/server/database/schema";

import type { SelfModelSource } from "./context-assembler";

/**
 * Live operational state: what is actually running, and what is stuck
 * (decision 0062, executive conversation).
 *
 * Without this, "on en est où ?" could only be answered from conversational
 * prose — which is how ICOS ended up reporting its own stale statements as
 * current truth. Missions and blockers are read from the tables that CORE3
 * writes, so the answer is a measurement.
 *
 * These are FACTS about the system, so they enter as `runtime` stage /
 * `TOOL_CONFIRMED`, above any recollection.
 *
 * SCOPED TO THE RESOLVED CLIENT (decision 0063). This stage once filtered on the asking
 * user alone, which was harmless only while `scope.clientId` was always null. Once client
 * resolution became real, a conversation resolved to one client still received the OTHER
 * clients' mission titles here — at `runtime` stage with `anchored: true`, so never even
 * relevance-gated — defeating for this one stage the isolation every other stage enforces.
 * A mission carries no client column of its own; its client is the one its goal was
 * launched under (`goals.metadata.clientId`, written by `CanonicalGoalLauncher`). A mission
 * that cannot be attributed to the resolved client is therefore left out: unattributable is
 * read as "not this client's", which is the fail-closed answer. An UNSCOPED conversation is
 * unchanged and still sees the user's whole open workload.
 */

/** Statuses worth telling a human about unprompted. A finished mission is history. */
const OPEN = ["draft", "queued", "running", "blocked", "awaiting_approval"] as const;
const BLOCKED_TASK = ["blocked", "awaiting_approval", "failed"] as const;

const MAX_MISSIONS = 6;

export class OperationalStateSource implements SelfModelSource {
  constructor(private readonly db: Database) {}

  /** Scoped to the asking user AND to the resolved client: never shared across either. */
  async candidates(scope: CognitiveScope, now: Date): Promise<ContextCandidate[]> {
    /*
     * The join is LEFT so an unscoped conversation still sees a mission whose goal row is
     * gone; adding the metadata predicate below makes it behave as an inner join exactly
     * when a client is resolved, which is when an unattributable mission must drop out.
     */
    const rows = await this.db
      .select({
        id: missions.id,
        title: missions.title,
        status: missions.status,
        updatedAt: missions.updatedAt,
      })
      .from(missions)
      .leftJoin(goals, eq(goals.goalId, missions.goalId))
      .where(
        and(
          eq(missions.userId, scope.userId),
          inArray(missions.status, [...OPEN]),
          ...(scope.clientId ? [sql`${goals.metadata}->>'clientId' = ${scope.clientId}`] : []),
          ...(scope.projectId ? [sql`${goals.metadata}->>'projectId' = ${scope.projectId}`] : []),
        ),
      )
      .orderBy(desc(missions.updatedAt))
      .limit(MAX_MISSIONS);

    if (rows.length === 0) {
      return [
        {
          stage: "runtime",
          kind: "runtime_state",
          ref: "runtime:missions.none",
          // Says WHICH perimeter is empty: "no open mission" for one client would otherwise
          // read as "nothing is running at all" to the owner.
          text: scope.clientId
            ? `Aucune mission ouverte en cours pour ce client (${scope.clientId}).`
            : "Aucune mission ouverte en cours.",
          anchored: true,
          entityIds: [],
          occurredAt: now.toISOString(),
          confidence: 1,
          epistemic: "TOOL_CONFIRMED",
          trust: "trusted",
        },
      ];
    }

    const blocked = await this.db
      .select({ missionId: missionTasks.missionId, n: sql<number>`count(*)` })
      .from(missionTasks)
      .where(
        and(
          inArray(
            missionTasks.missionId,
            rows.map((r) => r.id),
          ),
          inArray(missionTasks.status, [...BLOCKED_TASK]),
        ),
      )
      .groupBy(missionTasks.missionId);
    const blockedBy = new Map(blocked.map((b) => [b.missionId, Number(b.n)]));

    return rows.map((mission) => {
      const stuck = blockedBy.get(mission.id) ?? 0;
      return {
        stage: "runtime" as const,
        kind: "runtime_state" as const,
        ref: `runtime:mission.${mission.id}`,
        text:
          `Mission ouverte « ${mission.title} » — statut ${mission.status}` +
          (stuck > 0 ? `, ${stuck} tâche(s) en attente ou bloquée(s)` : "") +
          `, id ${mission.id}`,
        anchored: true,
        entityIds: [],
        occurredAt: new Date(mission.updatedAt).toISOString(),
        confidence: 1,
        epistemic: "TOOL_CONFIRMED" as const,
        trust: "trusted" as const,
      };
    });
  }
}

/** Both overlays behind one source, so the assembler keeps a single seam. */
export class CombinedSelfModel implements SelfModelSource {
  constructor(private readonly sources: readonly SelfModelSource[]) {}

  async candidates(scope: CognitiveScope, now: Date): Promise<ContextCandidate[]> {
    const all = await Promise.all(
      // One failing overlay must not cost the others; a missing overlay is silence,
      // never an invented fact.
      this.sources.map((s) => s.candidates(scope, now).catch(() => [] as ContextCandidate[])),
    );
    return all.flat();
  }
}

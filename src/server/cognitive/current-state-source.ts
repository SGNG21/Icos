import type { CognitiveScope, GoalProposal, RefStatus } from "@/core/cognitive/contracts";
import type { ContextCandidate } from "@/core/cognitive/context-selection";

import { systemClock, type Clock, type PostgresConversationStore } from "./conversation-store";

/**
 * CURRENT state of the client's work, read live at assembly time (decision 0063) — never a
 * remembered claim. Items produced here carry `live: true` and a `subject`, so
 * `applyTemporalPrecedence` drops any durable memory speaking about the same mission: a
 * finished mission can no longer be presented as running because an older turn said it was.
 */
export interface CurrentStateSource {
  candidates(scope: CognitiveScope): Promise<ContextCandidate[]>;
}

/** Mission status reader. `MissionRepository.findById` satisfies it; absent ⇒ launch state only. */
export interface MissionStatusReader {
  findById(id: string): Promise<{ status: string } | null>;
}

/** Proposal states that represent work ICOS has actually committed to for a client. */
const LIVE_STATUSES: readonly RefStatus[] = ["approved", "launching", "launched"];

/**
 * Live state from the canonical sources only: the conversation's own proposal/launch ledger
 * (`cognitive_turn_refs`, scoped by the client the proposal was made under) joined with the
 * mission's CURRENT status from CORE3's repository. This reads CORE3; it never drives it.
 */
export class LaunchedMissionStateSource implements CurrentStateSource {
  constructor(
    private readonly conversations: Pick<PostgresConversationStore, "refsForClient">,
    private readonly missions: MissionStatusReader | null,
    private readonly clock: Clock = systemClock,
  ) {}

  async candidates(scope: CognitiveScope): Promise<ContextCandidate[]> {
    /*
     * Un scope sans client n'est PAS un scope vide : tout objectif interne ("Améliore ICOS")
     * est sans client, et ce retour anticipé l'empêchait de rapporter son propre état vivant —
     * exactement l'interaction visée. On lit alors les refs sans client de ce tenant.
     */
    const refs = await this.conversations.refsForClient(
      scope.tenantId,
      scope.clientId ?? null,
      LIVE_STATUSES,
    );
    const out: ContextCandidate[] = [];
    for (const ref of refs) {
      if (ref.kind !== "goal_proposal") continue;
      if (scope.projectId !== null && ref.projectId !== null && ref.projectId !== scope.projectId) {
        continue;
      }
      const goal = ref.payload as GoalProposal;
      const status = ref.missionId ? await this.statusOf(ref.missionId) : null;
      /**
       * `live` is claimed ONLY when a real mission status was read. Without it all we know is
       * that the proposal reached `launched` — which is not a mission state — so the item is
       * offered as ordinary context and must NOT suppress a memory that may know better
       * (a memory saying « completed » would otherwise be hidden behind « launched »).
       */
      const live = status !== null;
      out.push({
        stage: "current",
        kind: "current_state",
        ref: `mission:${ref.missionId ?? ref.id}`,
        text: live
          ? `Mission « ${goal.title} » — état courant : ${status} (mission ${ref.missionId})`
          : `Mission « ${goal.title} » — proposition ${ref.status}${
              ref.missionId ? ` (mission ${ref.missionId}, état CORE3 non disponible)` : ""
            }`,
        anchored: true,
        entityIds: [],
        // Read now: a live reading is never discounted for age.
        occurredAt: this.clock.now().toISOString(),
        confidence: 1,
        epistemic: "SYSTEM_OBSERVED",
        trust: "trusted",
        ...(live ? { subject: `mission:${ref.missionId}`, live: true } : {}),
      });
    }
    return out;
  }

  /** A missing or unreadable mission degrades to the launch state; it never invents one. */
  private async statusOf(missionId: string): Promise<string | null> {
    if (!this.missions) return null;
    try {
      return (await this.missions.findById(missionId))?.status ?? null;
    } catch {
      return null;
    }
  }
}

import type { AuditEntry } from "@/core/contracts/audit";

/**
 * HUMAN INTERVENTION LEDGER (BR-07).
 *
 * A human-actor audit entry is only a PROXY for an intervention: logging in, reading the
 * audit, or administering a user is not autonomy debt. An intervention is a human act that a
 * mission NEEDED to progress. The canonical writers of such acts tag their entries with these
 * details, and the cockpit counts the tag — never the proxy — as debt. The tag lives in
 * `details` so the append-only journal and its schema are untouched.
 */
export const INTERVENTION_FLAG = "intervention" as const;
export const INTERVENTION_REASON = "interventionReason" as const;

export const INTERVENTION_REASONS = [
  /** A human approved or rejected an action a task was waiting on. */
  "APPROVAL_DECISION",
  /** A human issued a governed control command (safe mode, holds, retries, flags). */
  "CONTROL_COMMAND",
  /** A human changed a task's state by hand. */
  "MANUAL_TRANSITION",
] as const;
export type InterventionReason = (typeof INTERVENTION_REASONS)[number];

/** Details to spread into the audit entry of a human act a mission depended on. */
export function interventionDetails(reason: InterventionReason): {
  readonly intervention: true;
  readonly interventionReason: InterventionReason;
} {
  return { [INTERVENTION_FLAG]: true, [INTERVENTION_REASON]: reason };
}

/** True only for TAGGED entries: an untagged human entry stays a proxy, counted apart. */
export function isIntervention(entry: Pick<AuditEntry, "actor" | "details">): boolean {
  return entry.actor.kind === "human" && entry.details?.[INTERVENTION_FLAG] === true;
}

export interface InterventionLedger {
  /** Tagged interventions (BR-07): the measured autonomy debt. */
  readonly tagged: number;
  /** Human-actor entries outside `auth.*` that carry no tag: the legacy proxy, shown apart. */
  readonly untaggedProxy: number;
  readonly byReason: Readonly<Record<InterventionReason, number>>;
  /** Missions that needed at least one tagged intervention (when the entry names one). */
  readonly missionsWithDebt: number;
}

export function interventionLedger(
  entries: ReadonlyArray<Pick<AuditEntry, "actor" | "details" | "eventType">>,
): InterventionLedger {
  const byReason: Record<InterventionReason, number> = {
    APPROVAL_DECISION: 0,
    CONTROL_COMMAND: 0,
    MANUAL_TRANSITION: 0,
  };
  let tagged = 0;
  let untaggedProxy = 0;
  const missions = new Set<string>();
  for (const e of entries) {
    if (e.actor.kind !== "human" || e.eventType.startsWith("auth.")) continue;
    if (isIntervention(e)) {
      tagged += 1;
      const reason = e.details?.[INTERVENTION_REASON];
      if (typeof reason === "string" && reason in byReason)
        byReason[reason as InterventionReason] += 1;
      const missionId = e.details?.missionId;
      if (typeof missionId === "string") missions.add(missionId);
    } else {
      untaggedProxy += 1;
    }
  }
  return { tagged, untaggedProxy, byReason, missionsWithDebt: missions.size };
}

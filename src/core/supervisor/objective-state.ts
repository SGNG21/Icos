import type { ObjectiveState } from "./contracts";

/**
 * Derived objective lifecycle (decision 0065). PURE and PERSISTED NOWHERE.
 *
 * Every call recomputes the state from the rows that other subsystems own, so there is no
 * second lifecycle to reconcile after a restart and no way for this layer's view to drift
 * from the mission's. `null` means "could not be read" and produces DEGRADED with the
 * field named in `unknown` — never a plausible substitute, and never RECEIVED, which is a
 * different fact (nothing has been launched yet).
 */

/**
 * The runner's OWN state vocabulary (`AutonomousRuntimeState`, server/autonomy/runtime.ts).
 * Listed here so a future rename breaks a test instead of silently making a branch dead:
 * an earlier version of this file matched on "recovering", which the runner never emits,
 * and RECOVERING was therefore unreachable in production.
 */
export const RUNNER_STATES = [
  "running",
  "waiting",
  "replanning",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "escalated",
] as const;

export interface ObjectiveStateInput {
  readonly goalStatus: string;
  readonly missionId: string | null;
  /** `null` with a non-null `missionId` ⇒ the mission row could not be read. */
  readonly mission: { readonly status: string } | null;
  /** `null` ⇒ the task rows could not be read. */
  readonly tasks: readonly { readonly status: string }[] | null;
  /**
   * The autonomous runtime row. `null` ⇒ absent or unreadable, which is DEGRADED for a
   * RUNNING mission (we should know what is driving it) and unremarkable otherwise.
   *
   * `leaseExpired` is how recovery becomes visible: the runner holds a lease while it owns
   * a mission, and a lapsed lease is precisely the condition the recovery sweepers reclaim.
   * There is no runner state called "recovering" to match on.
   */
  readonly runtime: { readonly state: string; readonly leaseExpired?: boolean } | null;
  readonly pendingApproval: boolean;
  /** `null` ⇒ control state unreadable. NEVER coerced to false: that would assert "not held". */
  readonly controlHeld: boolean | null;
  /**
   * Non-terminal tasks carrying a REQUEST_CHANGES/RETRY review decision and NOT yet
   * re-running. `null` ⇒ review history unavailable, so REPAIRING is never claimed.
   */
  readonly tasksAwaitingRepair: number | null;
}

export interface ObjectiveStateResult {
  readonly state: ObjectiveState;
  readonly phase: string;
  readonly blockedReason: string | null;
  readonly unknown: readonly string[];
}

const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled", "superseded"]);

export function deriveObjectiveState(input: ObjectiveStateInput): ObjectiveStateResult {
  const unknown: string[] = [];
  const done = (
    state: ObjectiveState,
    phase: string,
    blockedReason: string | null = null,
  ): ObjectiveStateResult => ({ state, phase, blockedReason, unknown });

  if (input.missionId === null) {
    return done("RECEIVED", "intake");
  }

  if (input.mission === null) {
    unknown.push("mission");
    return done("DEGRADED", "unknown", "mission_unreadable");
  }

  if (input.mission.status === "succeeded") return done("COMPLETED", "settled");
  if (input.mission.status === "failed") return done("FAILED", "settled");
  if (input.mission.status === "cancelled") return done("CANCELLED", "settled");

  if (input.tasks === null) {
    unknown.push("tasks");
    return done("DEGRADED", "unknown", "tasks_unreadable");
  }

  /*
   * A mission that is RUNNING is being driven by something. Not knowing what is a gap in
   * the picture, not a quiet "fine": it is exactly the case where an operator most needs
   * to be told the view is incomplete.
   */
  if (input.mission.status === "running" && input.runtime === null) {
    unknown.push("runtime");
    return done("DEGRADED", "unknown", "runtime_unreadable");
  }

  if (input.controlHeld === null) {
    unknown.push("controlHold");
    return done("DEGRADED", "unknown", "control_state_unreadable");
  }
  if (input.tasksAwaitingRepair === null) unknown.push("repairState");

  // A hold outranks every running description: the work is stopped, whatever it was doing.
  if (input.controlHeld) return done("BLOCKED", "held", "control_hold");
  if (input.mission.status === "blocked") return done("BLOCKED", "blocked", "mission_blocked");

  /*
   * A lapsed lease means no runner owns this mission right now and a sweeper will reclaim
   * it. Reporting EXECUTING here would tell an operator work is progressing when it is
   * stalled, which is the single most misleading thing this projection could say.
   */
  if (input.runtime?.leaseExpired === true) return done("RECOVERING", "recovery");

  if (input.runtime?.state === "escalated" || input.pendingApproval ||
      input.mission.status === "awaiting_approval") {
    return done("WAITING_FOR_HUMAN", "approval");
  }

  if (input.runtime?.state === "replanning") return done("PLANNING", "replanning");
  if (input.mission.status === "draft") return done("CONTEXTUALIZED", "contextualisation");
  if (input.mission.status === "planning") return done("PLANNING", "planning");

  if (input.tasks.some((t) => t.status === "review_pending")) return done("REVIEWING", "review");
  // EXECUTING outranks REPAIRING: a repair that is already re-running IS execution.
  if (input.tasks.some((t) => t.status === "running")) return done("EXECUTING", "execution");
  if ((input.tasksAwaitingRepair ?? 0) > 0) return done("REPAIRING", "repair");

  if (input.tasks.length > 0 && input.tasks.every((t) => TERMINAL_TASK_STATUSES.has(t.status))) {
    return done("DECISION_READY", "settlement");
  }

  return done("DELEGATING", "delegation");
}

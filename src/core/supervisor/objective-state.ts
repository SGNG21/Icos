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

export interface ObjectiveStateInput {
  readonly goalStatus: string;
  readonly missionId: string | null;
  /** `null` with a non-null `missionId` ⇒ the mission row could not be read. */
  readonly mission: { readonly status: string } | null;
  /** `null` ⇒ the task rows could not be read. */
  readonly tasks: readonly { readonly status: string }[] | null;
  readonly runtime: { readonly state: string } | null;
  readonly pendingApproval: boolean;
  readonly controlHeld: boolean;
  /**
   * Non-terminal tasks carrying a REQUEST_CHANGES/RETRY review decision. `null` ⇒ review
   * history unavailable, so REPAIRING is never claimed.
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
const RECOVERING_RUNTIME_STATES = new Set(["recovering", "recovery", "resuming"]);

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
  if (input.tasksAwaitingRepair === null) unknown.push("repairState");

  // A hold outranks every running description: the work is stopped, whatever it was doing.
  if (input.controlHeld) return done("BLOCKED", "held", "control_hold");
  if (input.mission.status === "blocked") return done("BLOCKED", "blocked", "mission_blocked");

  if (input.pendingApproval || input.mission.status === "awaiting_approval") {
    return done("WAITING_FOR_HUMAN", "approval");
  }

  if (input.runtime && RECOVERING_RUNTIME_STATES.has(input.runtime.state)) {
    return done("RECOVERING", "recovery");
  }

  if (input.mission.status === "draft") return done("CONTEXTUALIZED", "contextualisation");
  if (input.mission.status === "planning") return done("PLANNING", "planning");

  if (input.tasks.some((t) => t.status === "review_pending")) return done("REVIEWING", "review");
  if ((input.tasksAwaitingRepair ?? 0) > 0) return done("REPAIRING", "repair");
  if (input.tasks.some((t) => t.status === "running")) return done("EXECUTING", "execution");

  if (input.tasks.length > 0 && input.tasks.every((t) => TERMINAL_TASK_STATUSES.has(t.status))) {
    return done("DECISION_READY", "settlement");
  }

  return done("DELEGATING", "delegation");
}

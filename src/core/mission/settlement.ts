/**
 * WHEN IS A MISSION FINISHED? One predicate, asked before anything is spent.
 *
 * Settlement used to exist only at the very end of `SupervisorService.run()`. That made it
 * unreachable for exactly the missions that needed it: the autonomous runner checks its
 * wall-clock budget at the TOP of its loop, measured from a `startedAt` that is never
 * reset, so once a runtime passed `maxRuntimeMs` every later wake-up returned at that
 * guard and the supervisor never ran again. Five live missions whose tasks had all
 * succeeded or failed hours earlier therefore sat at `draft` for ever — one of them for
 * sixteen days — each still holding the workforce assignments that a terminal mission
 * gives back. The recovery sweep woke them once a minute and the budget guard sent it
 * away again, which is also why their runtime row looked freshly updated the whole time.
 *
 * Asking "is this already finished?" costs nothing and needs no budget, so it is asked
 * FIRST and the budget guards only decide whether to do NEW work.
 *
 * FAILS CLOSED. Every branch that cannot prove the work is over returns `settled: false`
 * with the reason, because wrongly declaring a mission finished abandons work in flight —
 * the expensive direction. Absence of evidence is never treated as completion: a mission
 * with no plan is unfinished, not successful.
 */

/** A task in one of these will not change again on its own. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "superseded",
]);

/** A mission in one of these is settled; re-settling it is a no-op, not an error. */
export const TERMINAL_MISSION_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
]);

export type SettledMissionStatus = "succeeded" | "failed" | "blocked" | "cancelled";

export type MissionSettlement =
  | { readonly settled: false; readonly reason: string }
  | { readonly settled: true; readonly status: SettledMissionStatus; readonly reason: string };

export interface MissionSettlementInput {
  readonly missionStatus: string;
  readonly taskStatuses: readonly string[];
  /**
   * Dispatch attempts for this mission still in `prepared` or `dispatched`, counted from
   * the ledger. REQUIRED, and a real number: a task can read `succeeded` while the ledger
   * still carries a live intent for it, and settling then strands that execution.
   *
   * This is deliberately not optional. The previous guard asked the repository for a
   * method it did not have, so optional chaining answered `undefined`, the check passed
   * vacuously and a mission was settled with attempts still open.
   */
  readonly activeAttempts: number;
}

/**
 * Deterministic. No clock, no model, no I/O — the caller gathers the evidence and this
 * only judges it, so the same mission always settles the same way.
 */
export function settleMission(input: MissionSettlementInput): MissionSettlement {
  if (!Number.isInteger(input.activeAttempts) || input.activeAttempts < 0) {
    throw new Error("MISSION_SETTLEMENT_INVALID_ATTEMPT_COUNT");
  }

  /* Already settled. Idempotency lives here so every caller inherits it. */
  if (TERMINAL_MISSION_STATUSES.has(input.missionStatus)) {
    return { settled: false, reason: `MISSION_ALREADY_TERMINAL:${input.missionStatus}` };
  }

  /* No plan is not an achievement. */
  if (input.taskStatuses.length === 0) {
    return { settled: false, reason: "MISSION_HAS_NO_PLAN" };
  }

  /*
   * A FAILURE IS DECISIVE, and deliberately decided before the checks below.
   *
   * Work still in flight cannot turn a failed task into a success, and the tasks that
   * depended on it will never run — so waiting for them to reach a terminal status means
   * waiting for ever. This is the one verdict that does not require the rest of the graph
   * to be finished, and it is also the verdict that has to be prompt: it is what gives
   * the mission's brains back.
   */
  if (input.taskStatuses.includes("failed")) {
    return { settled: true, status: "failed", reason: "TASK_FAILED" };
  }
  if (input.taskStatuses.includes("blocked")) {
    return { settled: true, status: "blocked", reason: "TASK_BLOCKED" };
  }

  const pending = input.taskStatuses.filter((s) => !TERMINAL_TASK_STATUSES.has(s));
  if (pending.length > 0) {
    /* Covers queued/running work, a pending review and an unanswered approval alike. */
    return { settled: false, reason: `TASK_NOT_TERMINAL:${[...new Set(pending)].sort().join(",")}` };
  }

  /*
   * A live intent outranks a terminal task status: the ledger is what certifies that no
   * worker is still running, and a Temporal workflow for this mission is exactly such an
   * intent. Only SUCCESS is gated on it — a success claimed while an execution is still
   * running is the one verdict that execution could still contradict.
   */
  if (input.activeAttempts > 0) {
    return { settled: false, reason: `ATTEMPT_ACTIVE:${input.activeAttempts}` };
  }

  /*
   * Everything was replaced and nothing replaced it yet — a replan is mid-flight. Calling
   * that a success would settle a mission that has done nothing.
   */
  if (input.taskStatuses.every((s) => s === "superseded")) {
    return { settled: false, reason: "ALL_WORK_SUPERSEDED" };
  }

  if (input.taskStatuses.includes("cancelled")) {
    return { settled: true, status: "cancelled", reason: "TASK_CANCELLED" };
  }

  return { settled: true, status: "succeeded", reason: "ALL_TASKS_SUCCEEDED" };
}

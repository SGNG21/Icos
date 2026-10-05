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
   * Live attempts that belong to work which is NOT finished — counted by the caller from
   * the ledger, against the task each one belongs to.
   *
   * An attempt left on a task that already reached a terminal status is stale bookkeeping
   * for the reaper to clear, not an execution that could still change the outcome: the
   * task's own terminal status is what refuses a late result. Counting those as live
   * trades one stranded mission for another — a live mission sat at `draft` for a day
   * behind a single pre-invariant `dispatched` row with no lease, which nothing can
   * reclaim and which therefore would have held the mission open for ever.
   *
   * REQUIRED, and a real number. The guard this replaces called a repository method that
   * does not exist, so optional chaining answered `undefined` and it passed vacuously.
   */
  readonly activeAttempts: number;
  /**
   * Whether a dispatch pass has just run, so the task statuses reflect everything this
   * cycle could start.
   *
   * It decides whether a failure is allowed to be decisive. After a dispatch pass a
   * `failed` or `blocked` task settles the mission at once — its dependents will never
   * run, so waiting for the graph to finish means waiting for ever, and a mission that
   * has failed must give its brains back promptly. BEFORE one — the runner asking "is
   * this already over?" ahead of its budget — the same shortcut would kill a mission
   * whose other branches were still about to be dispatched, so only total terminality
   * settles it.
   */
  readonly dispatchPassCompleted: boolean;
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
   * A FAILURE IS DECISIVE — but only once a dispatch pass has had its say.
   *
   * After one, the task statuses reflect everything this cycle could start, so a `failed`
   * or `blocked` task settles the mission at once: its dependents will never run, and the
   * brains have to come back. Asked BEFORE a dispatch pass, the same shortcut would end a
   * mission whose other branches were about to be dispatched — a task blocked by
   * transient capacity would kill the whole mission — so that caller waits for total
   * terminality instead.
   */
  const failedFirst = input.taskStatuses.includes("failed")
    ? ("failed" as const)
    : input.taskStatuses.includes("blocked")
      ? ("blocked" as const)
      : null;

  if (input.dispatchPassCompleted && failedFirst) {
    /*
     * One sibling has failed, but another is genuinely executing. Settling now would
     * declare the mission over while a worker is still running against it, and that
     * worker's result may yet matter. Wait for the ledger to go quiet; the failure will
     * still be a failure next cycle.
     */
    if (input.activeAttempts > 0) {
      return { settled: false, reason: `ATTEMPT_ACTIVE:${input.activeAttempts}` };
    }
    return {
      settled: true,
      status: failedFirst,
      reason: failedFirst === "failed" ? "TASK_FAILED" : "TASK_BLOCKED",
    };
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

  /* Everything is terminal here, so the worst outcome decides whatever the caller was. */
  if (input.taskStatuses.includes("failed")) {
    return { settled: true, status: "failed", reason: "TASK_FAILED" };
  }
  if (input.taskStatuses.includes("blocked")) {
    return { settled: true, status: "blocked", reason: "TASK_BLOCKED" };
  }
  if (input.taskStatuses.includes("cancelled")) {
    return { settled: true, status: "cancelled", reason: "TASK_CANCELLED" };
  }

  return { settled: true, status: "succeeded", reason: "ALL_TASKS_SUCCEEDED" };
}

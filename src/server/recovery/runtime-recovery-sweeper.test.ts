import { describe, expect, it, vi } from "vitest";

import type {
  RecoveryDispatchRef,
  RecoveryScanner,
  WaitingSettledCandidate,
  WorkflowProbe,
  WorkflowStatus,
} from "@/core/contracts/recovery";
import { InMemoryRecoveryUnitRepository } from "@/server/recovery/in-memory-recovery-unit-repository";
import {
  RuntimeRecoverySweeper,
  type RuntimeRecoveryActions,
} from "@/server/recovery/runtime-recovery-sweeper";

const attempt = (id = "a1"): RecoveryDispatchRef => ({
  id,
  missionId: "m1",
  missionTaskId: "mt1",
  taskId: "t1",
  workflowId: `icos-task-${id}`,
  attempt: 1,
});

function scanner(parts: {
  waiting?: WaitingSettledCandidate[];
  prepared?: RecoveryDispatchRef[];
  orphaned?: RecoveryDispatchRef[];
  /** M7 — external worker executions whose lease expired. */
  abandoned?: RecoveryDispatchRef[];
}): RecoveryScanner {
  return {
    listSettledWaiting: async () => parts.waiting ?? [],
    listStalePrepared: async () => parts.prepared ?? [],
    listOrphanedDispatched: async () => parts.orphaned ?? [],
    listAbandonedExecutions: async () => parts.abandoned ?? [],
  };
}

function actions(overrides: Partial<RuntimeRecoveryActions> = {}): RuntimeRecoveryActions {
  return {
    wake: vi.fn().mockResolvedValue(null),
    reconcileDispatches: vi.fn().mockResolvedValue(undefined),
    redispatch: vi.fn().mockResolvedValue(undefined),
    recordLostExecution: vi.fn().mockResolvedValue(undefined),
    reclaimAbandonedExecution: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const probe = (status: WorkflowStatus): WorkflowProbe => ({ status: async () => status });
const waiting = (at = 1): WaitingSettledCandidate => ({
  missionId: "m1",
  runtimeUpdatedAt: new Date(at),
});

function make(
  s: RecoveryScanner,
  a: RuntimeRecoveryActions,
  p?: WorkflowProbe,
  units = new InMemoryRecoveryUnitRepository(),
) {
  return new RuntimeRecoverySweeper(s, units, a, p, {
    backoffBaseMs: 0,
    maxAttempts: 2,
    graceMs: 0,
    orphanAfterMs: 0,
  });
}

describe("RuntimeRecoverySweeper", () => {
  it("wakes a settled waiting mission once and resolves the unit", async () => {
    const a = actions();
    const units = new InMemoryRecoveryUnitRepository();
    const sweeper = make(scanner({ waiting: [waiting()] }), a, undefined, units);

    const first = await sweeper.sweep();
    const second = await sweeper.sweep();

    expect(a.wake).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ discovered: 1, attempted: 1, succeeded: 1, failed: 0 });
    // Same observed state (same fingerprint) is resolved: a stale scan never replays it.
    expect(second).toMatchObject({ discovered: 1, attempted: 0, succeeded: 0, failed: 0 });
  });

  it("a new waiting occurrence (new runtime fingerprint) is a new unit", async () => {
    const a = actions();
    const units = new InMemoryRecoveryUnitRepository();
    await make(scanner({ waiting: [waiting(1)] }), a, undefined, units).sweep();
    await make(scanner({ waiting: [waiting(2)] }), a, undefined, units).sweep();
    expect(a.wake).toHaveBeenCalledTimes(2);
  });

  it("two concurrent sweepers act on a unit exactly once", async () => {
    const a = actions({
      wake: vi.fn().mockImplementation(() => new Promise((r) => setTimeout(() => r(null), 20))),
    });
    const units = new InMemoryRecoveryUnitRepository();
    const s = scanner({ waiting: [waiting()], prepared: [attempt("p1")] });
    const [r1, r2] = await Promise.all([
      make(s, a, undefined, units).sweep(),
      make(s, a, undefined, units).sweep(),
    ]);

    expect(a.wake).toHaveBeenCalledTimes(1);
    expect(a.reconcileDispatches).toHaveBeenCalledTimes(1);
    expect(r1.attempted + r2.attempted).toBe(2);
  });

  it("defers (does not resolve) when a live owner already holds the runtime", async () => {
    const a = actions({
      wake: vi.fn().mockResolvedValue({ reason: "AUTONOMY_RUNTIME_ALREADY_OWNED" }),
    });
    const units = new InMemoryRecoveryUnitRepository();
    const sweeper = make(scanner({ waiting: [waiting()] }), a, undefined, units);

    expect((await sweeper.sweep()).succeeded).toBe(1);
    // Deferred with cooldown 0 → re-examined next sweep, never marked resolved.
    await sweeper.sweep();
    expect(a.wake).toHaveBeenCalledTimes(2);
  });

  it("replays a stale prepared dispatch through the supervisor reconciliation", async () => {
    const a = actions();
    await make(scanner({ prepared: [attempt()] }), a).sweep();
    expect(a.reconcileDispatches).toHaveBeenCalledWith("m1");
  });

  it("orphaned dispatch: workflow still running → defer, nothing is re-dispatched or failed", async () => {
    const a = actions();
    await make(scanner({ orphaned: [attempt()] }), a, probe("running")).sweep();
    expect(a.redispatch).not.toHaveBeenCalled();
    expect(a.recordLostExecution).not.toHaveBeenCalled();
  });

  it("orphaned dispatch: probe unavailable → fail closed (no destructive decision)", async () => {
    const a = actions();
    await make(scanner({ orphaned: [attempt()] }), a, probe("unknown")).sweep();
    expect(a.redispatch).not.toHaveBeenCalled();
    expect(a.recordLostExecution).not.toHaveBeenCalled();
  });

  it("orphaned dispatch: no probe configured → nothing happens", async () => {
    const a = actions();
    const result = await make(scanner({ orphaned: [attempt()] }), a).sweep();
    expect(a.redispatch).not.toHaveBeenCalled();
    expect(a.recordLostExecution).not.toHaveBeenCalled();
    expect(result.failed).toBe(0);
  });

  it("orphaned dispatch: workflow not found → re-dispatch with the SAME workflowId", async () => {
    const a = actions();
    await make(scanner({ orphaned: [attempt()] }), a, probe("not_found")).sweep();
    expect(a.redispatch).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "icos-task-a1" }),
    );
    expect(a.recordLostExecution).not.toHaveBeenCalled();
  });

  it("orphaned dispatch: closed without callback → recorded as a WORKER failure, never a success", async () => {
    const a = actions();
    await make(scanner({ orphaned: [attempt()] }), a, probe("closed")).sweep();
    expect(a.recordLostExecution).toHaveBeenCalledTimes(1);
    expect(a.redispatch).not.toHaveBeenCalled();
  });

  it("a failing unit does not block later units; it backs off and is exhausted after maxAttempts", async () => {
    const a = actions({
      reconcileDispatches: vi.fn().mockImplementation(async (missionId: string) => {
        if (missionId === "bad") throw new Error("TEMPORAL_UNAVAILABLE");
      }),
    });
    const bad = { ...attempt("bad"), missionId: "bad" };
    const sweeper = make(scanner({ prepared: [bad, attempt("ok")] }), a);

    const r1 = await sweeper.sweep();
    expect(r1).toMatchObject({ discovered: 2, succeeded: 1, failed: 1 });
    expect(r1.failures[0]).toMatchObject({ missionId: "bad" });

    await sweeper.sweep(); // attempt_count reaches maxAttempts (2)
    const r3 = await sweeper.sweep(); // exhausted: reported once
    expect(r3.failures.map((f) => (f.error as Error).message)).toContain("RECOVERY_UNIT_EXHAUSTED");
    const r4 = await sweeper.sweep();
    expect(r4.failed).toBe(0); // silent afterwards
    expect(a.reconcileDispatches).toHaveBeenCalledTimes(3); // "ok" once, "bad" twice, never after exhaustion
  });

  it("a crashed owner (expired lease) is recovered by the next sweeper", async () => {
    let now = 1_000;
    const units = new InMemoryRecoveryUnitRepository(() => now);
    const ref = { kind: "waiting_settled", key: "m1@1", missionId: "m1" } as const;
    expect(await units.claim(ref, "dead-process", 100, 5)).toBe("claimed"); // then "crashes"
    const a = actions();
    const sweeper = make(scanner({ waiting: [waiting(1)] }), a, undefined, units);

    expect((await sweeper.sweep()).attempted).toBe(0); // lease still alive
    now += 101;
    expect((await sweeper.sweep()).attempted).toBe(1); // lease expired → taken over
    expect(a.wake).toHaveBeenCalledTimes(1);
  });

  /*
   * M7 — ABANDONED EXTERNAL WORKER EXECUTIONS (decision 0039).
   *
   * These pin that the new candidate source is a FIRST-CLASS recovery unit: it gets the
   * same durable claim, the same bounded attempts and the same backoff as every other
   * unit, and it does NOT depend on a WorkflowProbe.
   */
  it("RECLAIMS an abandoned external worker execution, with NO workflow probe at all", async () => {
    const reclaim = vi.fn().mockResolvedValue(undefined);
    const units = new InMemoryRecoveryUnitRepository();
    const sweeper = new RuntimeRecoverySweeper(
      scanner({ abandoned: [attempt("a1")] }),
      units,
      actions({ reclaimAbandonedExecution: reclaim }),
      /*
       * NO probe. This is the whole point: the orphan path asks a Temporal probe whether
       * a workflow lives, and for a process-based worker that answer is `unknown`
       * forever. The lease already answered the question.
       */
      undefined,
      { abandonedExecutionGraceMs: 0 },
    );

    const result = await sweeper.sweep();

    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(result.discovered).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("the unit is RESOLVED, so a later sweep does not reclaim it twice", async () => {
    const reclaim = vi.fn().mockResolvedValue(undefined);
    const units = new InMemoryRecoveryUnitRepository();
    const build = () =>
      new RuntimeRecoverySweeper(
        scanner({ abandoned: [attempt("a1")] }),
        units,
        actions({ reclaimAbandonedExecution: reclaim }),
        undefined,
        { abandonedExecutionGraceMs: 0 },
      );

    await build().sweep();
    /* The scan is stateless and will keep returning the row until the state changes. */
    await build().sweep();

    expect(reclaim).toHaveBeenCalledTimes(1);
  });

  it("A FAILING RECLAIM counts a bounded attempt and never blocks the other units", async () => {
    const reclaim = vi.fn().mockRejectedValue(new Error("RECOVERY_DB_DOWN"));
    const wake = vi.fn().mockResolvedValue(null);
    const sweeper = new RuntimeRecoverySweeper(
      scanner({ waiting: [waiting()], abandoned: [attempt("a1")] }),
      new InMemoryRecoveryUnitRepository(),
      actions({ reclaimAbandonedExecution: reclaim, wake }),
      undefined,
      { abandonedExecutionGraceMs: 0 },
    );

    const result = await sweeper.sweep();

    expect(result.failed).toBe(1);
    /* The unrelated unit still ran: one bad unit must not stall recovery. */
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("RECLAMATION IS BOUNDED: a permanently failing unit is eventually EXHAUSTED", async () => {
    const reclaim = vi.fn().mockRejectedValue(new Error("RECOVERY_DB_DOWN"));
    const units = new InMemoryRecoveryUnitRepository();
    const build = () =>
      new RuntimeRecoverySweeper(
        scanner({ abandoned: [attempt("a1")] }),
        units,
        actions({ reclaimAbandonedExecution: reclaim }),
        undefined,
        { maxAttempts: 2, backoffBaseMs: 0, abandonedExecutionGraceMs: 0 },
      );

    await build().sweep();
    await build().sweep();
    const third = await build().sweep();

    /*
     * A worker that dies deterministically must not be retried for ever. The budget is
     * the existing recovery-unit bound, not a new mechanism.
     */
    expect(third.failures[0]?.error).toMatchObject({ message: "RECOVERY_UNIT_EXHAUSTED" });
  });
});

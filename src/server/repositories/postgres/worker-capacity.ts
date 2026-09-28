import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

import { WorkerCapacityExceededError } from "@/core/contracts/dispatch-attempt";
import type { Database } from "@/server/database/client";
import { dispatchAttempts, workers } from "@/server/database/schema";

/** The two non-terminal states. An active execution is exactly one of these. */
const ACTIVE_ATTEMPT_STATES = ["prepared", "dispatched"] as const;

/**
 * THE capacity authority (M5.5, extracted in M7.1).
 *
 * It lived as a private method on the dispatch-attempt repository, which was fine
 * while `prepare()` was the only way an attempt could be created. It is not: the
 * quality-control retry path INSERTS an attempt directly, and it did so without ever
 * consulting this guard — so a retry could oversubscribe a worker that `prepare()`
 * would have refused.
 *
 * Extracted rather than copied. Two capacity checks would be two capacity authorities,
 * and the one that drifts is the one that stops counting a pool.
 *
 * Must run INSIDE the caller's transaction, after the worker rows are locked.
 */
/**
 * Fails closed when the assigned worker, or its shared capacity pool, is
 * already fully committed. Must run inside the prepare transaction, after the
 * worker rows have been locked.
 *
 * An UNREGISTERED worker id is rejected: assigning work to a worker that is
 * not in the registry means the decision was made against state that no longer
 * exists, and letting it through would create an attempt whose load nothing
 * bounds.
 */
export async function assertWorkerCapacity(
  tx: Database,
  workerId: string,
  missionTaskId: string,
): Promise<void> {
  const assigned = await tx
    .select()
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1)
    .for("update");
  const worker = assigned[0];

  if (!worker) {
    throw new WorkerCapacityExceededError(workerId, "is not registered");
  }

  // Lock every peer in the pool, ordered by id: same order for everyone, so
  // no deadlock, and no peer can commit an attempt while we are counting.
  const poolMembers = worker.capacityPool
    ? await tx
        .select({ id: workers.id, limit: workers.capacityPoolLimit })
        .from(workers)
        .where(eq(workers.capacityPool, worker.capacityPool))
        .orderBy(asc(workers.id))
        .for("update")
    : [];

  const active = await tx
    .select({ workerId: dispatchAttempts.workerId })
    .from(dispatchAttempts)
    .where(
      and(
        isNotNull(dispatchAttempts.workerId),
        inArray(dispatchAttempts.state, ACTIVE_ATTEMPT_STATES),
      ),
    );

  // This task's own live attempt is not competing demand: a retry of the same
  // logical work must not be blocked by the attempt it is superseding.
  const ownAttempts = await tx
    .select({ id: dispatchAttempts.id })
    .from(dispatchAttempts)
    .where(
      and(
        eq(dispatchAttempts.missionTaskId, missionTaskId),
        inArray(dispatchAttempts.state, ACTIVE_ATTEMPT_STATES),
      ),
    );
  const ownActive = ownAttempts.length;

  const mine = active.filter((row) => row.workerId === workerId).length;
  if (mine - Math.min(mine, ownActive) >= worker.maxConcurrency) {
    throw new WorkerCapacityExceededError(
      workerId,
      `already holds ${mine} of ${worker.maxConcurrency} concurrent executions`,
    );
  }

  if (worker.capacityPool && poolMembers.length > 0) {
    const declared = poolMembers
      .map((member) => member.limit)
      .filter((limit): limit is number => limit !== null);

    if (declared.length > 0) {
      // A quota is a ceiling: when members disagree, the SMALLEST wins.
      const limit = Math.min(...declared);
      const memberIds = new Set(poolMembers.map((member) => member.id));
      const poolActive = active.filter(
        (row) => row.workerId !== null && memberIds.has(row.workerId),
      ).length;

      if (poolActive - Math.min(poolActive, ownActive) >= limit) {
        throw new WorkerCapacityExceededError(
          workerId,
          `capacity pool ${worker.capacityPool} holds ${poolActive} of ${limit}`,
        );
      }
    }
  }
}

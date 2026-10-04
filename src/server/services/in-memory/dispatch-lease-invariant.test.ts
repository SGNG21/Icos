import { describe, expect, it } from "vitest";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryDispatchAttemptRepository } from "@/server/services/in-memory/dispatch-attempt-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";

/**
 * DISPATCHED implies a finite lease.
 *
 * Nineteen live attempts sat in `dispatched` with a null lease and could never be
 * reclaimed: the abandoned-execution scan needs an expiry to call a runner dead, and the
 * orphan scan can only ask a workflow probe — which answers "running" for ever when the
 * workflow sits on a task queue no worker consumes. Each pinned a worker of concurrency
 * 1 until no capacity was left and nothing could be dispatched at all.
 *
 * These pin the invariant at the transition, where forgetting it is not expressible.
 */
const LEASE = { owner: "wf-1", leaseMs: 60_000 } as const;

async function fixture() {
  const audit = new InMemoryAuditLog();
  const tasks = new InMemoryTaskRepository(audit, []);
  const missions = new InMemoryMissionRepository(tasks);
  const mission = await missions.create({
    title: "Lease invariant",
    objective: "A dispatched attempt is never leaseless",
    tasks: [{ title: "Work", description: "do the thing", dependsOn: [] }],
  });
  const missionTask = (await missions.listTasks(mission.id))[0];
  const repo = new InMemoryDispatchAttemptRepository(missions, tasks);
  const { attempt } = await repo.prepare({
    missionId: mission.id,
    missionTaskId: missionTask.id,
    taskId: missionTask.taskId,
    attempt: 1,
    workflowId: `icos-task-${missionTask.taskId}`,
    prompt: missionTask.description ?? missionTask.title,
  });
  return { repo, attempt };
}

describe("dispatch lease invariant", () => {

  it("a dispatched attempt always holds a lease", async () => {
    const { repo, attempt } = await fixture();
    await repo.markDispatched(attempt.id, LEASE);

    expect(await repo.holdsExecutionLease(attempt.id, LEASE.owner)).toBe(true);
  });

  it("refuses a dispatch with no finite lease", async () => {
    const { repo, attempt } = await fixture();

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        repo.markDispatched(attempt.id, { owner: "wf-1", leaseMs: bad }),
      ).rejects.toThrow("EXECUTION_LEASE_INVALID_LEASE");
    }
    await expect(repo.markDispatched(attempt.id, { owner: "", leaseMs: 60_000 })).rejects.toThrow(
      "EXECUTION_LEASE_INVALID_OWNER",
    );
  });

  it("fences a stale owner: only the holder still holds it", async () => {
    const { repo, attempt } = await fixture();
    await repo.markDispatched(attempt.id, LEASE);

    expect(await repo.holdsExecutionLease(attempt.id, "someone-else")).toBe(false);
  });

  it("renewal is the owner re-acquiring, and is idempotent", async () => {
    const { repo, attempt } = await fixture();
    await repo.markDispatched(attempt.id, LEASE);

    expect(await repo.acquireExecutionLease(attempt.id, LEASE.owner, 60_000)).toBe(true);
    expect(await repo.acquireExecutionLease(attempt.id, LEASE.owner, 60_000)).toBe(true);
    expect(await repo.holdsExecutionLease(attempt.id, LEASE.owner)).toBe(true);
  });

  it("a second runner cannot take a live lease", async () => {
    const { repo, attempt } = await fixture();
    await repo.markDispatched(attempt.id, LEASE);

    expect(await repo.acquireExecutionLease(attempt.id, "wf-2", 60_000)).toBe(false);
  });

  it("an expired lease is takeable, and the old owner no longer holds it", async () => {
    const { repo, attempt } = await fixture();
    await repo.markDispatched(attempt.id, { owner: "wf-1", leaseMs: 1 });
    await new Promise((r) => setTimeout(r, 5));

    expect(await repo.holdsExecutionLease(attempt.id, "wf-1")).toBe(false);
    expect(await repo.acquireExecutionLease(attempt.id, "wf-2", 60_000)).toBe(true);
    expect(await repo.holdsExecutionLease(attempt.id, "wf-1")).toBe(false);
  });

  it("concurrent takeover of one expired lease succeeds exactly once", async () => {
    const { repo, attempt } = await fixture();
    await repo.markDispatched(attempt.id, { owner: "wf-1", leaseMs: 1 });
    await new Promise((r) => setTimeout(r, 5));

    const results = await Promise.all([
      repo.acquireExecutionLease(attempt.id, "wf-a", 60_000),
      repo.acquireExecutionLease(attempt.id, "wf-b", 60_000),
      repo.acquireExecutionLease(attempt.id, "wf-c", 60_000),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

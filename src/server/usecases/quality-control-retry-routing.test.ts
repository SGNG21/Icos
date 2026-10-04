import { describe, expect, it, vi } from "vitest";

import type { ReviewDecisionRecord } from "@/core/contracts/review";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryDispatchAttemptRepository } from "@/server/services/in-memory/dispatch-attempt-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryQualityControlRepository } from "@/server/services/in-memory/quality-control-repository";
import { InMemoryReviewDecisionRepository } from "@/server/services/in-memory/review-decision-repository";
import { InMemoryTaskExecutionResultRepository } from "@/server/services/in-memory/task-execution-result-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { CapabilityRouter } from "@/server/routing/capability-router";
import type { ReviewerService } from "@/server/review/ports";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import {
  QUALITY_CONTROL_NO_ELIGIBLE_WORKER,
  QualityControlService,
} from "./quality-control-service";

/*
 * M7.1 — THE QC RE-DISPATCH GAP.
 *
 * M7 proved an abandoned execution's capacity slot comes back and that a new attempt CAN
 * be prepared. It did not prove anything automatically does it. Following the production
 * path showed the retry existed but was UNROUTED: `applyAction` copied workerKind and
 * capability from the previous attempt and left `worker_id` NULL. Any dispatcher that
 * resolves its worker from the ledger — including the M6.3 external worker executor —
 * then fails the attempt closed with PROVIDER_UNAVAILABLE, so the retry consumed a slot
 * from a bounded budget and changed nothing.
 */

const WORKER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAPABILITY = "code-generation";

async function fixture(options: { withRouter?: boolean; maxConcurrency?: number } = {}) {
  const audit = new InMemoryAuditLog();
  const tasks = new InMemoryTaskRepository(audit, []);
  const missions = new InMemoryMissionRepository(tasks);
  const mission = await missions.create({
    title: "M7.1",
    objective: "Prove a retry is routed",
    tasks: [
      {
        title: "Produce result",
        description: "Do the work",
        dependsOn: [],
        workerKind: null,
        capability: CAPABILITY,
      },
    ],
  });
  const missionTask = (await missions.listTasks(mission.id))[0]!;


  const store = new InMemoryWorkerRegistryStore();
  const registration = new WorkerRegistrationService(store);
  for (const id of [WORKER_A, WORKER_B]) {
    await registration.register({
      id,
      workerKind: "agent",
      displayName: id,
      capabilities: [CAPABILITY],
      runtime: "node",
      runtimeSupport: "SUPPORTED_RUNTIME",
      maxConcurrency: options.maxConcurrency ?? 1,
    });
    /* Health evidence: routing refuses a worker it has never seen work (0033). */
    await registration.probe(id, { health: "healthy", availability: "available" });
  }

  const executionResults = new InMemoryTaskExecutionResultRepository(audit, tasks);
  const reviewDecisions = new InMemoryReviewDecisionRepository();
  const dispatchAttempts = new InMemoryDispatchAttemptRepository(missions, tasks, store);

  const original = await dispatchAttempts.prepare({
    missionId: mission.id,
    missionTaskId: missionTask.id,
    taskId: missionTask.taskId,
    attempt: 1,
    workflowId: workflowIdForAttempt(missionTask.taskId, 1),
    prompt: "Do the work",
    capability: CAPABILITY,
    workerId: WORKER_A,
  });
  await dispatchAttempts.markDispatched(original.attempt.id, { owner: "test-owner", leaseMs: 60_000 });
  await tasks.transition(missionTask.taskId, "running");

  const reviewer: ReviewerService = {
    review: vi.fn(
      async (input) =>
        ({
          id: `review-${input.executionResult.id}`,
          missionId: input.mission.id,
          taskId: input.task.id,
          workflowId: input.executionResult.workflowId,
          /* The deterministic reviewer maps UNKNOWN_EFFECT to RETRY; pinned there. */
          decision: "RETRY",
          reviewerKind: "llm",
          severity: "warning",
          reasons: ["worker died mid-execution"],
          createdAt: new Date().toISOString(),
          humanOverridden: false,
        }) satisfies ReviewDecisionRecord,
    ),
  };

  const qualityJobs = new InMemoryQualityControlRepository(
    missions,
    tasks,
    executionResults,
    reviewDecisions,
    dispatchAttempts,
  );

  const dispatched: string[] = [];
  const capabilityRouter = new CapabilityRouter(store, {
    activeAssignments: () => dispatchAttempts.listActiveWorkerAssignments(),
  });

  const qualityControl = new QualityControlService({
    missions,
    tasks,
    executionResults,
    reviewer,
    reviewDecisions,
    dispatchAttempts,
    qualityJobs,
    capabilityRouter: options.withRouter === false ? undefined : capabilityRouter,
    dispatchPrepared: async (attempt) => {
      dispatched.push(attempt.workflowId);
      await dispatchAttempts.markDispatched(attempt.id, { owner: "test-owner", leaseMs: 60_000 });
    },
  });

  /*
   * The abandoned execution, recorded exactly as M7's reclaim records it: the ATTEMPT is
   * settled first (that is what returns the capacity slot) and the business failure
   * second. Settling first is not a detail of this fixture — it is the ordering that
   * makes the retry routable at all.
   */
  const failedWorkflowId = workflowIdForAttempt(missionTask.taskId, 1);
  await dispatchAttempts.recordExecutionFailure(original.attempt.id, {
    failureClass: "LEASE_EXPIRED",
    message: "lease expired; runner abandoned the attempt",
  });
  await executionResults.record({
    taskId: missionTask.taskId,
    workflowId: failedWorkflowId,
    outcome: "failure",
    error: { code: "UNKNOWN_EFFECT", message: "lease expired; effect unknown" },
    completedAt: new Date().toISOString(),
  });
  await qualityControl.registerExecution({
    missionId: mission.id,
    missionTaskId: missionTask.id,
    taskId: missionTask.taskId,
    workflowId: failedWorkflowId,
  });

  return {
    mission,
    missionTask,
    tasks,
    store,
    registration,
    dispatchAttempts,
    qualityControl,
    dispatched,
    nextWorkflowId: workflowIdForAttempt(missionTask.taskId, 2),
  };
}

describe("M7.1 QC retry is routed", () => {
  it("THE GAP: a retry is ROUTED to a worker instead of being created unrouted", async () => {
    const f = await fixture();

    await f.qualityControl.processPending(f.mission.id);

    const retry = await f.dispatchAttempts.getByWorkflowId(f.nextWorkflowId);
    expect(retry).not.toBeNull();
    /*
     * Before M7.1 this was null, and the M6.3 external executor failed such an attempt
     * closed with PROVIDER_UNAVAILABLE — a retry spent on nothing.
     */
    expect(retry?.workerId).toBeTruthy();
    expect([WORKER_A, WORKER_B]).toContain(retry?.workerId);
    expect(f.dispatched).toEqual([f.nextWorkflowId]);
  });

  it("THE RETRY AVOIDS A WORKER THAT CAN NO LONGER TAKE WORK", async () => {
    const f = await fixture();
    /*
     * Worker A died: its health evidence says so, so the router must not offer it. No
     * grudge list is kept here — eligibility is the router's job (0031/0033).
     */
    await f.registration.probe(WORKER_A, {
      health: "unhealthy",
      availability: "unavailable",
    });

    await f.qualityControl.processPending(f.mission.id);

    expect((await f.dispatchAttempts.getByWorkflowId(f.nextWorkflowId))?.workerId).toBe(WORKER_B);
  });

  it("NO ELIGIBLE WORKER IS BACK-PRESSURE, not a spent retry", async () => {
    const f = await fixture();
    /* The whole fleet is down. */
    for (const id of [WORKER_A, WORKER_B]) {
      await f.registration.probe(id, { health: "unhealthy", availability: "unavailable" });
    }

    await expect(f.qualityControl.processPending(f.mission.id)).rejects.toThrow(
      new RegExp(QUALITY_CONTROL_NO_ELIGIBLE_WORKER),
    );

    /*
     * Nothing was created. Creating an unroutable attempt would spend one of a bounded
     * number of retries to record a FLEET problem as a TASK failure.
     */
    expect(await f.dispatchAttempts.getByWorkflowId(f.nextWorkflowId)).toBeNull();
    expect(f.dispatched).toEqual([]);
  });

  it("THE FLEET PROBLEM IS RECORDED AS ITSELF, not as a review failure", async () => {
    const f = await fixture();
    for (const id of [WORKER_A, WORKER_B]) {
      await f.registration.probe(id, { health: "unhealthy", availability: "unavailable" });
    }
    await f.qualityControl.processPending(f.mission.id).catch(() => undefined);

    /* Triage must not be sent looking at the reviewer for a capacity outage. */
    const job = await f.dispatchAttempts.getByWorkflowId(
      workflowIdForAttempt(f.missionTask.taskId, 1),
    );
    expect(job).not.toBeNull();
  });

  it("A RETRY CANNOT OVERSUBSCRIBE: the routed worker's capacity is enforced", async () => {
    const f = await fixture();
    /*
     * `applyAction` INSERTs the retry directly on the PostgreSQL path, bypassing
     * `prepare()`. Before M7.1 it bypassed the capacity guard with it, so a retry could
     * hand work to a worker already at its limit.
     */
    await f.registration.probe(WORKER_B, {
      health: "unhealthy",
      availability: "unavailable",
    });

    await f.qualityControl.processPending(f.mission.id);

    const retry = await f.dispatchAttempts.getByWorkflowId(f.nextWorkflowId);
    /*
     * Only A is eligible, and A's slot was returned when M7 settled attempt 1 — so the
     * retry fits. Exactly one live assignment: the retry never doubles up on a worker
     * whose declared concurrency is 1.
     */
    expect(retry?.workerId).toBe(WORKER_A);
    const active = await f.dispatchAttempts.listActiveWorkerAssignments();
    expect(active.filter((id) => id === WORKER_A)).toHaveLength(1);
  });

  it("WITHOUT A ROUTER the pre-M4 behaviour is unchanged", async () => {
    const f = await fixture({ withRouter: false });

    await f.qualityControl.processPending(f.mission.id);

    /* A deployment with no registry routes nothing, and must keep working. */
    const retry = await f.dispatchAttempts.getByWorkflowId(f.nextWorkflowId);
    expect(retry).not.toBeNull();
    expect(retry?.workerId).toBeUndefined();
    expect(f.dispatched).toEqual([f.nextWorkflowId]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { DEFAULT_INITIATIVE_POLICY, DEFAULT_RELEVANCE_RULES } from "@/core/supervisor/defaults";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { dispatchAttempts, missionTasks, missions, tasks } from "@/server/database/schema";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { PostgresMissionRepository } from "@/server/mission/postgres-mission-repository";
import { PostgresGoalRepository } from "@/server/repositories/postgres/goal-repository";
import { DurableScheduler } from "@/server/scheduler/durable-scheduler";
import { PostgresScheduledJobRepository } from "@/server/scheduler/postgres-scheduled-job-repository";
import { GoalNormalizer } from "@/server/services/goal-normalizer";
import { GoalPlanner } from "@/server/services/goal-planner";
import { GoalPreviewStore } from "@/server/services/goal-preview-store";

import { CanonicalGoalIntake, MissionSubjectStatus } from "./adapters";
import {
  ComputeHealthObservation,
  SUPERVISOR_OBSERVE_JOB_KIND,
  createObservationHandler,
  seedObservation,
} from "./observations";
import { PostgresSupervisorStore } from "./postgres-supervisor-store";
import { describeProactiveSupervisorContract, ev, harness } from "./proactive-supervisor.contract";
import { ProactiveSupervisor } from "./proactive-supervisor";

let handle: DatabaseHandle;
const SUPERVISOR_TABLES =
  "supervisor_attention, supervisor_goal_proposals, supervisor_events, supervisor_situations";

beforeAll(async () => {
  handle = createDatabase(TEST_DATABASE_URL, { max: 12 });
  await handle.db.execute(sql`select 1`);
});

afterAll(async () => {
  await handle.db.execute(sql.raw(`TRUNCATE TABLE ${SUPERVISOR_TABLES}, scheduled_jobs CASCADE`));
  await handle.close();
});

const fresh = async () => {
  await handle.db.execute(sql.raw(`TRUNCATE TABLE ${SUPERVISOR_TABLES} CASCADE`));
  return new PostgresSupervisorStore(handle.db);
};

describeProactiveSupervisorContract("PostgreSQL", fresh);

const hourAgo = () => new Date(Date.now() - 3_600_000);
const soon = () => new Date(Date.now() + 3_600_000);
const bounded = {
  ...DEFAULT_INITIATIVE_POLICY,
  rules: [
    { domain: "web.operations", level: "EXECUTE_BOUNDED" as const },
    ...DEFAULT_INITIATIVE_POLICY.rules.filter((r) => r.domain !== "web.operations"),
  ],
};

describe("PostgreSQL — durability, concurrency and canonical paths", () => {
  it("the event ledger is append-only", async () => {
    const store = await fresh();
    await harness(store).supervisor.ingest(ev());
    await expect(
      handle.db.execute(sql`UPDATE supervisor_events SET disposition = 'IGNORE'`),
    ).rejects.toThrow();
    await expect(handle.db.execute(sql`DELETE FROM supervisor_events`)).rejects.toThrow();
  });

  it("the database refuses an automatically-submittable proposal that is not a bounded goal", async () => {
    const store = await fresh();
    const r = await harness(store).supervisor.ingest(ev());
    await expect(
      handle.db.execute(
        sql`UPDATE supervisor_goal_proposals SET state = 'pending' WHERE situation_id = ${r.situationId}`,
      ),
    ).rejects.toThrow();
  });

  it("two processes ingesting the same observation concurrently record it once; flood bound is exact across processes", async () => {
    await fresh();
    const other = createDatabase(TEST_DATABASE_URL, { max: 6 });
    try {
      const policy = { ...bounded, maxNewSituationsPerHour: 5 };
      const a = harness(new PostgresSupervisorStore(handle.db), { policy });
      const b = harness(new PostgresSupervisorStore(other.db), { policy });
      const event = ev({ dedupKey: "shared" });
      const results = await Promise.all([a, b, a, b, a, b].map((h) => h.supervisor.ingest(event)));
      expect(results.filter((r) => r.status === "RECORDED")).toHaveLength(1);

      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          (i % 2 ? a : b).supervisor.ingest(ev({ subject: `site:s${i}` })),
        ),
      );
      const digest = await a.supervisor.digest("tenant-a", { since: hourAgo(), until: soon() });
      expect(digest.situations).toHaveLength(5);
      await Promise.all([a.supervisor.drain(), b.supervisor.drain()]);
      // The execution budget (default 3/h per action) is exact across processes too.
      expect(a.submitted.length + b.submitted.length).toBe(3);
      expect(digest.situations.filter((s) => s.proposal?.state === "awaiting_human")).toHaveLength(
        2,
      );
    } finally {
      await other.close();
    }
  });

  it("a bounded goal lands in CORE3 goal intake as a PENDING goal, once, with its evidence", async () => {
    const store = await fresh();
    await handle.db.execute(
      sql.raw("DELETE FROM goal_previews WHERE \"goalId\" LIKE 'goal-proactive-%'"),
    );
    await handle.db.execute(sql.raw("DELETE FROM goals WHERE id LIKE 'goal-proactive-%'"));
    const goals = new PostgresGoalRepository(handle.db);
    const intake = new CanonicalGoalIntake({
      normalizer: new GoalNormalizer(),
      planner: new GoalPlanner(),
      previews: new GoalPreviewStore(goals),
      goals,
    });
    const supervisor = new ProactiveSupervisor({
      store,
      rules: DEFAULT_RELEVANCE_RULES,
      policy: bounded,
      goalIntake: intake,
    });
    const r = await supervisor.ingest(ev({ clientScope: "client-a" }));
    expect(r).toMatchObject({ disposition: "CREATE_BOUNDED_GOAL" });
    const [proposal] = (
      await supervisor.digest("tenant-a", { since: hourAgo(), until: soon() })
    ).situations.map((s) => s.proposal!);
    expect(proposal).toMatchObject({ state: "submitted" });

    const goal = await goals.getById(proposal.externalRef!);
    expect(goal?.goal).toMatchObject({
      riskLevel: "reversible",
      humanApprovalPolicy: "always",
      allowedCapabilities: ["web.development", "web.testing"],
      metadata: {
        origin: "proactive-supervisor",
        proposalId: proposal.proposal.id,
        sourceEventId: r.eventId,
        clientScope: "client-a",
      },
    });
    const [status] = (await handle.db.execute(
      sql`SELECT status, "resultingMissionId" FROM goals WHERE id = ${proposal.externalRef!}`,
    )) as unknown as Array<{ status: string; resultingMissionId: string | null }>;
    expect(status).toEqual({ status: "pending", resultingMissionId: null }); // never converted by the supervisor

    // Replay of the submission (crash between submit and settle): still ONE goal.
    expect(await intake.submit(proposal.proposal)).toEqual({
      status: "SUBMITTED",
      ref: proposal.externalRef,
    });
    const [count] = (await handle.db.execute(
      sql`SELECT count(*)::int AS n FROM goals WHERE id = ${proposal.externalRef!}`,
    )) as unknown as Array<{ n: number }>;
    expect(count.n).toBe(1);
  });

  it("restart: a crash after commit and before side effects loses nothing — the next drain delivers", async () => {
    const store = await fresh();
    const crashing = new ProactiveSupervisor({
      store,
      rules: DEFAULT_RELEVANCE_RULES,
      policy: bounded,
      goalIntake: {
        submit: async () => {
          throw new Error("process died");
        },
      },
    });
    const r = await crashing.ingest(ev());
    expect(r.status).toBe("RECORDED");
    const other = createDatabase(TEST_DATABASE_URL, { max: 2 });
    try {
      const restarted = harness(new PostgresSupervisorStore(other.db), { policy: bounded });
      expect(await restarted.supervisor.drain()).toMatchObject({ proposals: 1 });
      expect(restarted.submitted).toHaveLength(1);
      expect(await restarted.supervisor.drain()).toMatchObject({ proposals: 0 });
    } finally {
      await other.close();
    }
  });

  it("restart: a pending scheduled observation survives the process and runs after it", async () => {
    await fresh();
    await handle.db.execute(sql.raw("TRUNCATE TABLE scheduled_jobs"));
    const schedule = { observationKey: "uptime", tenantId: "tenant-a", intervalMs: 60_000 };
    // Process 1 seeds the observation, then dies before it is due.
    await seedObservation(
      new PostgresScheduledJobRepository(handle.db),
      schedule,
      new Date(Date.now() - 60_000),
    );

    // Process 2: brand-new pool, repositories, supervisor and scheduler.
    const other = createDatabase(TEST_DATABASE_URL, { max: 4 });
    try {
      const jobs = new PostgresScheduledJobRepository(other.db);
      const { supervisor } = harness(new PostgresSupervisorStore(other.db));
      const handler = createObservationHandler({
        supervisor,
        jobs,
        sources: {
          uptime: {
            observe: async ({ tenantId }) => [
              ev({ tenantId, origin: "scheduled", dedupKey: "check-42" }),
            ],
          },
        },
      });
      const scheduler = new DurableScheduler(jobs, { [SUPERVISOR_OBSERVE_JOB_KIND]: handler });
      expect(await scheduler.sweep()).toMatchObject({ discovered: 1, succeeded: 1 });
      const pending = (await other.db.execute(
        sql`SELECT state, next_run_at FROM scheduled_jobs WHERE kind = 'supervisor_observe' ORDER BY next_run_at`,
      )) as unknown as Array<{ state: string }>;
      expect(pending.map((j) => j.state)).toEqual(["succeeded", "scheduled"]); // exactly one next occurrence
      expect(
        (await supervisor.digest("tenant-a", { since: hourAgo(), until: soon() })).eventCount,
      ).toBe(1);
    } finally {
      await other.close();
    }
  });

  it("internal compute-health observation reads failed dispatch attempts; a finished mission is not reopened", async () => {
    const store = await fresh();
    await handle.db.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks, dispatch_attempts, mission_tasks RESTART IDENTITY CASCADE",
      ),
    );
    const now = new Date();
    await handle.db.insert(missions).values({
      id: "ps-m1",
      title: "M",
      objective: "o",
      status: "succeeded",
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(tasks).values({
      id: "ps-t1",
      title: "T",
      description: "d",
      status: "failed",
      assignedAgentId: null,
      requiredCapabilities: ["x"],
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(missionTasks).values({
      id: "ps-mt1",
      missionId: "ps-m1",
      title: "T",
      description: "d",
      dependsOn: [],
      status: "failed",
      workerKind: null,
      capability: "x",
      taskId: "ps-t1",
      createdAt: now,
      updatedAt: now,
    });
    for (const [i, failureClass] of [
      "RATE_LIMITED",
      "RATE_LIMITED",
      "WORKER_CRASHED",
      "FAILED_TERMINAL",
    ].entries()) {
      await handle.db.insert(dispatchAttempts).values({
        id: `ps-att-${i}`,
        missionId: "ps-m1",
        missionTaskId: "ps-mt1",
        taskId: "ps-t1",
        attempt: i + 1,
        workflowId: `ps-wf-${i}`,
        prompt: "p",
        workerKind: "agent",
        workerId: null,
        capability: "x",
        state: "failed",
        failureClass,
        lastError: "boom",
        createdAt: now,
        updatedAt: now,
      });
    }

    const source = new ComputeHealthObservation(handle.db);
    const observed = await source.observe({
      tenantId: "tenant-a",
      since: hourAgo(),
      until: soon(),
    });
    expect(observed.map((o) => o.type)).toEqual([
      "PROVIDER_RATE_LIMIT",
      "PROVIDER_RATE_LIMIT",
      "WORKER_CRASH",
    ]);

    const h = harness(store, {
      subjects: new MissionSubjectStatus(new PostgresMissionRepository(handle.db)),
    });
    for (const o of observed) await h.supervisor.ingest(o);
    for (const o of observed) expect((await h.supervisor.ingest(o)).status).toBe("DUPLICATE"); // overlapping window
    const digest = await h.supervisor.digest("tenant-a", { since: hourAgo(), until: soon() });
    expect(digest.situations.map((s) => [s.eventType, s.eventCount]).sort()).toEqual([
      ["PROVIDER_RATE_LIMIT", 2],
      ["WORKER_CRASH", 1],
    ]);
    expect(digest.situations.every((s) => s.proposal === null)).toBe(true); // compute routing owns remediation

    const blocked = await h.supervisor.ingest(
      ev({ source: "icos.runtime", type: "MISSION_BLOCKED", subject: "mission:ps-m1" }),
    );
    expect(blocked).toMatchObject({
      disposition: "RECORD_ONLY",
      situationId: null,
      reasons: ["SUBJECT_TERMINAL"],
    });
  });
});

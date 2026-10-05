/**
 * ONE ordinary software objective, driven through the CANONICAL services, with the brain
 * evidence read back from the rows the runtime wrote (decision 0070, P1).
 *
 *   goal intake → Durable Scheduler `start_mission` → runtime (scheduler, supervisor,
 *   Temporal worker, executor, reviewer, settlement) → evidence
 *
 * Nothing is inserted with raw SQL and no policy layer is bypassed; the only SQL here is
 * READ-ONLY evidence collection at the end. Prints ids, states and counts; never a secret.
 *
 *   pnpm exec tsx scripts/bridge-live-e2e.ts [--objective "…"] [--max-minutes 10]
 */
import { sql } from "drizzle-orm";

import { loadEnv } from "@/config/env";
import { createContainer } from "@/server/container";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const OBJECTIVE = flag(
  "--objective",
  "Analyse le module src/core/cognitive et propose un court plan d'amélioration, sans modifier le système.",
);
const MAX_MINUTES = Number(flag("--max-minutes", "10"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.PERSISTENCE !== "postgres") throw new Error("PERSISTENCE=postgres est requis.");
  const container = await createContainer();
  if (!container.db) throw new Error("no database");
  const stamp = Date.now();

  const goal = container.goalNormalizer.normalize({
    title: `Plan d'amélioration cognitive (${stamp})`,
    objective: OBJECTIVE,
    successCriteria: ["un plan court et lisible"],
    // The metadata the conversational intake stamps on a spoken goal: USER work class, so
    // Chief leads it with Planner and binds a code_write task to Builder.
    metadata: { "icos.source": "cognitive_conversation", source: "bridge-live-e2e" },
  } as never);
  const preview = container.goalPlanner.plan(goal);
  if (!(await container.goalRepository.getById(goal.id))) {
    await container.goalPreviewStore.store(goal.id, goal, preview);
  }
  log({ step: "goal_created", goalId: goal.id });

  const prior = await container.mission.findByGoalId(goal.id);
  const job = prior
    ? { job: { id: "<existing>", missionId: prior.id }, created: false }
    : ((await container.scheduler.enqueue({
        kind: "start_mission",
        payload: { title: goal.title, objective: OBJECTIVE, goalId: goal.id },
        idempotencyKey: `bridge-live-e2e:${stamp}`,
        runAt: new Date().toISOString(),
      } as never)) as { job: { id: string; missionId?: string | null }; created: boolean });
  const missionId = prior ? prior.id : (job.job.missionId ?? "");
  log({ step: "enqueued", missionId, jobId: job.job.id, created: job.created });
  if (!missionId) throw new Error("SCHEDULER_RETURNED_NO_MISSION_ID");

  let last = "";
  for (let i = 0; i < (MAX_MINUTES * 60) / 5; i += 1) {
    await sleep(5000);
    const mission = await container.mission.findById(missionId);
    const tasks = mission ? await container.mission.listTasks(missionId) : [];
    const line = JSON.stringify({
      missionStatus: mission?.status ?? "<no mission yet>",
      tasks: tasks.map((t) => t.status),
    });
    if (line !== last) log({ t: (i + 1) * 5, ...JSON.parse(line) });
    last = line;
    if (mission && ["succeeded", "failed", "cancelled"].includes(mission.status)) break;
  }

  // ── Evidence, read-only ────────────────────────────────────────────────────────────
  const db = container.db;
  const mission = await container.mission.findById(missionId);
  const tasks = await container.mission.listTasks(missionId);
  const assignments = [
    ...(await db.execute<{ task_id: string; assignee_agent_id: string; status: string }>(
      sql`select task_id, assignee_agent_id, status from workforce_assignments where mission_id = ${missionId} order by task_id, assignee_agent_id`,
    )),
  ];
  const attempts = [
    ...(await db.execute<{
      task_id: string;
      attempt: number;
      state: string;
      worker_kind: string | null;
      workforce: Record<string, unknown> | null;
      requirement: Record<string, unknown> | null;
    }>(
      sql`select task_id, attempt, state, worker_kind, routing_decision->'workforce' as workforce, routing_decision->'requirement' as requirement from dispatch_attempts where mission_id = ${missionId} order by task_id, attempt`,
    )),
  ];
  const reviews = [
    ...(await db.execute<{ decision: string; reviewer_kind: string }>(
      sql`select decision, "reviewerKind" as reviewer_kind from decisions where "missionId" = ${missionId}`,
    )),
  ];
  const ledger = [
    ...(await db.execute<{ brain_id: string | null; n: number; tokens: number }>(
      sql`select brain_id, count(*)::int as n, coalesce(sum(total_tokens),0)::int as tokens from spend_ledger where goal_id = ${goal.id} group by brain_id order by brain_id`,
    )),
  ];
  const taskIds = new Set(tasks.map((t) => t.taskId));
  const taskBound = assignments.filter((a) => taskIds.has(a.task_id));
  const attemptsWithBrain = attempts.filter(
    (a) => a.workforce && Array.isArray(a.workforce.agentIds),
  );

  log({
    step: "evidence",
    missionId,
    missionStatus: mission?.status ?? null,
    tasks: tasks.map((t) => ({ taskId: t.taskId, title: t.title, status: t.status })),
    assignments,
    attempts,
    reviews,
    ledgerByBrain: ledger,
  });
  log({
    step: "verdict",
    BRAIN_ASSIGNMENT_PERSISTED: taskBound.length > 0 ? "YES" : "NO",
    CORE3_TASK_BRAIN_LINK:
      taskBound.length === tasks.length && tasks.length > 0
        ? "YES"
        : taskBound.length > 0
          ? "PARTIAL"
          : "NO",
    DISPATCH_USES_BRAIN_ASSIGNMENT:
      attempts.length > 0 && attemptsWithBrain.length === attempts.length
        ? "YES"
        : attemptsWithBrain.length > 0
          ? "PARTIAL"
          : "NO",
    DISPATCH_CHANGED_BY_BRAIN: attempts.some((a) => a.workforce?.complexityRaised === true)
      ? "YES"
      : "NO",
    REVIEWER_BRAIN_IN_LEDGER: ledger.some((l) => l.brain_id === "brain-reviewer") ? "YES" : "NO",
    SETTLEMENT: mission?.status ?? "UNSETTLED",
    REVIEWS: reviews.length,
  });
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

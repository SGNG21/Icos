/**
 * ONE ordinary, harmless live mission, driven through the CANONICAL services.
 *
 * Goal intake (`goalNormalizer` → `goalPlanner` → `goalRepository`) then the Durable
 * Scheduler's own `start_mission` entry — the same two steps `MissionGateway.launch`
 * performs when a conversation proposal is approved (decision 0056). Nothing is inserted
 * with raw SQL and no service or policy layer is bypassed.
 *
 * WHAT THIS DOES NOT EXERCISE, stated rather than implied: the HTTP/session layer and the
 * conversation front end, because every canonical entry point is authenticated and the
 * owner credential is compromised and pending rotation. Chief delegation is likewise not
 * on this path — `chiefDelegation` has no runtime caller.
 *
 *   pnpm exec tsx scripts/ordinary-live-e2e.ts
 *
 * Read-only objective. Prints ids, states and counts; never a secret.
 */
import { createContainer } from "@/server/container";
import { loadEnv } from "@/config/env";

const OBJECTIVE =
  "Analyse l'état actuel d'ICOS et donne-moi un rapport court sans modifier le système.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.PERSISTENCE !== "postgres") throw new Error("PERSISTENCE=postgres est requis.");

  const container = await createContainer();
  const stamp = Date.now();

  // 1. Goal intake — the canonical normalizer + planner + durable store.
  const goal = container.goalNormalizer.normalize({
    title: "Analyse de l'état d'ICOS",
    objective: OBJECTIVE,
    successCriteria: ["un rapport court et lisible"],
  } as never);
  const preview = container.goalPlanner.plan(goal);
  /*
   * `GoalPreviewStore.store` is what persists the goal AND its preview (it calls
   * `GoalRepository.create` itself). The id is derived from title+objective, so a re-run
   * addresses the same goal and must not try to create it twice.
   */
  const existing = await container.goalRepository.getById(goal.id);
  if (!existing) await container.goalPreviewStore.store(goal.id, goal, preview);
  console.log(JSON.stringify({ step: "goal_created", goalId: goal.id }));

  // 2. The canonical Durable Scheduler entry. The missionId is fixed at enqueue time.
  /*
   * A goal converts at most once. If it already has its mission, adopt it and complete the
   * link rather than enqueueing a second ignition the unique index would refuse — the same
   * idempotent repair the conversion endpoint performs.
   */
  const prior = await container.mission.findByGoalId(goal.id);
  if (prior) {
    await container.goalRepository.setConverted(goal.id, prior.id);
    console.log(JSON.stringify({ step: "adopted_existing_mission", missionId: prior.id }));
  }

  // The scheduler mints the missionId at enqueue time so a replay after a crash is safe.
  const job = prior
    ? { job: { id: "<not enqueued: mission already exists>", missionId: prior.id }, created: false }
    : ((await container.scheduler.enqueue({
    kind: "start_mission",
    payload: { title: goal.title, objective: OBJECTIVE, goalId: goal.id },
    idempotencyKey: `ordinary-live-e2e:${stamp}`,
    runAt: new Date().toISOString(),
  } as never)) as { job: { id: string; missionId?: string | null }; created: boolean });
  const missionId = prior ? prior.id : (job.job.missionId ?? "");
  console.log(
    JSON.stringify({ step: "enqueued", missionId, jobId: job.job.id, created: job.created }),
  );
  if (!missionId) throw new Error("SCHEDULER_RETURNED_NO_MISSION_ID");

  // 3. Watch the runtime work it. The scheduler owns the loop; this only observes.
  for (let i = 0; i < 60; i += 1) {
    await sleep(5000);
    const mission = await container.mission.findById(missionId);
    const tasks = mission ? await container.mission.listTasks(missionId) : [];
    const [record] = (await container.goalRepository.list({ limit: 200 })).filter(
      (r) => r.goal.id === goal.id,
    );
    console.log(
      JSON.stringify({
        t: (i + 1) * 5,
        missionStatus: mission?.status ?? "<no mission yet>",
        missionGoalId: mission?.goalId ?? null,
        goalStatus: record?.status ?? null,
        resultingMissionId: record?.resultingMissionId ?? null,
        tasks: tasks.map((t) => t.status),
      }),
    );
    if (mission && ["succeeded", "failed", "cancelled"].includes(mission.status)) break;
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause) console.error("CAUSE:", cause);
  process.exit(1);
});

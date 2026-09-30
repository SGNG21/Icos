/**
 * Live certification of Conversation → CORE3 (decision 0056 — authored as 0057 on the lane). Two separate processes:
 *
 *   initiate  — the "request": real cognitive runtime (cognitiveRuntimeFor(container), real
 *               OmniRoute engine from env) submits ONE text turn; if and only if the REAL model
 *               returns a MISSION_REQUEST, the conversation owner approves it (policy step) and
 *               the process EXITS right after LAUNCHED. No JSON is injected or repaired.
 *   schedule  — a separate process standing for the production scheduler: CORE3's own
 *               DurableScheduler + createSchedulerHandlers with the REAL configured planner
 *               (container.autonomousPlanner). Task dispatch is INTERCEPTED by a recorder and
 *               no workspace coordinator is composed, so no worker or git worktree is launched
 *               (non-destructive; shared Temporal untouched).
 *
 * Test database only (asserted). Prints ids, model names, timings, states — never a secret.
 */
import { sql } from "drizzle-orm";

import { loadEnv } from "../src/config/env";
import { buildPostgresContainer } from "../src/server/container";
import { assertSafeTestDatabaseUrl } from "../src/server/database/test-database-guard";
import { cognitiveRuntimeFor } from "../src/server/cognitive/index";
import { DurableScheduler } from "../src/server/scheduler/durable-scheduler";
import { createSchedulerHandlers } from "../src/server/scheduler/scheduler-handlers";
import { SupervisorService } from "../src/server/supervisor/supervisor-service";

const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));

async function container() {
  const url = process.env.DATABASE_URL ?? "";
  assertSafeTestDatabaseUrl(url);
  return buildPostgresContainer(url, undefined, loadEnv(process.env));
}

async function initiate(): Promise<void> {
  // Observe (not alter) the chat completion responses to record the effective model.
  const realFetch = globalThis.fetch;
  const calls: { model: string | null; status: number; ms: number }[] = [];
  globalThis.fetch = async (input, init) => {
    const t = Date.now();
    const res = await realFetch(input, init);
    if (String(input).endsWith("/v1/chat/completions")) {
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as { model?: string } | null;
      calls.push({ model: body?.model ?? null, status: res.status, ms: Date.now() - t });
    }
    return res;
  };
  const c = await container();
  const runtime = cognitiveRuntimeFor(c)!;
  const actor = { tenantId: "default", userId: "live-certification-owner", roles: ["owner"] };
  const conversation = await runtime.createConversation(actor, {
    title: "Certification live",
    clientId: "lds-renov",
  });
  const started = Date.now();
  const result = await runtime.submitTurn(actor, conversation.id, {
    text:
      "ICOS, lance une mission : analyse en lecture seule pourquoi le site de LDS Renov " +
      "pourrait perdre des demandes de devis, et liste les corrections possibles. Ne modifie rien.",
    idempotencyKey: `live-cert-${Date.now()}`,
  });
  const latencyMs = Date.now() - started;
  const report: Record<string, unknown> = {
    engine: runtime.engineLabel,
    requestedModel: process.env.ICOS_COGNITIVE_MODEL ?? null,
    modelCalls: calls,
    latencyMs,
    conversationId: conversation.id,
    turnId: result.turn.id,
    turnStatus: result.turn.status,
    outcome: result.turn.outcome,
    failureReason: result.turn.failureReason,
    replyExcerpt: result.reply?.content.parts[0].text.slice(0, 400) ?? null,
    proposal: result.proposal,
  };
  if (result.turn.outcome !== "MISSION_REQUEST" || !result.proposal) {
    report.FAILURE_CLASS =
      result.turn.status !== "completed"
        ? `TURN_${result.turn.status.toUpperCase()}`
        : `MODEL_DID_NOT_RETURN_MISSION_REQUEST(outcome=${result.turn.outcome})`;
    report.events = (await runtime.events(actor, conversation.id, 0)).map(
      (e) => `${e.seq}:${e.type}`,
    );
    out(report);
    process.exit(3); // stop: no manual repair, no approval
  }
  // Policy step: the conversation owner approves the proposal (no stage advancement).
  const decided = await runtime.decideProposal(
    actor,
    conversation.id,
    result.proposal.id,
    "approve",
  );
  report.approval = decided.ok ? decided.proposal : decided;
  report.events = (await runtime.events(actor, conversation.id, 0)).map(
    (e) => `${e.seq}:${e.type}`,
  );
  const [job] = await c.db!.execute(
    sql`select id, kind, state, idempotency_key, mission_id, payload from scheduled_jobs where mission_id = ${
      decided.ok ? decided.proposal.missionId : ""
    }`,
  );
  report.schedulerJob = job ?? null;
  report.missionRowAtRequestEnd = decided.ok
    ? ((await c.mission.findById(decided.proposal.missionId!)) ?? "NOT_YET_CREATED")
    : null;
  out(report);
  // The initiating "request" ends here: no sweep, no cleanup, hard exit.
  process.exit(0);
}

async function schedule(missionId: string): Promise<void> {
  const c = await container();
  if (!c.autonomousPlanner) {
    out({ PLANNER: "NOT_CONFIGURED" });
    process.exit(4);
  }
  const intercepted: { taskId: string; workerKind?: string }[] = [];
  const recorder = {
    dispatch: async (input: { workflowId?: string; taskId: string; workerKind?: string }) => {
      intercepted.push({ taskId: input.taskId, workerKind: input.workerKind });
      return { workflowId: input.workflowId ?? `intercepted-${input.taskId}` };
    },
  };
  const supervisor = new SupervisorService(
    c.mission,
    c.tasks,
    recorder as never,
    c.durableMemory,
    c.dispatchAttempts,
  );
  const handlers = createSchedulerHandlers({
    ignite: {
      missions: c.mission,
      runtimeRepository: c.autonomousRuntime,
      supervisor,
      planner: c.autonomousPlanner,
    },
    missions: c.mission,
    wakeup: { wake: async () => null },
  });
  const scheduler = new DurableScheduler(c.scheduledJobs, handlers, { leaseMs: 180_000 });
  const started = Date.now();
  const sweeps = [];
  for (let i = 0; i < 5; i++) {
    const r = await scheduler.sweep();
    sweeps.push({
      discovered: r.discovered,
      succeeded: r.succeeded,
      failed: r.failed,
      errors: r.failures.map((f) => String(f.error).slice(0, 200)),
    });
    const [job] = await c.db!.execute(
      sql`select state from scheduled_jobs where mission_id = ${missionId}`,
    );
    if (job && job.state !== "scheduled" && job.state !== "running") break;
    await new Promise((res) => setTimeout(res, 2_000));
  }
  const [job] = await c.db!.execute(
    sql`select id, state, attempt_count, last_error from scheduled_jobs where mission_id = ${missionId}`,
  );
  const mission = await c.mission.findById(missionId);
  const tasks = mission ? await c.mission.listTasks(missionId) : [];
  const runtime = await c.autonomousRuntime.get(missionId);
  const plans = await c.db!.execute(
    sql`select plan_id, goal_id, version from autonomous_plans where mission_id = ${missionId}`,
  );
  out({
    plannerModel: process.env.ICOS_PLANNER_MODEL ?? null,
    elapsedMs: Date.now() - started,
    sweeps,
    schedulerJob: job ?? null,
    mission,
    autonomousRuntime: runtime ? { state: runtime.state } : null,
    plannedTasks: tasks.map((t) => ({
      title: t.title,
      status: t.status,
      workerKind: t.workerKind,
    })),
    planLineage: plans,
    dispatchIntercepted: intercepted.length,
  });
  await c.close();
  process.exit(0);
}

const [mode, arg] = process.argv.slice(2);
(mode === "initiate" ? initiate() : schedule(arg ?? "")).catch((error: unknown) => {
  out({
    FATAL: error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : String(error),
  });
  process.exit(1);
});

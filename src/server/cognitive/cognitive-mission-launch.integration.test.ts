import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CognitionOutput, ConversationEvent } from "@/core/cognitive/contracts";
import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { DurableScheduler } from "@/server/scheduler/durable-scheduler";
import { createSchedulerHandlers } from "@/server/scheduler/scheduler-handlers";
import { SupervisorService } from "@/server/supervisor/supervisor-service";

import { buildCognitiveRuntime, type CognitiveActor } from "./index";
import { PostgresConversationStore } from "./conversation-store";
import { CanonicalGoalLauncher, type MissionGateway } from "./mission-gateway";
import { answer, ScriptedCognitionEngine } from "./testing/support";
import { CognitiveTurnStream, TurnStreamTimeoutError } from "./voice-adapter";

/**
 * Conversation → approved GoalProposal → canonical CORE3 mission (decision 0056), on real
 * PostgreSQL. The cognitive runtime is composed exactly as `cognitiveRuntimeFor` does
 * (CanonicalGoalLauncher over the container's goal intake + SchedulerService). The
 * scheduler/supervisor side below stands for the production-services process: it is the
 * CORE3 composition (createSchedulerHandlers + SupervisorService), never built by the
 * cognitive runtime.
 */
const TENANT = "default";
const ME: CognitiveActor = { tenantId: TENANT, userId: "user-geoffrey", roles: ["owner"] };
let container: Container;
let key = 0;
const k = () => `launch-key-${String(++key).padStart(6, "0")}`;

const missionRequest: CognitionOutput = {
  result: {
    kind: "MISSION_REQUEST",
    text: "Je propose une mission.",
    goal: {
      title: "Analyse leads LDS Renov",
      objective: "Analyser pourquoi LDS Renov perd des leads et corriger ce qui peut l'être",
      successCriteria: [],
      constraints: [],
      riskLevel: "reversible",
    },
  },
  memorySuggestions: [],
};

const dispatch = vi.fn(async (input: { workflowId?: string; taskId: string }) => ({
  workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
}));
const planner = {
  plan: vi.fn(async () => ({
    version: 1,
    tasks: [{ key: "a", title: "Diagnostic", description: "Return exactly: OK", dependsOn: [] }],
  })),
};

/** CORE3's production composition of the Durable Scheduler (see production-services.ts). */
function core3Scheduler(): DurableScheduler {
  const supervisor = new SupervisorService(
    container.mission,
    container.tasks,
    { dispatch } as never,
    container.durableMemory,
    container.dispatchAttempts,
  );
  const handlers = createSchedulerHandlers({
    ignite: {
      missions: container.mission,
      runtimeRepository: container.autonomousRuntime!,
      supervisor,
      planner: planner as never,
    },
    missions: container.mission,
    wakeup: { wake: vi.fn().mockResolvedValue(null) },
  });
  return new DurableScheduler(container.scheduledJobs, handlers, { leaseMs: 60_000 });
}

const runtimeWith = (
  engine: ScriptedCognitionEngine,
  missions: MissionGateway = new CanonicalGoalLauncher(container),
) => buildCognitiveRuntime(container.db!, { engine, missions, operational: null });

/** Matches the PostgreSQL error (message or constraint) behind drizzle's wrapper. */
function pgError(re: RegExp) {
  return (error: unknown): boolean => {
    for (
      let e = error as { message?: string; constraint_name?: string; cause?: unknown } | undefined;
      e;
      e = e.cause as typeof e
    ) {
      if (re.test(e.message ?? "") || re.test(e.constraint_name ?? "")) return true;
    }
    return false;
  };
}

const count = async (table: string) =>
  Number((await container.db!.execute(sql.raw(`select count(*)::int as n from ${table}`)))[0].n);

async function proposeGoal() {
  const rt = runtimeWith(new ScriptedCognitionEngine(() => missionRequest));
  const conv = await rt.createConversation(ME, { clientId: "lds-renov" });
  const res = await rt.submitTurn(ME, conv.id, {
    text: "ICOS, analyse pourquoi LDS Renov perd des leads.",
    idempotencyKey: k(),
  });
  return { rt, conv, ref: res.proposal!, turn: res.turn };
}

beforeAll(async () => {
  container = await buildPostgresContainer(
    TEST_DATABASE_URL,
    undefined,
    loadEnv({
      NODE_ENV: "test",
      PERSISTENCE: "postgres",
      DATABASE_URL: TEST_DATABASE_URL,
      OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
      OMNIROUTE_API_KEY: "cognitive-test-key",
      ICOS_REVIEWER_MODEL: "cognitive-test-reviewer",
      ICOS_REVIEWER_TIMEOUT_MS: "1000",
    }),
  );
});

beforeEach(async () => {
  vi.clearAllMocks();
  await container.db!.execute(
    sql.raw(`TRUNCATE TABLE cognitive_events, cognitive_context_snapshots, cognitive_turn_refs, cognitive_turns,
      cognitive_participants, cognitive_conversations, memory_records, memory_relations, memory_entities,
      goal_previews, goals, scheduled_jobs, missions, tasks, actions, decisions RESTART IDENTITY CASCADE`),
  );
});

afterAll(async () => {
  await container?.close();
});

describe("Conversation → canonical CORE3 mission", () => {
  it("L1 — a text turn produces a durable CORE3 mission after human approval, with no operator stage advancement", async () => {
    const { rt, conv, ref, turn } = await proposeGoal();
    expect(ref.status).toBe("approval_required");
    const decided = await rt.decideProposal(ME, conv.id, ref.id, "approve");
    const launched = decided.ok ? decided.proposal : null;
    expect(launched?.status).toBe("launched");

    // The production DurableScheduler picks the job up on its own timer: one sweep here.
    const sweep = await core3Scheduler().sweep();
    expect(sweep).toMatchObject({ discovered: 1, succeeded: 1, failed: 0 });

    const mission = await container.mission.findById(launched!.missionId!);
    expect(mission).toMatchObject({
      id: launched!.missionId,
      goalId: launched!.goalId,
      objective:
        missionRequest.result.kind === "MISSION_REQUEST"
          ? missionRequest.result.goal.objective
          : "",
    });
    expect(planner.plan).toHaveBeenCalledTimes(1); // CORE3's own planner planned it
    expect(await container.autonomousRuntime!.get(launched!.missionId!)).not.toBeNull();
    expect((await container.mission.listTasks(launched!.missionId!)).length).toBe(1);
    expect(dispatch).toHaveBeenCalled(); // governed supervisor dispatched through the ledger

    // Provenance round-trip: mission → goal → conversation / turn / proposal / client.
    const [goal] = await container.db!.execute(
      sql`select metadata from goals where id = ${launched!.goalId}`,
    );
    expect(goal.metadata).toMatchObject({
      conversationId: conv.id,
      turnId: turn.id,
      proposalRefId: ref.id,
      clientId: "lds-renov",
    });

    // A second sweep or a relaunch never creates a second mission.
    await core3Scheduler().sweep();
    await rt.recoverLaunches(TENANT);
    expect(await count("missions")).toBe(1);
    expect(await count("scheduled_jobs")).toBe(1);
  });

  it("L2 — a crash after the approval commit (before or during launch) is finished by recovery, exactly once", async () => {
    const a = await proposeGoal();
    const store = new PostgresConversationStore(container.db!);
    // Process A: the approval is committed, then the process dies before launching.
    await store.decideRef({ tenantId: TENANT, userId: ME.userId }, a.conv.id, a.ref.id, "approve");
    // Process B: the approval was committed and LAUNCHING recorded, then it died.
    const c = await (async () => {
      const rt = runtimeWith(
        new ScriptedCognitionEngine(() => ({
          ...missionRequest,
          result: {
            ...missionRequest.result,
            goal: { ...(missionRequest.result as { goal: object }).goal, title: "Autre analyse" },
          } as CognitionOutput["result"],
        })),
      );
      const conv = await rt.createConversation(ME, {});
      const r = await rt.submitTurn(ME, conv.id, { text: "autre", idempotencyKey: k() });
      const d = await store.decideRef(
        { tenantId: TENANT, userId: ME.userId },
        conv.id,
        r.proposal!.id,
        "approve",
      );
      await store.beginLaunch(TENANT, d.ok ? d.ref : r.proposal!);
      return { conv, ref: r.proposal! };
    })();
    expect((await store.listRefs(c.conv.id))[0].status).toBe("launching");

    // After restart: three concurrent recoveries (e.g. several replicas) → one job each.
    const fresh = runtimeWith(new ScriptedCognitionEngine(() => answer("x")));
    await Promise.all([
      fresh.recoverLaunches(TENANT),
      fresh.recoverLaunches(TENANT),
      fresh.recoverLaunches(TENANT),
    ]);
    const [ra] = await store.listRefs(a.conv.id);
    const [rc] = await store.listRefs(c.conv.id);
    expect([ra.status, rc.status]).toEqual(["launched", "launched"]);
    expect(await count("scheduled_jobs")).toBe(2);
    const launchedEvents = (await store.listEvents(a.conv.id, 0)).filter(
      (e) => e.type === "proposal.launched",
    );
    expect(launchedEvents).toHaveLength(1);
  });

  it("L3 — a transient launch failure keeps the approval (LAUNCHING) and a later recovery launches it", async () => {
    const { conv, ref } = await proposeGoal();
    const down: MissionGateway = {
      launch: async () => {
        throw new Error("PERSISTENCE_DOWN");
      },
    };
    const broken = runtimeWith(new ScriptedCognitionEngine(() => answer("x")), down);
    await expect(broken.decideProposal(ME, conv.id, ref.id, "approve")).rejects.toThrow(
      "PERSISTENCE_DOWN",
    );
    const store = new PostgresConversationStore(container.db!);
    expect((await store.listRefs(conv.id))[0]).toMatchObject({
      status: "launching",
      decidedBy: ME.userId,
    });
    await runtimeWith(new ScriptedCognitionEngine(() => answer("x"))).recoverLaunches(TENANT);
    expect((await store.listRefs(conv.id))[0].status).toBe("launched");
  });

  it("L4 — the same goal text from another proposal fails closed instead of attaching to the wrong mission", async () => {
    const first = await proposeGoal();
    const second = await proposeGoal();
    const d1 = await first.rt.decideProposal(ME, first.conv.id, first.ref.id, "approve");
    const d2 = await second.rt.decideProposal(ME, second.conv.id, second.ref.id, "approve");
    expect(d1.ok && d1.proposal.status).toBe("launched");
    expect(d2.ok && d2.proposal).toMatchObject({
      status: "failed",
      failureReason: "goal_id_collision",
    });
    expect(await count("scheduled_jobs")).toBe(1);
  });
});

describe("Acceptance semantics (Voice / phone) and disconnect durability", () => {
  it("V1 — acceptTurn returns the durable turn identity before cognition finishes; a dropped caller does not cancel it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rt = runtimeWith(
      new ScriptedCognitionEngine(async () => {
        await gate;
        return answer("réponse complète");
      }),
    );
    const conv = await rt.createConversation(ME, {});
    const accepted = await rt.acceptTurn(ME, conv.id, {
      text: "question longue",
      idempotencyKey: k(),
    });
    expect(accepted.replayed).toBe(false);
    const store = new PostgresConversationStore(container.db!);
    expect(["received", "processing"]).toContain(
      (await store.getTurn(conv.id, accepted.turn.id))!.status,
    );
    // Idempotent re-accept (client retry after a dropped connection) returns the same turn.
    expect(
      (
        await rt.acceptTurn(ME, conv.id, {
          text: "question longue",
          idempotencyKey: accepted.turn.idempotencyKey!,
        })
      ).turn.id,
    ).toBe(accepted.turn.id);
    // The HTTP caller is gone; the turn keeps going server-side.
    release();
    await rt.drain();
    const turns = await store.listTurns(conv.id);
    expect(turns.map((t) => [t.role, t.status])).toEqual([
      ["user", "completed"],
      ["assistant", "completed"],
    ]);
  });

  it("V2 — the voice adapter streams this turn's durable events and maps abort to cancelTurn", async () => {
    const rt = runtimeWith(new ScriptedCognitionEngine(() => answer("ok voix")));
    const conv = await rt.createConversation(ME, {});
    const voice = new CognitiveTurnStream(rt, ME, 20);
    const ok = await voice.submitCommittedTurn(
      { conversationId: conv.id, clientTurnId: "voice-turn-0001", text: "bonjour" },
      new AbortController().signal,
    );
    const seen: ConversationEvent[] = [];
    for await (const e of ok.events) seen.push(e);
    expect(seen.map((e) => e.type)).toEqual([
      "turn.received",
      "turn.processing",
      // Client/project resolution is observable for every turn, before assembly (decision 0063).
      "context.resolved",
      "context.assembled",
      "turn.completed",
    ]);
    expect(seen.every((e) => e.turnId === ok.turnId)).toBe(true);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = runtimeWith(
      new ScriptedCognitionEngine(async (_i, signal) => {
        await Promise.race([
          gate,
          new Promise((_r, reject) =>
            signal.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
        ]);
        return answer("trop tard");
      }),
    );
    const c2 = await slow.createConversation(ME, {});
    const barge = new AbortController();
    const interrupted = await new CognitiveTurnStream(slow, ME, 20).submitCommittedTurn(
      { conversationId: c2.id, clientTurnId: "voice-turn-0002", text: "raconte" },
      barge.signal,
    );
    await new Promise((r) => setTimeout(r, 200));
    barge.abort(); // barge-in
    const types: string[] = [];
    for await (const e of interrupted.events) types.push(e.type);
    expect(types.at(-1)).toBe("turn.cancelled");
    release();
    await slow.drain();
    const turns = await new PostgresConversationStore(container.db!).listTurns(c2.id);
    expect(turns.map((t) => [t.role, t.status])).toEqual([["user", "cancelled"]]); // accepted, never un-accepted
  });
});

describe("Voice stream deadline", () => {
  it("V3 — a stream that waits too long fails with a typed timeout and never cancels the accepted turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rt = runtimeWith(
      new ScriptedCognitionEngine(async () => {
        await gate;
        return answer("enfin");
      }),
    );
    const conv = await rt.createConversation(ME, {});
    const stream = new CognitiveTurnStream(rt, ME, 20, 300);
    const accepted = await stream.submitCommittedTurn(
      { conversationId: conv.id, clientTurnId: "voice-turn-0003", text: "lent" },
      new AbortController().signal,
    );
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const e of accepted.events) seen.push(e.type);
      })(),
    ).rejects.toBeInstanceOf(TurnStreamTimeoutError);
    expect(seen).not.toContain("turn.cancelled");
    release();
    await rt.drain();
    const [turn] = await new PostgresConversationStore(container.db!).listTurns(conv.id);
    expect(turn.status).toBe("completed");
  });
});

describe("Model-inferred memory review", () => {
  it("M1 — MODEL_INFERRED → candidate → human review → active, still labelled as an inference", async () => {
    const rt = runtimeWith(
      new ScriptedCognitionEngine(() =>
        answer("noté", {
          memorySuggestions: [
            {
              type: "semantic",
              subjectKey: "lds.crm",
              content: "LDS Renov utilise HubSpot comme CRM",
            },
          ],
        }),
      ),
    );
    const conv = await rt.createConversation(ME, { clientId: "lds-renov" });
    await rt.submitTurn(ME, conv.id, { text: "Parlons du CRM de LDS Renov", idempotencyKey: k() });
    const scope = { clientId: "lds-renov", projectId: null };
    const [candidate] = await rt.memoryCandidates(ME, scope);
    expect(candidate).toMatchObject({
      epistemic: "MODEL_INFERRED",
      statementKind: "inference",
      status: "candidate",
      reviewedBy: null,
    });

    // Never usable before review; the database itself refuses a silent promotion.
    const probe = await rt.submitTurn(ME, conv.id, {
      text: "Quel CRM utilise LDS Renov ?",
      idempotencyKey: k(),
    });
    expect(
      JSON.stringify((await rt.getContext(ME, conv.id, probe.turn.id))!.snapshot.items),
    ).not.toContain(candidate.id);
    await expect(
      container.db!.execute(
        sql`update memory_records set status = 'active' where id = ${candidate.id}`,
      ),
    ).rejects.toSatisfy(pgError(/memory_records_reviewed_promotion_check/));

    const accepted = await rt.reviewMemory(ME, scope, candidate.id, "accept");
    expect(accepted).toMatchObject({
      status: "active",
      epistemic: "MODEL_INFERRED",
      statementKind: "inference",
      reviewedBy: ME.userId,
    });
    const after = await rt.submitTurn(ME, conv.id, {
      text: "Quel CRM utilise LDS Renov ?",
      idempotencyKey: k(),
    });
    const item = (await rt.getContext(ME, conv.id, after.turn.id))!.snapshot.items.find(
      (i) => i.ref === `memory:${candidate.id}`,
    );
    expect(item).toMatchObject({ epistemic: "MODEL_INFERRED" });
    expect(item!.text).toContain("[semantic/inference]");
    // A second review is refused; the recorded review is immutable.
    expect(await rt.reviewMemory(ME, scope, candidate.id, "reject")).toBeNull();
    await expect(
      container.db!.execute(
        sql`update memory_records set reviewed_by = 'someone-else' where id = ${candidate.id}`,
      ),
    ).rejects.toSatisfy(pgError(/a recorded review is immutable/));
  });
});

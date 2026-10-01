import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { CognitionOutput, GoalProposal } from "@/core/cognitive/contracts";
import type { DatabaseHandle } from "@/server/database/client";
import { PostgresGoalRepository } from "@/server/repositories/postgres/goal-repository";
import { PostgresScheduledJobRepository } from "@/server/scheduler/postgres-scheduled-job-repository";
import { SchedulerService } from "@/server/scheduler/scheduler-service";
import { GoalNormalizer } from "@/server/services/goal-normalizer";
import { GoalPlanner } from "@/server/services/goal-planner";
import { GoalPreviewStore } from "@/server/services/goal-preview-store";

import { MISSING_BUSINESS_DATA, SEED_CLIENTS, seedClientDirectory } from "./client-directory-seed";
import { PostgresConversationStore } from "./conversation-store";
import type { MissionStatusReader } from "./current-state-source";
import { buildCognitiveRuntime, type CognitiveActor } from "./index";
import { PostgresCognitiveMemoryStore } from "./memory-store";
import { CanonicalGoalLauncher } from "./mission-gateway";
import { answer, openTestDb, resetCognitive, ScriptedCognitionEngine } from "./testing/support";

/**
 * Client context / memory / client knowledge — REAL PostgreSQL proofs (decision 0062).
 *
 * Every proof runs against the durable store: no in-memory double stands in for the
 * authority. Each `it` names the required test-matrix entry it establishes.
 */
const TENANT = "default";
const OTHER_TENANT = "tenant-other";
const ME: CognitiveActor = { tenantId: TENANT, userId: "user-geoffrey", roles: ["owner"] };
const OTHER_TENANT_ACTOR: CognitiveActor = {
  tenantId: OTHER_TENANT,
  userId: "user-geoffrey",
  roles: ["owner"],
};

const LDS = "lds-renov";
const MECENE = "editions-du-mecene";

let key = 0;
const k = () => `ctx-key-${String(++key).padStart(6, "0")}`;

let handle: DatabaseHandle;
const handles: DatabaseHandle[] = [];
const open = () => {
  const h = openTestDb();
  handles.push(h);
  return h;
};

function gatewayFor(h: DatabaseHandle) {
  const goalRepository = new PostgresGoalRepository(h.db);
  return new CanonicalGoalLauncher({
    goalNormalizer: new GoalNormalizer(),
    goalPlanner: new GoalPlanner(),
    goalPreviewStore: new GoalPreviewStore(goalRepository),
    goalRepository,
    scheduler: new SchedulerService(new PostgresScheduledJobRepository(h.db)),
  });
}

interface RuntimeOptions {
  engine?: ScriptedCognitionEngine;
  missionStatus?: MissionStatusReader | null;
  h?: DatabaseHandle;
}
const runtimeWith = (options: RuntimeOptions = {}) => {
  const h = options.h ?? handle;
  return buildCognitiveRuntime(h.db, {
    engine: options.engine ?? new ScriptedCognitionEngine(() => answer("ok")),
    missions: gatewayFor(h),
    operational: null,
    missionStatus: options.missionStatus ?? null,
  });
};

/** Durable business knowledge, written through the governed path, never a prompt literal. */
async function seedKnowledge(memory: PostgresCognitiveMemoryStore): Promise<void> {
  await seedClientDirectory(memory, TENANT);
  const write = (clientId: string, subjectKey: string, content: string) =>
    memory.write(
      { tenantId: TENANT, userId: "user-geoffrey", clientId, projectId: null },
      {
        type: "project",
        subjectKey,
        content,
        epistemic: "USER_ASSERTED",
        statementKind: "fact",
        confidence: 1,
        originTrust: "trusted",
        provenance: {
          sourceType: "api",
          sourceId: "user:user-geoffrey",
          conversationId: null,
          turnId: null,
          engine: null,
        },
        entityKey: clientId,
      },
    );
  await write(LDS, "client.lds-renov.priorite", "Priorité LDS : fiabiliser le tunnel de devis.");
  await write(
    MECENE,
    "client.editions-du-mecene.priorite",
    "Priorité Mécène : préparer le lancement du prochain titre.",
  );
}

const textsOf = (inputs: readonly { context: string }[]) => inputs.map((i) => i.context);

beforeEach(async () => {
  handle ??= open();
  await resetCognitive(handle);
});
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

describe("BUSINESS SEEDING", () => {
  it("seeds only repository-supported identity, and is idempotent", async () => {
    const memory = new PostgresCognitiveMemoryStore(handle.db);
    const first = await seedClientDirectory(memory, TENANT);
    expect(first.entities).toBe(2);
    expect(first.facts.every((f) => f.outcome === "accepted")).toBe(true);

    const again = await seedClientDirectory(memory, TENANT);
    expect(again.facts.every((f) => f.outcome === "duplicate")).toBe(true);

    const directory = await memory.clientDirectory(TENANT, "sensitive");
    expect(directory.map((d) => d.key).sort()).toEqual([MECENE, LDS].sort());
  });

  it("reports missing business data instead of inventing it", () => {
    expect(MISSING_BUSINESS_DATA.length).toBeGreaterThan(0);
    const all = [...SEED_CLIENTS.flatMap((c) => c.facts.map((f) => f.content))].join(" ");
    // No placeholder business detail from the example blocks is ever seeded as a fact.
    for (const invented of ["Cannes", "RCS", "75001", "Lyon", "SARL", "SAS", "ldsrenov.fr"]) {
      expect(all).not.toContain(invented);
    }
    expect(MISSING_BUSINESS_DATA.join(" ")).toContain("Cannes");
  });
});

describe("A. « Où en est LDS ? » — LDS_CASE / CLIENT_RESOLUTION / CONTEXT_ASSEMBLY", () => {
  it("resolves LDS Rénov', scopes the conversation and feeds durable context to the model", async () => {
    const memory = new PostgresCognitiveMemoryStore(handle.db);
    await seedKnowledge(memory);
    const engine = new ScriptedCognitionEngine(() =>
      answer("Sur LDS, la priorité est le tunnel de devis."),
    );
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(ME, { title: "point client" });
    expect(conversation.clientId).toBeNull();

    const result = await runtime.submitTurn(ME, conversation.id, {
      text: "Où en est LDS ?",
      idempotencyKey: k(),
    });

    expect(result.turn.status).toBe("completed");
    expect(result.turn.clientId).toBe(LDS);
    const context = textsOf(engine.inputs).join("\n");
    expect(context).toContain("tunnel de devis");
    // MEMORY_RETRIEVAL: it came from the durable path, with its memory ref visible.
    const snapshot = await runtime.getContext(ME, conversation.id, result.turn.id);
    expect(snapshot?.memories.some((m) => m.subjectKey === "client.lds-renov.priorite")).toBe(true);

    // The conversation's durable pointer moved, with an observable resolution event.
    const events = await runtime.events(ME, conversation.id, 0);
    const resolved = events.find((e) => e.type === "context.resolved");
    expect(resolved?.payload).toMatchObject({ clientId: LDS, source: "alias", entityKey: LDS });
  });

  it("NO_STATIC_PROMPT_DUMP: with nothing seeded, no client knowledge appears at all", async () => {
    // Proof that the knowledge comes from the durable Context/Memory path and from nowhere
    // else: with an empty directory and empty memory, the same question yields no LDS fact.
    const engine = new ScriptedCognitionEngine(() => answer("ok"));
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(ME, {});
    const result = await runtime.submitTurn(ME, conversation.id, {
      text: "Où en est LDS ?",
      idempotencyKey: k(),
    });
    expect(result.turn.clientId).toBeNull();
    expect(engine.inputs[0].context).not.toContain("tunnel de devis");
    expect(engine.inputs[0].context).not.toContain("LDS Rénov");
  });

  it("NO_STATIC_PROMPT_DUMP: the prompt holds only the resolved client's bounded context", async () => {
    const memory = new PostgresCognitiveMemoryStore(handle.db);
    await seedKnowledge(memory);
    const engine = new ScriptedCognitionEngine(() => answer("ok"));
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(ME, {});
    await runtime.submitTurn(ME, conversation.id, { text: "Où en est LDS ?", idempotencyKey: k() });

    const context = engine.inputs[0].context;
    expect(context).toContain("tunnel de devis");
    expect(context).not.toContain("Mécène");
    expect(context).not.toContain("prochain titre");
    // Bounded: the snapshot respects the token budget and records what it dropped.
    const snapshot = await runtime.getContext(
      ME,
      conversation.id,
      (await runtime.resume(ME, conversation.id)).turns[0].id,
    );
    expect(snapshot!.snapshot.tokensUsed).toBeLessThanOrEqual(snapshot!.snapshot.tokenBudget);
  });
});

describe("B/C. CLIENT_SWITCH / RETURN_TO_PREVIOUS_CLIENT / CROSS_CLIENT_LEAKAGE", () => {
  it("switches to the Mécène with zero LDS leakage, then returns to LDS", async () => {
    const memory = new PostgresCognitiveMemoryStore(handle.db);
    await seedKnowledge(memory);
    const engine = new ScriptedCognitionEngine(() => answer("ok"));
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(ME, {});

    await runtime.submitTurn(ME, conversation.id, { text: "Où en est LDS ?", idempotencyKey: k() });
    // B — « Et le Mécène ? »
    const switched = await runtime.submitTurn(ME, conversation.id, {
      text: "Et le Mécène ?",
      idempotencyKey: k(),
    });
    expect(switched.turn.clientId).toBe(MECENE);

    const mecenePrompt = engine.inputs[1].context;
    expect(mecenePrompt).toContain("prochain titre");
    // ZERO leakage: neither LDS memory nor the LDS turns of this very conversation.
    expect(mecenePrompt).not.toContain("tunnel de devis");
    expect(mecenePrompt).not.toContain("LDS");

    // C — « Reviens à LDS. »
    const back = await runtime.submitTurn(ME, conversation.id, {
      text: "Reviens à LDS.",
      idempotencyKey: k(),
    });
    expect(back.turn.clientId).toBe(LDS);
    const ldsAgain = engine.inputs[2].context;
    expect(ldsAgain).toContain("tunnel de devis");
    expect(ldsAgain).not.toContain("prochain titre");

    // The previous pointer is durable, not an in-memory stack.
    const state = await runtime.resume(ME, conversation.id);
    expect(state.conversation.clientId).toBe(LDS);
    expect(state.conversation.previousClientId).toBe(MECENE);
  });

  it("« reviens en arrière » restores the previous scope from the durable pointer", async () => {
    const memory = new PostgresCognitiveMemoryStore(handle.db);
    await seedKnowledge(memory);
    const runtime = runtimeWith();
    const conversation = await runtime.createConversation(ME, {});
    await runtime.submitTurn(ME, conversation.id, { text: "Où en est LDS ?", idempotencyKey: k() });
    await runtime.submitTurn(ME, conversation.id, { text: "Et le Mécène ?", idempotencyKey: k() });
    const back = await runtime.submitTurn(ME, conversation.id, {
      text: "reviens en arrière",
      idempotencyKey: k(),
    });
    expect(back.turn.clientId).toBe(LDS);
  });

  it("SCOPE_ISOLATION: a client-scoped memory is invisible in another client's scope", async () => {
    const memory = new PostgresCognitiveMemoryStore(handle.db);
    await seedKnowledge(memory);
    const inMecene = await memory.activeInScope(
      { tenantId: TENANT, userId: ME.userId, clientId: MECENE, projectId: null },
      ["project"],
    );
    expect(inMecene.map((r) => r.subjectKey)).not.toContain("client.lds-renov.priorite");
    const unscoped = await memory.activeInScope(
      { tenantId: TENANT, userId: ME.userId, clientId: null, projectId: null },
      ["project"],
    );
    expect(unscoped).toHaveLength(0);
  });

  it("TENANT_ISOLATION: another tenant resolves nothing and sees nothing", async () => {
    const memory = new PostgresCognitiveMemoryStore(handle.db);
    await seedKnowledge(memory);
    expect(await memory.clientDirectory(OTHER_TENANT, "sensitive")).toEqual([]);
    const engine = new ScriptedCognitionEngine(() => answer("ok"));
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(OTHER_TENANT_ACTOR, {});
    const result = await runtime.submitTurn(OTHER_TENANT_ACTOR, conversation.id, {
      text: "Où en est LDS ?",
      idempotencyKey: k(),
    });
    expect(result.turn.clientId).toBeNull();
    expect(engine.inputs[0].context).not.toContain("tunnel de devis");
  });
});

describe("AMBIGUITY_HANDLING / FAIL_CLOSED", () => {
  it("asks instead of guessing, consults no model, launches nothing and writes no memory", async () => {
    const memory = new PostgresCognitiveMemoryStore(handle.db);
    await seedKnowledge(memory);
    const engine = new ScriptedCognitionEngine(() => answer("NE DOIT PAS ÊTRE APPELÉ"));
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(ME, {});

    const result = await runtime.submitTurn(ME, conversation.id, {
      text: "Et le client de Cannes ?",
      idempotencyKey: k(),
    });

    expect(result.turn.outcome).toBe("CLARIFICATION");
    expect(result.reply?.content.parts[0].text).toContain("Je ne reconnais pas");
    expect(engine.inputs).toHaveLength(0); // the model was never consulted
    expect(result.proposal).toBeNull();
    // No guessed scope, no guessed memory.
    const state = await runtime.resume(ME, conversation.id);
    expect(state.conversation.clientId).toBeNull();
    const rows =
      await handle.sql`select count(*)::int as n from memory_records where type = 'episodic'`;
    expect(rows[0].n).toBe(0);
    const events = await runtime.events(ME, conversation.id, 0);
    expect(events.find((e) => e.type === "context.resolved")?.payload).toMatchObject({
      ambiguity: "unknown_reference",
    });
  });

  it("a STRONG deictic with no active scope asks rather than picking a client", async () => {
    await seedKnowledge(new PostgresCognitiveMemoryStore(handle.db));
    const runtime = runtimeWith();
    const conversation = await runtime.createConversation(ME, {});
    const result = await runtime.submitTurn(ME, conversation.id, {
      text: "relance ce client",
      idempotencyKey: k(),
    });
    expect(result.turn.outcome).toBe("CLARIFICATION");
    const rows = await handle.sql`select intent from cognitive_turns where id = ${result.turn.id}`;
    expect(rows[0].intent).toBe("context.no_current_context");
  });

  it("a bare pronoun is answered normally instead of interrogating the user", async () => {
    // Regression from the independent review: « ça » is ordinary French. The turn stays
    // unscoped — fail-safe, since no client knowledge can enter an unscoped prompt.
    await seedKnowledge(new PostgresCognitiveMemoryStore(handle.db));
    const engine = new ScriptedCognitionEngine(() => answer("Bonjour."));
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(ME, {});
    const result = await runtime.submitTurn(ME, conversation.id, {
      text: "ça va ?",
      idempotencyKey: k(),
    });
    expect(result.turn.outcome).toBe("ANSWER_ONLY");
    expect(result.turn.clientId).toBeNull();
    expect(engine.inputs[0].context).not.toContain("tunnel de devis");
  });
});

describe("CURRENT_CONTEXT_RESOLUTION across conversations", () => {
  it("« continue ce qu'on faisait » picks up the most recent durable scope", async () => {
    await seedKnowledge(new PostgresCognitiveMemoryStore(handle.db));
    const engine = new ScriptedCognitionEngine(() => answer("ok"));
    const runtime = runtimeWith({ engine });
    const first = await runtime.createConversation(ME, { title: "hier" });
    await runtime.submitTurn(ME, first.id, { text: "Où en est LDS ?", idempotencyKey: k() });

    const second = await runtime.createConversation(ME, { title: "aujourd'hui" });
    const result = await runtime.submitTurn(ME, second.id, {
      text: "Continue ce qu'on faisait.",
      idempotencyKey: k(),
    });
    expect(result.turn.clientId).toBe(LDS);
    expect(engine.inputs[1].context).toContain("tunnel de devis");
  });
});

describe("D. MISSION_CONTEXT_HANDOFF / NO_DIRECT_CORE3 / POLICY", () => {
  const goal: GoalProposal = {
    title: "Fiabiliser le tunnel de devis LDS",
    objective: "Analyser et corriger les pertes de leads du tunnel de devis.",
    successCriteria: [],
    constraints: [],
    riskLevel: "reversible",
  };
  const missionRequest = (): CognitionOutput => ({
    result: { kind: "MISSION_REQUEST", text: "Je propose cette mission.", goal },
    memorySuggestions: [],
  });

  it("« Occupe-toi de LDS » resolves the client BEFORE the goal, and approval is still required", async () => {
    await seedKnowledge(new PostgresCognitiveMemoryStore(handle.db));
    const engine = new ScriptedCognitionEngine(missionRequest);
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(ME, {});

    const result = await runtime.submitTurn(ME, conversation.id, {
      text: "Occupe-toi de LDS.",
      idempotencyKey: k(),
    });

    // Context was resolved and inspected before the proposal existed.
    expect(result.turn.clientId).toBe(LDS);
    expect(engine.inputs[0].context).toContain("tunnel de devis");
    // POLICY preserved: nothing auto-executes.
    expect(result.proposal).toMatchObject({
      status: "approval_required",
      clientId: LDS,
      missionId: null,
    });

    const decided = await runtime.decideProposal(
      ME,
      conversation.id,
      result.proposal!.id,
      "approve",
    );
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw new Error("unreachable");
    expect(decided.proposal.status).toBe("launched");

    // The resolved client reached CORE3 through the canonical goal path only.
    const goals =
      await handle.sql`select metadata from goals where id = ${decided.proposal.goalId!}`;
    expect(goals[0].metadata).toMatchObject({ clientId: LDS, source: "cognitive_conversation" });
    const jobs = await handle.sql`select kind, idempotency_key from scheduled_jobs`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe("start_mission");
  });

  it("a proposal launches under the scope it was MADE under, not the current pointer", async () => {
    await seedKnowledge(new PostgresCognitiveMemoryStore(handle.db));
    const engine = new ScriptedCognitionEngine((input) =>
      input.userText.includes("Occupe") ? missionRequest() : answer("ok"),
    );
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(ME, {});
    const proposed = await runtime.submitTurn(ME, conversation.id, {
      text: "Occupe-toi de LDS.",
      idempotencyKey: k(),
    });
    // The conversation moves to another client BEFORE the approval.
    await runtime.submitTurn(ME, conversation.id, { text: "Et le Mécène ?", idempotencyKey: k() });

    const decided = await runtime.decideProposal(
      ME,
      conversation.id,
      proposed.proposal!.id,
      "approve",
    );
    if (!decided.ok) throw new Error("unreachable");
    const goals =
      await handle.sql`select metadata from goals where id = ${decided.proposal.goalId!}`;
    expect(goals[0].metadata).toMatchObject({ clientId: LDS });
  });
});

describe("Review regressions (independent review of this lane)", () => {
  it("the reply and the proposal are stamped with the TURN's scope, not the live pointer", async () => {
    // The reply carries the knowledge of the scope its question was resolved under. If it were
    // stamped from the conversation's pointer, a later switch could re-expose it to the other
    // client through `recentTurns`.
    await seedKnowledge(new PostgresCognitiveMemoryStore(handle.db));
    const runtime = runtimeWith();
    const conversation = await runtime.createConversation(ME, { clientId: MECENE });
    const result = await runtime.submitTurn(ME, conversation.id, {
      text: "Où en est LDS ?",
      idempotencyKey: k(),
    });
    expect(result.turn.clientId).toBe(LDS);
    expect(result.reply?.clientId).toBe(LDS);
    const rows = await handle.sql`
      select client_id from cognitive_turns where conversation_id = ${conversation.id} order by seq`;
    expect(rows.map((r) => r.client_id)).toEqual([LDS, LDS]);
  });

  it("a degraded live reading does not suppress a memory that knows better", async () => {
    // With no mission-status reader, all ICOS knows is that the proposal was launched — which is
    // not a mission state. It must be offered as context WITHOUT claiming to be current state.
    const memory = new PostgresCognitiveMemoryStore(handle.db);
    await seedKnowledge(memory);
    const engine = new ScriptedCognitionEngine((input) =>
      input.userText.includes("Occupe")
        ? {
            result: {
              kind: "MISSION_REQUEST",
              text: "Je propose.",
              goal: {
                title: "Audit du tunnel de devis",
                objective: "Analyser le tunnel de devis LDS.",
                successCriteria: [],
                constraints: [],
                riskLevel: "reversible",
              },
            },
            memorySuggestions: [],
          }
        : answer("ok"),
    );
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(ME, {});
    const proposed = await runtime.submitTurn(ME, conversation.id, {
      text: "Occupe-toi de LDS.",
      idempotencyKey: k(),
    });
    const decided = await runtime.decideProposal(
      ME,
      conversation.id,
      proposed.proposal!.id,
      "approve",
    );
    if (!decided.ok) throw new Error("unreachable");
    await memory.write(
      { tenantId: TENANT, userId: ME.userId, clientId: LDS, projectId: null },
      {
        type: "episodic",
        subjectKey: "mission.audit.resultat",
        content: "L'audit du tunnel de devis a été livré.",
        epistemic: "SYSTEM_OBSERVED",
        statementKind: "observation",
        confidence: 1,
        originTrust: "trusted",
        provenance: {
          sourceType: "turn",
          sourceId: "turn-old",
          conversationId: conversation.id,
          turnId: null,
          engine: null,
        },
        entityKey: LDS,
        missionId: decided.proposal.missionId!,
      },
    );

    // missionStatus stays null: the degraded path.
    const observer = new ScriptedCognitionEngine(() => answer("ok"));
    const next = runtimeWith({ engine: observer });
    const c = await next.createConversation(ME, {});
    const turn = await next.submitTurn(ME, c.id, {
      text: "Où en est l'audit du tunnel de devis pour LDS ?",
      idempotencyKey: k(),
    });
    const context = observer.inputs[0].context;
    expect(context).toContain("état CORE3 non disponible");
    expect(context).not.toContain("état courant");
    // The memory survives: nothing was suppressed by a reading that knows no status.
    expect(context).toContain("a été livré");
    const snapshot = await next.getContext(ME, c.id, turn.turn.id);
    expect(snapshot!.snapshot.excluded.some((e) => e.reason === "stale")).toBe(false);
  });

  it("the DEFAULT runtime keeps client memory out of an unscoped conversation", async () => {
    // The pre-existing P5 proof pins resolution off; this one proves the same isolation with the
    // default runtime, using a question that names no client so no switch is expected.
    await seedKnowledge(new PostgresCognitiveMemoryStore(handle.db));
    const engine = new ScriptedCognitionEngine(() => answer("ok"));
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(ME, {});
    const result = await runtime.submitTurn(ME, conversation.id, {
      text: "Quelles sont les priorités du moment ?",
      idempotencyKey: k(),
    });
    expect(result.turn.clientId).toBeNull();
    expect(engine.inputs[0].context).not.toContain("tunnel de devis");
    expect(engine.inputs[0].context).not.toContain("prochain titre");
  });

  it("the bare common noun « mécène » is not an alias and does not move the scope", async () => {
    await seedKnowledge(new PostgresCognitiveMemoryStore(handle.db));
    const engine = new ScriptedCognitionEngine(() => answer("ok"));
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(ME, {});
    await runtime.submitTurn(ME, conversation.id, { text: "Où en est LDS ?", idempotencyKey: k() });
    const result = await runtime.submitTurn(ME, conversation.id, {
      text: "Un mécène a financé le chantier.",
      idempotencyKey: k(),
    });
    expect(result.turn.clientId).toBe(LDS);
  });
});

describe("TEMPORAL_PRECEDENCE", () => {
  it("a completed mission is never presented as running because an older memory says so", async () => {
    const memory = new PostgresCognitiveMemoryStore(handle.db);
    await seedKnowledge(memory);
    const engine = new ScriptedCognitionEngine((input) =>
      input.userText.includes("Occupe")
        ? {
            result: {
              kind: "MISSION_REQUEST",
              text: "Je propose.",
              goal: {
                title: "Audit du tunnel de devis",
                objective: "Analyser le tunnel de devis LDS.",
                successCriteria: [],
                constraints: [],
                riskLevel: "reversible",
              },
            },
            memorySuggestions: [],
          }
        : answer("ok"),
    );
    // Launch a mission for LDS, then record a memory claiming it is still running.
    const launcher = runtimeWith({ engine });
    const conversation = await launcher.createConversation(ME, {});
    const proposed = await launcher.submitTurn(ME, conversation.id, {
      text: "Occupe-toi de LDS.",
      idempotencyKey: k(),
    });
    const decided = await launcher.decideProposal(
      ME,
      conversation.id,
      proposed.proposal!.id,
      "approve",
    );
    if (!decided.ok) throw new Error("unreachable");
    const missionId = decided.proposal.missionId!;

    await memory.write(
      { tenantId: TENANT, userId: ME.userId, clientId: LDS, projectId: null },
      {
        type: "episodic",
        subjectKey: "mission.audit.state",
        content: "L'audit du tunnel de devis est en cours d'exécution.",
        epistemic: "SYSTEM_OBSERVED",
        statementKind: "observation",
        confidence: 1,
        originTrust: "trusted",
        provenance: {
          sourceType: "turn",
          sourceId: "turn-old",
          conversationId: conversation.id,
          turnId: null,
          engine: null,
        },
        entityKey: LDS,
        missionId,
      },
    );

    // The live reading says the mission is finished.
    const observer = new ScriptedCognitionEngine(() => answer("ok"));
    const live = runtimeWith({
      engine: observer,
      missionStatus: { findById: async () => ({ status: "completed" }) },
    });
    const next = await live.createConversation(ME, {});
    const turn = await live.submitTurn(ME, next.id, {
      text: "Où en est l'audit du tunnel de devis pour LDS ?",
      idempotencyKey: k(),
    });

    const context = observer.inputs[0].context;
    expect(context).toContain("état courant : completed");
    expect(context).not.toContain("en cours d'exécution");
    const snapshot = await live.getContext(ME, next.id, turn.turn.id);
    expect(snapshot!.snapshot.excluded.some((e) => e.reason === "stale")).toBe(true);
  });
});

describe("MEMORY_WRITEBACK / MEMORY_PROVENANCE", () => {
  it("writes back under the RESOLVED client, as a reviewable candidate with provenance", async () => {
    await seedKnowledge(new PostgresCognitiveMemoryStore(handle.db));
    const engine = new ScriptedCognitionEngine(() => ({
      result: { kind: "ANSWER_ONLY", text: "Noté." },
      memorySuggestions: [
        {
          type: "project" as const,
          subjectKey: "client.lds-renov.blocage",
          content: "Le formulaire de devis perdrait des leads à l'étape 3.",
          entityKey: LDS,
        },
      ],
    }));
    const runtime = runtimeWith({ engine });
    const conversation = await runtime.createConversation(ME, {});
    const result = await runtime.submitTurn(ME, conversation.id, {
      text: "Où en est LDS ?",
      idempotencyKey: k(),
    });

    const candidates = await runtime.memoryCandidates(ME, { clientId: LDS, projectId: null });
    const written = candidates.find((c) => c.subjectKey === "client.lds-renov.blocage");
    expect(written).toBeDefined();
    // A model suggestion is never an active fact and never escapes its client.
    expect(written!.status).toBe("candidate");
    expect(written!.epistemic).toBe("MODEL_INFERRED");
    expect(written!.statementKind).toBe("inference");
    expect(written!.clientId).toBe(LDS);
    expect(written!.provenance).toMatchObject({
      sourceType: "turn",
      conversationId: conversation.id,
      turnId: result.turn.id,
    });
    expect(written!.provenance.engine).toBe(engine.label);

    // The writeback is observable with its record ids and its scope.
    const events = await runtime.events(ME, conversation.id, 0);
    const payload = events.find((e) => e.type === "memory.written")!.payload as {
      results: { subjectKey: string; memoryId: string | null; clientId: string | null }[];
    };
    expect(payload.results.every((r) => r.clientId === LDS)).toBe(true);
    expect(payload.results.find((r) => r.subjectKey === "client.lds-renov.blocage")?.memoryId).toBe(
      written!.id,
    );
    // Invisible from another client, even as a candidate.
    expect(await runtime.memoryCandidates(ME, { clientId: MECENE, projectId: null })).toEqual([]);
  });
});

describe("E. RESTART_DURABILITY", () => {
  it("a brand-new runtime over the same database resolves the same client", async () => {
    await seedKnowledge(new PostgresCognitiveMemoryStore(handle.db));
    const firstEngine = new ScriptedCognitionEngine(() => answer("ok"));
    const first = runtimeWith({ engine: firstEngine });
    const conversation = await first.createConversation(ME, {});
    await first.submitTurn(ME, conversation.id, { text: "Où en est LDS ?", idempotencyKey: k() });
    await first.submitTurn(ME, conversation.id, { text: "Et le Mécène ?", idempotencyKey: k() });

    // Simulate the restart: a second handle, a second runtime, nothing shared in memory.
    const restarted = open();
    const engine = new ScriptedCognitionEngine(() => answer("ok"));
    const after = runtimeWith({ engine, h: restarted });
    const state = await after.resume(ME, conversation.id);
    expect(state.conversation.clientId).toBe(MECENE);
    expect(state.conversation.previousClientId).toBe(LDS);

    const back = await after.submitTurn(ME, conversation.id, {
      text: "Reviens à LDS.",
      idempotencyKey: k(),
    });
    expect(back.turn.clientId).toBe(LDS);
    expect(engine.inputs[0].context).toContain("tunnel de devis");
  });

  it("survives a REAL process kill: a child process resolves, dies, and the pointer is still there", async () => {
    await seedKnowledge(new PostgresCognitiveMemoryStore(handle.db));
    const { stdout } = await promisify(execFile)(
      "npx",
      [
        "tsx",
        "src/server/cognitive/testing/resolve-then-crash.ts",
        TENANT,
        ME.userId,
        "Où en est LDS ?",
      ],
      { cwd: process.cwd(), env: process.env },
    ).catch((error: unknown) => error as { stdout: string });
    const conversationId = /CONVERSATION (\S+)/.exec(stdout)?.[1];
    expect(conversationId).toBeDefined();

    const after = runtimeWith({ h: open() });
    const state = await after.resume(ME, conversationId!);
    expect(state.conversation.clientId).toBe(LDS);

    const store = new PostgresConversationStore(handle.db);
    const turns = await store.listTurns(conversationId!);
    expect(turns.length).toBeGreaterThanOrEqual(2); // the assertion below must not be vacuous
    expect(turns.every((t) => t.clientId === LDS)).toBe(true);
  });
});

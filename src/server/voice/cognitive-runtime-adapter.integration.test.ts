import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CognitionOutput } from "@/core/cognitive/contracts";
import { loadEnv } from "@/config/env";
import { buildCognitiveRuntime, type CognitiveActor } from "@/server/cognitive";
import { CanonicalGoalLauncher } from "@/server/cognitive/mission-gateway";
import { answer, ScriptedCognitionEngine } from "@/server/cognitive/testing/support";
import { buildPostgresContainer, type Container } from "@/server/container";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import type { CognitiveEvent, CommittedTurn } from "@/core/voice/contracts";

import { CognitiveRuntimeVoiceAdapter } from "./cognitive-runtime-adapter";

/*
 * Wave I6 proof: the voice transport reaches the REAL Cognitive Runtime (PostgreSQL) through the
 * canonical adapter, with acceptance semantics — not the retired CEO-conversation bridge.
 */
let container: Container;
const USER = "user-voice";
const ME: CognitiveActor = { tenantId: "default", userId: USER, roles: ["owner"] };

const turn = (overrides: Partial<CommittedTurn> = {}): CommittedTurn => ({
  conversationId: null,
  userId: USER,
  voiceSessionId: "vs-1",
  turnId: `voice-turn-${Math.random().toString(36).slice(2, 10)}`,
  text: "Bonjour ICOS",
  speechStartedAt: 0,
  speechEndedAt: 1000,
  ...overrides,
});

async function collect(events: AsyncIterable<CognitiveEvent>): Promise<CognitiveEvent[]> {
  const out: CognitiveEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const missionRequest: CognitionOutput = {
  result: {
    kind: "MISSION_REQUEST",
    text: "Je propose une mission.",
    goal: {
      title: "Analyse vocale",
      objective: "Analyser un projet à la demande vocale",
      successCriteria: [],
      constraints: [],
      riskLevel: "read_only",
    },
  },
  memorySuggestions: [],
};

beforeAll(async () => {
  container = await buildPostgresContainer(
    TEST_DATABASE_URL,
    undefined,
    loadEnv({
      NODE_ENV: "test",
      PERSISTENCE: "postgres",
      DATABASE_URL: TEST_DATABASE_URL,
      OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
      OMNIROUTE_API_KEY: "voice-test-key",
      ICOS_REVIEWER_MODEL: "voice-test-reviewer",
      ICOS_REVIEWER_TIMEOUT_MS: "1000",
    }),
  );
});

beforeEach(async () => {
  await container.db!.execute(
    sql.raw(`TRUNCATE TABLE cognitive_events, cognitive_context_snapshots, cognitive_turn_refs, cognitive_turns,
      cognitive_participants, cognitive_conversations, memory_records, memory_relations, memory_entities,
      goal_previews, goals, scheduled_jobs, missions, tasks RESTART IDENTITY CASCADE`),
  );
});

afterAll(async () => {
  await container?.close();
});

const runtimeWith = (engine: ScriptedCognitionEngine) =>
  buildCognitiveRuntime(container.db!, {
    engine,
    missions: new CanonicalGoalLauncher(container),
    operational: null,
  });

describe("voice -> cognitive runtime (canonical adapter)", () => {
  it("V1 — a committed utterance becomes a durable turn; the reply arrives as one FINAL_RESPONSE read from rows", async () => {
    const rt = runtimeWith(new ScriptedCognitionEngine(() => answer("Bonjour Geoffrey")));
    const adapter = new CognitiveRuntimeVoiceAdapter(rt, () => ["owner"]);
    const t = turn();
    const accepted = await adapter.submitTurn(t, new AbortController().signal);
    expect(accepted.conversationId).toMatch(/^conv-/);
    const events = await collect(accepted.events);
    expect(events.at(-1)).toEqual({ type: "FINAL_RESPONSE", text: "Bonjour Geoffrey" });
    const state = await rt.resume(ME, accepted.conversationId);
    expect(state.turns.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(state.turns[0].idempotencyKey).toBe(t.turnId);
  });

  it("V2 — replaying the same voice turnId (reconnect) yields the same durable turn, never a second one", async () => {
    let calls = 0;
    const rt = runtimeWith(
      new ScriptedCognitionEngine(() => {
        calls += 1;
        return answer("une seule fois");
      }),
    );
    const adapter = new CognitiveRuntimeVoiceAdapter(rt, () => ["owner"]);
    const first = await adapter.submitTurn(
      turn({ turnId: "voice-turn-fixed" }),
      new AbortController().signal,
    );
    await collect(first.events);
    const again = await adapter.submitTurn(
      turn({ turnId: "voice-turn-fixed", conversationId: first.conversationId }),
      new AbortController().signal,
    );
    const events = await collect(again.events);
    expect(events.at(-1)).toEqual({ type: "FINAL_RESPONSE", text: "une seule fois" });
    expect(calls).toBe(1);
    expect(
      (await rt.resume(ME, first.conversationId)).turns.filter((x) => x.role === "user"),
    ).toHaveLength(1);
  });

  it("V3 — a spoken mission request surfaces as MISSION_EVENT and leaves a proposal awaiting a HUMAN decision (no mission started)", async () => {
    const rt = runtimeWith(new ScriptedCognitionEngine(() => missionRequest));
    const adapter = new CognitiveRuntimeVoiceAdapter(rt, () => ["owner"]);
    const accepted = await adapter.submitTurn(turn(), new AbortController().signal);
    const events = await collect(accepted.events);
    expect(events.some((e) => e.type === "MISSION_EVENT")).toBe(true);
    const state = await rt.resume(ME, accepted.conversationId);
    expect(state.proposals.map((p) => p.status)).toEqual(["approval_required"]);
    expect(await container.mission.list()).toHaveLength(0);
  });

  it("V4 — a conversation the user does not own is refused as unavailable, never read", async () => {
    const rt = runtimeWith(new ScriptedCognitionEngine(() => answer("x")));
    const other = await rt.createConversation(
      { tenantId: "default", userId: "someone-else", roles: ["owner"] },
      { title: "private" },
    );
    const adapter = new CognitiveRuntimeVoiceAdapter(rt, () => ["owner"]);
    await expect(
      adapter.submitTurn(turn({ conversationId: other.id }), new AbortController().signal),
    ).rejects.toMatchObject({ name: "CognitiveUnavailableError" });
  });

  it("V5 — aborting the stream (barge-in) cancels through the runtime but never un-accepts the turn", async () => {
    const rt = runtimeWith(
      new ScriptedCognitionEngine(async (_input, signal) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 5_000);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
        return answer("trop tard");
      }),
    );
    const adapter = new CognitiveRuntimeVoiceAdapter(rt, () => ["owner"]);
    const ac = new AbortController();
    const accepted = await adapter.submitTurn(turn(), ac.signal);
    setTimeout(() => ac.abort("BARGE_IN"), 200);
    const events = await collect(accepted.events);
    expect(events.at(-1)?.type).toBe("ERROR");
    const state = await rt.resume(ME, accepted.conversationId);
    expect(state.turns[0].role).toBe("user");
    expect(["cancelled", "failed"]).toContain(state.turns[0].status);
  });
});

/**
 * A SESSION IS NETWORK STATE. A CONVERSATION IS A ROW. The two must not share a lifetime.
 *
 * `VoiceSessionRegistry` keeps a session for `idleTtlMs` (120 s in production) after its
 * transport goes away, and that is all it promises -- "sessions are cheap to lose by
 * design", says its own comment. The North Star asks for something different and stronger:
 * "continuité sur disque", "après restart, IcoS doit reconstruire son contexte depuis sa
 * persistence", "pas de dépendance à une conversation LLM longue".
 *
 * These run the REAL stack -- real `VoiceSessionRegistry`, real
 * `CognitiveRuntimeVoiceAdapter`, real Cognitive Runtime, real PostgreSQL -- with simulated
 * microphone and speaker, which are the only parts a test cannot hold. No parallel store, no
 * second memory: every assertion reads the canonical repositories through the canonical
 * contracts.
 *
 * Deliberately NOT an immediate reconnect: the clock is pushed past the TTL, five minutes,
 * an hour, and through a process restart (fresh runtime and registry objects on the same
 * database), because an immediate reconnect proves nothing about durability.
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEnv } from "@/config/env";
import type { ServerMessage } from "@/core/voice/contracts";
import { buildCognitiveRuntime, type CognitiveActor, type CognitiveRuntime } from "@/server/cognitive";
import type { Clock } from "@/server/cognitive/conversation-store";
import { CanonicalGoalLauncher } from "@/server/cognitive/mission-gateway";
import { answer, ScriptedCognitionEngine } from "@/server/cognitive/testing/support";
import { buildPostgresContainer, type Container } from "@/server/container";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";

import { CognitiveRuntimeVoiceAdapter } from "./cognitive-runtime-adapter";
import { SimulatedStt, SimulatedTts } from "./simulated-providers";
import { VoiceSessionRegistry } from "./voice-session";
import { say } from "./voice-test-harness";

let container: Container;
const OWNER = "owner-voice";
const STRANGER = "someone-else";
const ME: CognitiveActor = { tenantId: "default", userId: OWNER, roles: ["owner"] };
const THEM: CognitiveActor = { tenantId: "default", userId: STRANGER, roles: ["owner"] };

/* A client turn id is an idempotency key on the wire: /^[A-Za-z0-9_-]{8,64}$/.
 * Shorter ids are rejected as INVALID_MESSAGE before any session logic runs. */
const TTL_MS = 120_000; // production value
const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;

beforeAll(async () => {
  container = await buildPostgresContainer(
    TEST_DATABASE_URL,
    undefined,
    loadEnv({
      NODE_ENV: "test",
      PERSISTENCE: "postgres",
      DATABASE_URL: TEST_DATABASE_URL,
      OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
      OMNIROUTE_API_KEY: "voice-ttl-test-key",
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

/** Deliberately-stalled model calls, released only after the last TRUNCATE. */
const stalled: (() => void)[] = [];

afterAll(async () => {
  for (const release of stalled) release();
  await new Promise((r) => setTimeout(r, 500)); // let the freed turns finish writing
  await container?.close();
});

const waitFor = async (predicate: () => boolean, ms = 20_000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

/**
 * One ICOS runtime behind one voice registry, exactly as composed in production except for
 * the microphone and the speaker. `restart()` throws both away and builds them again on the
 * same database — the only honest way to test "after a restart" without killing a service.
 */
function bench(options: { engine?: ScriptedCognitionEngine; staleTurnMs?: number } = {}) {
  const engine = options.engine ?? new ScriptedCognitionEngine(() => answer("bien reçu"));
  let now = Date.parse("2026-10-11T12:00:00.000Z");
  /* ONE clock for the session registry and the conversation store: "an hour later" has to
   * mean an hour later to the ROWS too, or ageing-based recovery cannot be tested at all. */
  const clock: Clock = {
    now: () => new Date(now),
    newId: (prefix) => `${prefix}-${randomUUID()}`,
  };
  const runtimes: CognitiveRuntime[] = [];
  const build = () => {
    const runtime: CognitiveRuntime = buildCognitiveRuntime(container.db!, {
      engine,
      clock,
      missions: new CanonicalGoalLauncher(container),
      operational: null,
      ...(options.staleTurnMs !== undefined ? { staleTurnMs: options.staleTurnMs } : {}),
    });
    const registry = new VoiceSessionRegistry({
      stt: new SimulatedStt(),
      tts: new SimulatedTts(),
      cognitive: new CognitiveRuntimeVoiceAdapter(runtime, () => ["owner"]),
      now: () => now,
      idleTtlMs: TTL_MS,
      /* Watchdogs off: these tests wait on real database work, not on fake timers. */
      setTimer: () => () => {},
    });
    runtimes.push(runtime);
    return { runtime, registry };
  };
  let built = build();
  const client = (userId = OWNER) => {
    const out: ServerMessage[] = [];
    const conn = built.registry.connect(userId, (m) => out.push(m));
    return {
      conn,
      out,
      of: <T extends ServerMessage["type"]>(t: T) =>
        out.filter((m) => m.type === t) as Extract<ServerMessage, { type: T }>[],
    };
  };
  return {
    engine,
    get runtime() {
      return built.runtime;
    },
    get registry() {
      return built.registry;
    },
    client,
    advance: (ms: number) => (now += ms),
    /** A process restart: nothing in memory survives, the database does. */
    restart: () => (built = build()),
    /*
     * Every background turn of every runtime this bench built, bounded: one test keeps a
     * model call hung on purpose, so an unbounded drain would never return.
     */
    quiesce: async () => {
      await Promise.race([
        Promise.allSettled(runtimes.map((r) => r.drain())),
        new Promise((r) => setTimeout(r, 3_000)),
      ]);
    },
  };
}

describe("session TTL is not conversation lifetime (real PostgreSQL)", () => {
  it("TTL: the session is swept, the whole exchange stays in PostgreSQL", async () => {
    const b = bench();
    const c = b.client();
    c.conn.receive({ type: "hello", device: "browser", turnMode: "push_to_talk" });
    say(c.conn, "voice-001", ["bonjour", "icos"]);
    expect(await waitFor(() => c.of("turn_accepted").length === 1)).toBe(true);
    const sessionId = c.of("ready")[0].sessionId;
    const conversationId = c.of("turn_accepted")[0].conversationId;
    await waitForCompleted(b, conversationId, 1);

    c.conn.close(); // the network dies
    b.advance(TTL_MS + 10_000);
    b.registry.sweep();

    expect(b.registry.get(sessionId)).toBeUndefined(); // the session is gone, as designed
    const state = await b.runtime.resume(ME, conversationId);
    expect(state.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(state.turns[0].idempotencyKey).toBe("voice-001");
  });

  it("five minutes later, and an hour later, the conversation continues with no session alive", async () => {
    const b = bench();
    const c = b.client();
    c.conn.receive({ type: "hello", device: "browser", turnMode: "push_to_talk" });
    say(c.conn, "voice-001", ["premier", "tour"]);
    expect(await waitFor(() => c.of("turn_accepted").length === 1)).toBe(true);
    const conversationId = c.of("turn_accepted")[0].conversationId;
    await waitForCompleted(b, conversationId, 1);
    c.conn.close();

    for (const [label, gap, turnId] of [
      ["five minutes", FIVE_MINUTES, "voice-002"],
      ["one hour", ONE_HOUR, "voice-003"],
    ] as const) {
      b.advance(gap);
      b.registry.sweep();
      const later = b.client();
      later.conn.receive({ type: "hello", conversationId, device: "browser", turnMode: "push_to_talk" });
      expect(later.of("ready")[0], label).toMatchObject({ resumed: false, conversationId });
      say(later.conn, turnId, ["encore", label.replace(" ", "-")]);
      expect(
        await waitFor(() => later.of("turn_accepted").some((m) => m.turnId === turnId)),
        `${label}: turn refused`,
      ).toBe(true);
      await waitForCompleted(b, conversationId, turnId === "voice-002" ? 2 : 3);
      later.conn.close();
    }

    const state = await b.runtime.resume(ME, conversationId);
    expect(state.turns.map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(state.turns.filter((t) => t.role === "user").map((t) => t.idempotencyKey)).toEqual([
      "voice-001",
      "voice-002",
      "voice-003",
    ]);
  });

  it("after an APPLICATION RESTART the conversation resumes from rows, and the model is given the earlier exchange", async () => {
    const b = bench();
    const first = b.client();
    first.conn.receive({ type: "hello", device: "browser", turnMode: "push_to_talk" });
    say(first.conn, "voice-001", ["retiens", "ce", "detail"]);
    expect(await waitFor(() => first.of("turn_accepted").length === 1)).toBe(true);
    const conversationId = first.of("turn_accepted")[0].conversationId;
    await waitForCompleted(b, conversationId, 1);

    b.restart(); // every session object, every cache, gone
    b.advance(ONE_HOUR);

    const after = b.client();
    after.conn.receive({ type: "hello", conversationId, device: "browser", turnMode: "push_to_talk" });
    expect(after.of("ready")[0]).toMatchObject({ resumed: false, conversationId });
    say(after.conn, "voice-002", ["et", "maintenant"]);
    expect(await waitFor(() => after.of("turn_accepted").some((m) => m.turnId === "voice-002"))).toBe(true);
    await waitForCompleted(b, conversationId, 2);

    /* THE CONTEXT ITSELF came back from the database, not from a live object. */
    const lastContext = b.engine.inputs.at(-1)!.context;
    expect(lastContext).toContain("retiens");
    const state = await b.runtime.resume(ME, conversationId);
    expect(state.turns.map((t) => t.idempotencyKey).filter(Boolean)).toEqual(["voice-001", "voice-002"]);
  });

  it("an interrupted turn is reconciled on the next resume instead of blocking the conversation", async () => {
    /* A turn whose model call never returns: the process dies mid-inference. */
    const hang = new Promise<void>((resolve) => stalled.push(resolve));
    /*
     * Keyed on WHICH utterance, never on a call counter: acceptance is durable before the
     * model is ever called, so the interrupted turn may not have reached the engine at all
     * and a counter would then hang the wrong turn.
     */
    const engine = new ScriptedCognitionEngine(async (input) => {
      if (input.userText.includes("coupee")) await hang;
      return answer("reponse");
    });
    /* The PRODUCTION staleness window. The turn is not born stale: it AGES. */
    const b = bench({ engine });

    const c = b.client();
    c.conn.receive({ type: "hello", device: "browser", turnMode: "push_to_talk" });
    say(c.conn, "voice-001", ["question", "coupee"]);
    expect(await waitFor(() => c.of("turn_accepted").length === 1)).toBe(true);
    const conversationId = c.of("turn_accepted")[0].conversationId;
    c.conn.close();
    b.advance(10 * 60_000); // past the five-minute staleness window
    b.restart(); // and the process that was thinking is gone

    /* `resume` closes interrupted turns -- and the voice adapter resumes on every turn. */
    const recovered = await b.runtime.resume(ME, conversationId);
    expect(recovered.recoveredTurnIds.length).toBeGreaterThan(0);

    const back = b.client();
    back.conn.receive({ type: "hello", conversationId, device: "browser", turnMode: "push_to_talk" });
    say(back.conn, "voice-002", ["je", "reformule"]);
    expect(
      await waitFor(() => back.of("turn_accepted").some((m) => m.turnId === "voice-002")),
      "a reconciled conversation must accept the next turn",
    ).toBe(true);
    await waitForCompleted(b, conversationId, 1);
  });

  it("replaying the same voice turn after a reconnect never creates a second turn", async () => {
    const b = bench();
    const c = b.client();
    c.conn.receive({ type: "hello", device: "browser", turnMode: "push_to_talk" });
    say(c.conn, "voice-001", ["une", "seule", "fois"]);
    expect(await waitFor(() => c.of("turn_accepted").length === 1)).toBe(true);
    const conversationId = c.of("turn_accepted")[0].conversationId;
    await waitForCompleted(b, conversationId, 1);

    c.conn.close();
    b.advance(TTL_MS + 1_000);
    b.registry.sweep();

    const back = b.client();
    back.conn.receive({ type: "hello", conversationId, device: "browser", turnMode: "push_to_talk" });
    say(back.conn, "voice-001", ["une", "seule", "fois"]); // the client replays its unacked buffer
    await new Promise((r) => setTimeout(r, 1_500));

    const state = await b.runtime.resume(ME, conversationId);
    expect(state.turns.filter((t) => t.idempotencyKey === "voice-001")).toHaveLength(1);
    expect(state.turns.filter((t) => t.role === "assistant")).toHaveLength(1);
  });

  it("ONE WRITER: a second turn while the first is answering is refused as TURN_IN_PROGRESS, immediately and not as an outage", async () => {
    /* The first turn stays in flight: that is the whole point of the scenario. Released at
     * the end of THIS test, because a stalled call left running deadlocks the next
     * test's TRUNCATE -- measured, twice. */
    let release: () => void = () => {};
    const engine = new ScriptedCognitionEngine(async (input) => {
      if (input.userText.includes("lente")) await new Promise<void>((r) => (release = r));
      return answer("reponse");
    });
    const b = bench({ engine });

    const first = b.client();
    first.conn.receive({ type: "hello", device: "browser", turnMode: "push_to_talk" });
    say(first.conn, "voice-001", ["question", "lente"]);
    expect(await waitFor(() => first.of("turn_accepted").length === 1)).toBe(true);
    const conversationId = first.of("turn_accepted")[0].conversationId;

    /* Same owner, another connection, same conversation — a second device speaking over it. */
    const second = b.client();
    second.conn.receive({
      type: "hello",
      conversationId,
      device: "pwa",
      turnMode: "push_to_talk",
    });
    const startedAt = Date.now();
    say(second.conn, "voice-002", ["je", "parle", "aussi"]);
    const refused = await waitFor(() =>
      second.of("error").some((e) => e.code === "TURN_IN_PROGRESS"),
    );
    const refusalMs = Date.now() - startedAt;

    expect(refused, "the refusal must arrive, not time out").toBe(true);
    /* IMMEDIATE: a unique-index violation, not a watchdog. The live run waited 20 s only
     * because the harness watched for an acceptance that was never coming. */
    expect(refusalMs).toBeLessThan(5_000);
    expect(second.of("turn_accepted")).toEqual([]);
    /* AND NOT AN OUTAGE: the old path reported exactly this as COGNITIVE_UNAVAILABLE. */
    expect(second.of("error").map((e) => e.code)).not.toContain("COGNITIVE_UNAVAILABLE");
    const message = second.of("error").find((e) => e.code === "TURN_IN_PROGRESS")!.message;
    expect(message).toContain("already answering");
    expect(message).not.toContain("resend it");

    /* The conversation is unharmed: exactly one user turn landed. */
    const state = await b.runtime.resume(ME, conversationId);
    expect(state.turns.filter((t) => t.role === "user")).toHaveLength(1);
    expect(state.turns.map((t) => t.idempotencyKey).filter(Boolean)).toEqual(["voice-001"]);

    release();
    await b.quiesce();
  });

  it("ISOLATION: another authenticated user cannot continue, or even read, the conversation", async () => {
    const b = bench();
    const c = b.client();
    c.conn.receive({ type: "hello", device: "browser", turnMode: "push_to_talk" });
    say(c.conn, "voice-001", ["donnees", "privees"]);
    expect(await waitFor(() => c.of("turn_accepted").length === 1)).toBe(true);
    const conversationId = c.of("turn_accepted")[0].conversationId;
    await waitForCompleted(b, conversationId, 1);

    const stranger = b.client(STRANGER);
    stranger.conn.receive({ type: "hello", conversationId, device: "browser", turnMode: "push_to_talk" });
    say(stranger.conn, "voice-x99", ["montre", "moi"]);
    await new Promise((r) => setTimeout(r, 1_500));

    expect(stranger.of("turn_accepted")).toEqual([]);
    await expect(b.runtime.resume(THEM, conversationId)).rejects.toThrow();
    /* And nothing of theirs reached the owner's conversation. */
    const state = await b.runtime.resume(ME, conversationId);
    expect(state.turns.filter((t) => t.role === "user")).toHaveLength(1);
  });

  it("ANOTHER DEVICE of the same owner continues the same conversation, in order", async () => {
    const b = bench();
    const phone = b.client();
    phone.conn.receive({ type: "hello", device: "browser", turnMode: "push_to_talk" });
    say(phone.conn, "voice-001", ["depuis", "le", "telephone"]);
    expect(await waitFor(() => phone.of("turn_accepted").length === 1)).toBe(true);
    const conversationId = phone.of("turn_accepted")[0].conversationId;
    await waitForCompleted(b, conversationId, 1);
    phone.conn.close();

    const laptop = b.client(); // same user, different device, different session
    laptop.conn.receive({ type: "hello", conversationId, device: "pwa", turnMode: "push_to_talk" });
    say(laptop.conn, "voice-002", ["depuis", "le", "portable"]);
    expect(await waitFor(() => laptop.of("turn_accepted").some((m) => m.turnId === "voice-002"))).toBe(true);
    await waitForCompleted(b, conversationId, 2);

    const state = await b.runtime.resume(ME, conversationId);
    expect(state.turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(b.registry.get(phone.of("ready")[0].sessionId)).toBeDefined(); // both sessions coexist
  });
});

/**
 * Waits on the APPEND-ONLY EVENT LOG, the only durable read that changes nothing.
 * `resume()` recovers interrupted turns as a side effect, so polling it is destructive --
 * measured: with a one-millisecond staleness window it recovered the very turn this helper
 * was waiting for, every 50 ms.
 */
async function waitForCompleted(
  b: ReturnType<typeof bench>,
  conversationId: string,
  atLeast: number,
): Promise<void> {
  const completed = async () =>
    (await b.runtime.events(ME, conversationId, 0)).filter((e) => e.type === "turn.completed")
      .length;
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    if ((await completed()) >= atLeast) {
      /* Quiesce BEFORE returning: `turn.completed` is followed by memory writeback, and
       * those writes used to collide with the next test's TRUNCATE. */
      await b.quiesce();
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const log = (await b.runtime.events(ME, conversationId, 0)).map((e) => e.type).join(",");
  throw new Error(
    `only ${await completed()}/${atLeast} turn.completed in ${conversationId}; log: ${log}`,
  );
}

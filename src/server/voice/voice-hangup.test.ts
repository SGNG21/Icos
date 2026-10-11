/**
 * HANG-UP IS NOT A CANCELLATION — the guarantee the E2E run appeared to disprove.
 *
 * The real run reported `answerStoredAfterHangUp: false`, `resumed: false` and
 * `t4InAccepted: false`. The harness was reading the retired CEO-conversation store and
 * measuring resume 150 s after the hang-up, past the 120 s idle TTL. These tests pin what
 * the engine actually owes, so the next time those three fields are false it means
 * something broke rather than something was mismeasured:
 *
 *   1. a dead transport detaches; it does NOT abort the cognitive turn;
 *   2. an answer that arrives while nobody is listening still reaches the durable store;
 *   3. the accepted turn is still accepted when the owner comes back inside the TTL;
 *   4. a replayed turn after the reconnect is never a second turn;
 *   5. session EXPIRY, which is a different event, does abort explicitly.
 *
 * Deliberately in-memory: the durability of the row is the Cognitive Runtime's own
 * contract, already proven against PostgreSQL in cognitive-runtime-adapter.integration.test.ts
 * (V1 durable turn read back from rows, V2 idempotent replay). What is unproven, and what
 * these cover, is the SESSION's behaviour when the socket dies mid-inference.
 */
import { describe, expect, it } from "vitest";

import { flush, say, setup } from "./voice-test-harness";

const T4 = "turn-hangup";
const T5 = "turn-after-resume";

describe("hang-up during inference", () => {
  it("a dead transport detaches the session WITHOUT cancelling the accepted turn", async () => {
    const s = setup();
    say(s.conn, T4, ["quelle", "heure"]);
    await flush();
    expect(s.of("turn_accepted").map((m) => m.turnId)).toEqual([T4]);

    s.conn.close(); // the phone vanishes while the model is still thinking
    await flush();

    /* THE POINT: a lost socket is not a user asking to stop. */
    expect(s.cognitive.aborts).toEqual([]);
    expect(s.registry.get(s.of("ready")[0].sessionId)).toBeDefined();
  });

  it("an answer produced while nobody listens still lands, and is there on return", async () => {
    const s = setup();
    say(s.conn, T4, ["quelle", "heure"]);
    await flush();
    const sessionId = s.of("ready")[0].sessionId;
    const conversationId = s.of("turn_accepted")[0].conversationId;

    s.conn.close();
    await flush();
    /* The runtime finishes into a session with no transport attached. */
    s.cognitive.responses.get(T4)!.push({ type: "FINAL_RESPONSE", text: "il est midi" });
    await flush();

    /* Durable store, which outlives the session by construction. */
    expect(s.cognitive.conversations.get(conversationId)?.map((t) => t.turnId)).toEqual([T4]);

    const back = s.client();
    back.conn.receive({ type: "hello", sessionId, device: "browser" });
    expect(back.of("ready")[0]).toMatchObject({ resumed: true, acceptedTurnIds: [T4] });
    expect(s.cognitive.aborts).toEqual([]);
  });

  it("the returning owner is accepted for a NEW turn, and a replay is not a second turn", async () => {
    const s = setup();
    say(s.conn, T4, ["quelle", "heure"]);
    await flush();
    const sessionId = s.of("ready")[0].sessionId;
    const conversationId = s.of("turn_accepted")[0].conversationId;
    s.conn.close();
    s.cognitive.responses.get(T4)!.push({ type: "FINAL_RESPONSE", text: "il est midi" });
    await flush();

    const back = s.client();
    back.conn.receive({ type: "hello", sessionId, device: "browser" });
    say(back.conn, T4, ["quelle", "heure"]); // the client replays its unacked buffer
    say(back.conn, T5, ["et", "demain"]);
    await flush();

    expect(back.of("turn_accepted").map((m) => m.turnId)).toEqual([T5]);
    expect(s.cognitive.conversations.get(conversationId)?.map((t) => t.turnId)).toEqual([T4, T5]);
  });

  it("CONTRAST: session expiry IS a cancellation, and says so", async () => {
    const s = setup();
    say(s.conn, T4, ["quelle", "heure"]);
    await flush();
    s.conn.close();
    await flush();
    expect(s.cognitive.aborts).toEqual([]);

    s.advance(60_000); // past idleTtlMs
    s.registry.sweep();
    await flush();

    /* Expiry is explicit, attributable, and distinct from losing the network. */
    expect(s.cognitive.aborts).toEqual([{ turnId: T4, reason: "SESSION_CLOSED" }]);
  });

  it("CONTRAST: a conversation outlives its session — continuity needs no process memory", async () => {
    const s = setup();
    say(s.conn, T4, ["quelle", "heure"]);
    await flush();
    const sessionId = s.of("ready")[0].sessionId;
    const conversationId = s.of("turn_accepted")[0].conversationId;
    s.conn.close();
    s.advance(60_000);

    const back = s.client();
    back.conn.receive({ type: "hello", sessionId, conversationId, device: "browser" });
    expect(back.of("error")[0]).toMatchObject({ code: "SESSION_EXPIRED" });
    expect(back.of("ready")[0]).toMatchObject({ resumed: false, conversationId });

    say(back.conn, T5, ["et", "demain"]);
    await flush();
    expect(s.cognitive.conversations.get(conversationId)?.map((t) => t.turnId)).toEqual([T4, T5]);
  });
});

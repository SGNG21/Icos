import { describe, expect, it, vi } from "vitest";

import {
  askReducer,
  httpCognitiveTransport,
  initialAsk,
  needsRefresh,
  submitPhase,
  type AskTurn,
  type ConversationEvent,
  type ConversationState,
  type TurnResult,
} from "./ask";

const C = "conv-1";
const turn = (over: Partial<AskTurn> = {}): AskTurn => ({
  id: "t1",
  conversationId: C,
  seq: 1,
  role: "user",
  content: { parts: [{ kind: "text", text: "Pourquoi CORE3 est bloqué ?" }] },
  status: "completed",
  outcome: null,
  replyToTurnId: null,
  failureReason: null,
  createdAt: "2026-09-30T08:00:00Z",
  ...over,
});
const convState = (turns: AskTurn[] = [turn()]): ConversationState => ({
  conversation: { id: C, title: null, status: "active", updatedAt: "2026-09-30T08:00:00Z" },
  turns,
  proposals: [],
  recoveredTurnIds: [],
});
const ev = (
  seq: number,
  type: ConversationEvent["type"],
  turnId: string | null = "t1",
): ConversationEvent => ({
  conversationId: C,
  seq,
  type,
  turnId,
  payload: {},
  createdAt: "2026-09-30T08:00:00Z",
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const result = (replayed = false): TurnResult => ({
  turn: turn(),
  reply: turn({ id: "t2", role: "assistant", replyToTurnId: "t1", outcome: "ANSWER_ONLY" }),
  proposal: null,
  replayed,
});

describe("Ask ICOS state (durable state is truth, events are signals)", () => {
  it("applies events in seq order only, per conversation, and tracks in-flight progress", () => {
    let s = askReducer(initialAsk, { type: "resumed", state: convState() });
    for (const e of [
      ev(1, "turn.received"),
      ev(2, "turn.processing"),
      ev(2, "turn.processing"),
      { ...ev(9, "turn.received"), conversationId: "other" },
    ])
      s = askReducer(s, { type: "event", event: e });
    expect(s.cursor).toBe(2);
    expect(s.progress).toEqual({ t1: "turn.processing" });
  });

  it("settling events ask for a re-read; resume drops progress of closed turns", () => {
    expect(needsRefresh(ev(3, "turn.completed"))).toBe(true);
    expect(needsRefresh(ev(3, "proposal.submitted"))).toBe(true);
    expect(needsRefresh(ev(3, "context.assembled"))).toBe(false);
    let s = askReducer(initialAsk, {
      type: "resumed",
      state: convState([turn({ status: "processing" })]),
    });
    s = askReducer(s, { type: "event", event: ev(1, "context.assembled") });
    s = askReducer(s, { type: "resumed", state: convState([turn({ status: "completed" })]) });
    expect(s.progress).toEqual({});
    expect(s.cursor).toBe(1); // same conversation keeps its cursor
  });

  it("switching conversation restarts the cursor", () => {
    let s = askReducer(initialAsk, { type: "resumed", state: convState() });
    s = askReducer(s, { type: "event", event: ev(5, "turn.completed") });
    const other = { ...convState(), conversation: { ...convState().conversation, id: "conv-2" } };
    expect(askReducer(s, { type: "resumed", state: other }).cursor).toBe(0);
  });

  it("maps submit replies: accepted / replayed / busy / rejected / UNKNOWN / not connected", () => {
    expect(submitPhase({ kind: "ok", status: 201, value: result() })).toEqual({
      phase: "accepted",
    });
    expect(submitPhase({ kind: "ok", status: 200, value: result(true) })).toEqual({
      phase: "replayed",
    });
    expect(
      submitPhase({
        kind: "error",
        status: 409,
        code: "invalid_transition",
        message: "",
        typed: true,
      }),
    ).toMatchObject({ phase: "busy" });
    expect(
      submitPhase({ kind: "error", status: 403, code: "forbidden", message: "", typed: true }),
    ).toMatchObject({ phase: "rejected" });
    expect(
      submitPhase({
        kind: "error",
        status: 503,
        code: "persistence_unavailable",
        message: "",
        typed: true,
      }),
    ).toMatchObject({ phase: "unknown" });
    expect(
      submitPhase({
        kind: "error",
        status: 200,
        code: "unexpected_response",
        message: "",
        typed: false,
      }),
    ).toMatchObject({ phase: "unknown" });
    expect(submitPhase({ kind: "not_connected" })).toBe("not_connected");
  });
});

describe("Cognitive transport (routes committed by lane C)", () => {
  it("submits {text, idempotencyKey} to the conversation, same-origin", async () => {
    const fetch = vi.fn(async () => json(201, result()));
    const r = await httpCognitiveTransport(fetch).submit(C, {
      text: "x",
      idempotencyKey: "key-12345678",
    });
    expect(r).toMatchObject({ kind: "ok", status: 201 });
    expect(fetch).toHaveBeenCalledWith(
      `/api/cognitive/conversations/${C}/turns`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ text: "x", idempotencyKey: "key-12345678" }),
      }),
    );
  });

  it("framework 404 = not connected; ICOS 404 envelope = unknown conversation", async () => {
    const missing = vi.fn(async () => new Response("<html/>", { status: 404 }));
    expect(await httpCognitiveTransport(missing).list()).toEqual({ kind: "not_connected" });
    const env = vi.fn(async () =>
      json(404, { error: { code: "not_found", message: "conversation introuvable" } }),
    );
    expect(await httpCognitiveTransport(env).resume(C)).toMatchObject({
      kind: "error",
      status: 404,
      typed: true,
    });
    expect(
      await httpCognitiveTransport(
        vi.fn(async () => json(404, { error: { code: "not_found", message: "" } })),
      ).events(C, 0, vi.fn()),
    ).toBe("not_found");
    expect(
      await httpCognitiveTransport(vi.fn(async () => new Response("", { status: 404 }))).events(
        C,
        0,
        vi.fn(),
      ),
    ).toBe("not_connected");
  });

  it("memory mode answers 503: runtime unavailable, typed", async () => {
    const off = vi.fn(async () =>
      json(503, { error: { code: "persistence_unavailable", message: "PostgreSQL requis" } }),
    );
    expect(await httpCognitiveTransport(off).list()).toMatchObject({
      kind: "error",
      status: 503,
      typed: true,
    });
  });

  it("reads the durable event log as SSE after the cursor and drops invalid frames", async () => {
    const body = [
      `id: 3\nevent: turn.received\ndata: ${JSON.stringify(ev(3, "turn.received"))}\n\n`,
      "event: error\ndata: {}\n\n",
      `id: 4\nevent: turn.completed\ndata: ${JSON.stringify(ev(4, "turn.completed"))}\n\n`,
    ].join("");
    const fetch = vi.fn(
      async () =>
        new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
    );
    const onEvent = vi.fn();
    expect(await httpCognitiveTransport(fetch).events(C, 2, onEvent)).toBe("closed");
    expect(fetch).toHaveBeenCalledWith(
      `/api/cognitive/conversations/${C}/events?after=2`,
      expect.objectContaining({ headers: { accept: "text/event-stream" } }),
    );
    expect(onEvent.mock.calls.map(([e]) => e.seq)).toEqual([3, 4]);
  });

  it("cancel and proposal decision hit the canonical routes; network failure is link_lost", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes("/cancel")
        ? json(200, { cancelled: true })
        : json(200, {
            proposal: {
              id: "r1",
              turnId: "t1",
              kind: "goal_proposal",
              status: "submitted",
              payload: {},
              externalId: "goal-1",
            },
          }),
    );
    const t = httpCognitiveTransport(fetch as unknown as typeof globalThis.fetch);
    expect(await t.cancel(C, "t1")).toMatchObject({ kind: "ok" });
    expect(await t.decide(C, "r1", "approve")).toMatchObject({
      kind: "ok",
      value: { proposal: { externalId: "goal-1" } },
    });
    expect(fetch).toHaveBeenCalledWith(
      `/api/cognitive/conversations/${C}/proposals/r1/decision`,
      expect.objectContaining({ body: JSON.stringify({ decision: "approve" }) }),
    );
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(await httpCognitiveTransport(down).events(C, 0, vi.fn())).toBe("link_lost");
  });
});

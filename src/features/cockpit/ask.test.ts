import { describe, expect, it, vi } from "vitest";

import {
  askReducer,
  httpAskTransport,
  initialAsk,
  MAX_ANSWER_CHARS,
  type AskEvent,
  type AskState,
} from "./ask";

const T = "turn-1";
const sent = (conversationId: string | null = null) =>
  askReducer(initialAsk(conversationId), { type: "send", turnId: T });
const run = (events: AskEvent[], from: AskState = sent()) =>
  events.reduce((s, event) => askReducer(s, { type: "event", event }), from);
const started: AskEvent = { type: "turn.started", conversationId: "c1", turnId: T, seq: 0 };

const sse = (frames: unknown[], status = 200) =>
  new Response(
    frames
      .map((f, i) => `id: ${i}\ndata: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`)
      .join(""),
    { status, headers: { "content-type": "text/event-stream" } },
  );
const input = { turnId: T, conversationId: null, text: "hi" };

describe("Ask ICOS reducer", () => {
  it("streams text, tools, missions, approvals and context into one turn", () => {
    const s = run([
      started,
      {
        type: "context.used",
        turnId: T,
        seq: 1,
        memory: [{ id: "m1", label: "CORE3" }],
        contextTokens: 900,
      },
      { type: "text.delta", turnId: T, seq: 2, text: "CORE3 is " },
      {
        type: "tool.call",
        turnId: T,
        seq: 3,
        toolCallId: "tc",
        name: "missions.read",
        status: "started",
      },
      {
        type: "tool.call",
        turnId: T,
        seq: 4,
        toolCallId: "tc",
        name: "missions.read",
        status: "succeeded",
      },
      { type: "text.delta", turnId: T, seq: 5, text: "blocked on review." },
      { type: "mission.created", turnId: T, seq: 6, missionId: "ms1", title: "Unblock review" },
      {
        type: "approval.requested",
        turnId: T,
        seq: 7,
        approvalId: "ap1",
        summary: "Cancel",
        risk: "HIGH",
      },
      { type: "turn.completed", turnId: T, seq: 8 },
    ]);
    expect(s).toMatchObject({
      status: "completed",
      conversationId: "c1",
      text: "CORE3 is blocked on review.",
      tools: [{ id: "tc", status: "succeeded" }],
      missions: [{ id: "ms1" }],
      approvals: [{ id: "ap1", risk: "HIGH" }],
      context: { contextTokens: 900 },
      lastSeq: 8,
    });
  });

  it("the client owns the turn id from send: foreign turns never apply", () => {
    const s = run([
      { type: "turn.started", conversationId: "c9", turnId: "hijack", seq: 0 },
      started,
      { type: "text.delta", turnId: "hijack", seq: 1, text: "x" },
      { type: "text.delta", turnId: T, seq: 1, text: "a" },
      { type: "text.delta", turnId: T, seq: 1, text: "a" }, // replay
    ]);
    expect(s).toMatchObject({ turnId: T, conversationId: "c1", text: "a" });
    expect(run([started], initialAsk()).status).toBe("idle"); // nothing sent → nothing applies
  });

  it("nothing resurrects a finished turn", () => {
    const s = run([
      started,
      { type: "turn.completed", turnId: T, seq: 1 },
      { type: "text.delta", turnId: T, seq: 2, text: "late" },
    ]);
    expect(s).toMatchObject({ status: "completed", text: "" });
    expect(askReducer(s, { type: "link_lost" }).status).toBe("completed");
  });

  it("a seq gap stops applying and asks for a resume instead of corrupting the text", () => {
    const s = run([started, { type: "text.delta", turnId: T, seq: 3, text: "skip" }]);
    expect(s).toMatchObject({
      status: "error",
      text: "",
      lastSeq: 0,
      error: { code: "SEQ_GAP", retryable: true },
    });
  });

  it("a lost link keeps the partial answer; a successful resume clears the error", () => {
    const broken = askReducer(
      run([started, { type: "text.delta", turnId: T, seq: 1, text: "part" }]),
      {
        type: "link_lost",
      },
    );
    expect(broken).toMatchObject({ status: "error", text: "part", error: { retryable: true } });
    const resumed = run(
      [
        { type: "text.delta", turnId: T, seq: 2, text: "ial" },
        { type: "turn.completed", turnId: T, seq: 3 },
      ],
      askReducer(broken, { type: "reconnecting" }),
    );
    expect(resumed).toMatchObject({ status: "completed", text: "partial", error: null });
  });

  it("caps the rendered answer", () => {
    const s = run([
      started,
      { type: "text.delta", turnId: T, seq: 1, text: "x".repeat(MAX_ANSWER_CHARS + 1) },
    ]);
    expect(s).toMatchObject({ status: "error", text: "", error: { code: "ANSWER_TOO_LONG" } });
  });

  it("a new turn keeps the conversation id", () => {
    const done = run([started, { type: "turn.completed", turnId: T, seq: 1 }]);
    expect(askReducer(done, { type: "send", turnId: "t2" })).toMatchObject({
      conversationId: "c1",
      turnId: "t2",
      text: "",
    });
  });
});

describe("Ask ICOS transport", () => {
  it("POSTs the client turn id (idempotency key)", async () => {
    const fetch = vi.fn(async () => sse([]));
    await httpAskTransport(fetch).start(input, vi.fn());
    expect(fetch).toHaveBeenCalledWith(
      "/api/ask/turns",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
        credentials: "same-origin",
      }),
    );
  });

  it("no runtime route → not_connected; no event, no answer", async () => {
    const onEvent = vi.fn();
    const fetch = vi.fn(async () => new Response("<html/>", { status: 404 }));
    expect(await httpAskTransport(fetch).start(input, onEvent)).toBe("not_connected");
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("a runtime 404 envelope means an unknown turn, not a missing runtime", async () => {
    const env = () =>
      new Response(JSON.stringify({ error: { code: "not_found", message: "turn" } }), {
        status: 404,
      });
    expect(await httpAskTransport(vi.fn(async () => env())).resume(T, 3, vi.fn())).toBe(
      "not_found",
    );
    expect(await httpAskTransport(vi.fn(async () => env())).cancel(T)).toBe("not_found");
    expect(
      await httpAskTransport(vi.fn(async () => new Response("", { status: 404 }))).cancel(T),
    ).toBe("not_connected");
  });

  it("parses SSE frames and drops malformed or unknown ones", async () => {
    const onEvent = vi.fn();
    const fetch = vi.fn(async () =>
      sse([
        started,
        "not json",
        { type: "made.up", turnId: T, seq: 1 },
        { type: "turn.completed", turnId: T, seq: 1 },
      ]),
    );
    expect(await httpAskTransport(fetch).start(input, onEvent)).toBe("ended");
    expect(onEvent.mock.calls.map(([e]) => e.type)).toEqual(["turn.started", "turn.completed"]);
  });

  it("an oversized frame aborts the stream as a lost link", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(`data: ${"x".repeat(1_100_000)}`, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    expect(await httpAskTransport(fetch).start(input, vi.fn())).toBe("link_lost");
  });

  it("resume asks for events after the last applied seq", async () => {
    const fetch = vi.fn(async () => sse([]));
    await httpAskTransport(fetch).resume(T, 41, vi.fn());
    expect(fetch).toHaveBeenCalledWith(`/api/ask/turns/${T}/events?afterSeq=41`, expect.anything());
  });

  it("network failure is link_lost", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(await httpAskTransport(down).start(input, vi.fn())).toBe("link_lost");
    expect(await httpAskTransport(down).interrupt(T)).toBe("failed");
  });
});

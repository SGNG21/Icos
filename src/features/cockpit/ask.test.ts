import { describe, expect, it, vi } from "vitest";

import { askReducer, httpAskTransport, initialAsk, type AskEvent, type AskState } from "./ask";

const T = "turn-1";
const run = (events: AskEvent[], from: AskState = askReducer(initialAsk(), { type: "send" })) =>
  events.reduce((s, event) => askReducer(s, { type: "event", event }), from);

const sse = (frames: unknown[], status = 200) =>
  new Response(
    frames
      .map((f, i) => `id: ${i}\ndata: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`)
      .join(""),
    {
      status,
      headers: { "content-type": "text/event-stream" },
    },
  );

describe("Ask ICOS reducer", () => {
  it("streams text, tools, missions, approvals and context into one turn", () => {
    const s = run([
      { type: "turn.started", conversationId: "c1", turnId: T, seq: 0 },
      {
        type: "context.used",
        turnId: T,
        seq: 1,
        memory: [{ id: "m1", label: "CORE3 state" }],
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
        summary: "Cancel mission",
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

  it("ignores replayed events after resume and events of another turn", () => {
    const s = run([
      { type: "turn.started", conversationId: "c1", turnId: T, seq: 0 },
      { type: "text.delta", turnId: T, seq: 1, text: "a" },
      { type: "text.delta", turnId: T, seq: 1, text: "a" },
      { type: "text.delta", turnId: "other", seq: 2, text: "x" },
      { type: "text.delta", turnId: T, seq: 2, text: "b" },
    ]);
    expect(s.text).toBe("ab");
  });

  it("a lost link keeps the partial answer and is resumable, never 'completed'", () => {
    const s = askReducer(
      run([
        { type: "turn.started", conversationId: "c1", turnId: T, seq: 0 },
        { type: "text.delta", turnId: T, seq: 1, text: "partial" },
      ]),
      { type: "link_lost" },
    );
    expect(s).toMatchObject({ status: "error", text: "partial", error: { retryable: true } });
  });

  it("a new turn keeps the conversation id", () => {
    const done = run([{ type: "turn.started", conversationId: "c1", turnId: T, seq: 0 }]);
    expect(askReducer(done, { type: "send" }).conversationId).toBe("c1");
  });
});

describe("Ask ICOS transport", () => {
  it("no runtime route → not_connected; no event, no answer", async () => {
    const onEvent = vi.fn();
    const fetch = vi.fn(async () => new Response("<html/>", { status: 404 }));
    expect(await httpAskTransport(fetch).start({ conversationId: null, text: "hi" }, onEvent)).toBe(
      "not_connected",
    );
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("parses SSE frames and drops malformed or unknown ones", async () => {
    const onEvent = vi.fn();
    const fetch = vi.fn(async () =>
      sse([
        { type: "turn.started", conversationId: "c", turnId: T, seq: 0 },
        "not json",
        { type: "made.up", turnId: T, seq: 1 },
        { type: "turn.completed", turnId: T, seq: 2 },
      ]),
    );
    expect(await httpAskTransport(fetch).start({ conversationId: null, text: "hi" }, onEvent)).toBe(
      "ended",
    );
    expect(onEvent.mock.calls.map(([e]) => e.type)).toEqual(["turn.started", "turn.completed"]);
  });

  it("resume asks for events after the last applied seq", async () => {
    const fetch = vi.fn(async () => sse([]));
    await httpAskTransport(fetch).resume(T, 41, vi.fn());
    expect(fetch).toHaveBeenCalledWith(`/api/ask/turns/${T}/events?afterSeq=41`, expect.anything());
  });

  it("network failure is link_lost; cancel on a missing runtime is not_connected", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(await httpAskTransport(down).start({ conversationId: null, text: "x" }, vi.fn())).toBe(
      "link_lost",
    );
    const missing = vi.fn(async () => new Response("", { status: 404 }));
    expect(await httpAskTransport(missing).cancel(T)).toBe("not_connected");
  });
});

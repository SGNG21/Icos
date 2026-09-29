import { describe, expect, it } from "vitest";

import type { Message } from "@/core/ceo/contracts";
import {
  CognitiveUnavailableError,
  type CognitiveEvent,
  type CommittedTurn,
} from "@/core/voice/contracts";
import { ConversationService } from "@/server/services/conversation-service";
import { InMemoryConversationRepository } from "@/server/services/in-memory/conversation-repository";
import { InMemoryMessageRepository } from "@/server/services/in-memory/message-repository";

import { ConversationCognitiveAdapter } from "./conversation-cognitive-adapter";

const flush = () => new Promise((r) => setImmediate(r));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function setup(maxRemembered?: number) {
  const conversations = new ConversationService(
    new InMemoryConversationRepository(),
    new InMemoryMessageRepository(),
  );
  const answers: ReturnType<typeof deferred<string>>[] = [];
  const histories: Message[][] = [];
  const adapter = new ConversationCognitiveAdapter(
    conversations,
    () => ({
      answer: (history: Message[]) => {
        histories.push(history);
        const d = deferred<string>();
        answers.push(d);
        return d.promise;
      },
    }),
    maxRemembered,
  );
  const messages = async () => {
    const [c] = await conversations.listConversations();
    return c ? (await conversations.getMessages(c.id)).map((m) => [m.role, m.content]) : [];
  };
  return { conversations, adapter, answers, histories, messages };
}

const turn = (
  turnId: string,
  text = "bonjour",
  conversationId: string | null = null,
): CommittedTurn => ({
  conversationId,
  userId: "user-1",
  voiceSessionId: "s-1",
  turnId,
  text,
  speechStartedAt: 0,
  speechEndedAt: 1,
});

async function collect(events: AsyncIterable<CognitiveEvent>) {
  const out: CognitiveEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("ConversationCognitiveAdapter (temporary bridge)", () => {
  it("accepts by storing the user message, then streams one final answer and stores it", async () => {
    const s = setup();
    const accepted = await s.adapter.submitTurn(turn("t-1"), new AbortController().signal);
    expect(await s.messages()).toEqual([["user", "bonjour"]]); // durable before the answer
    const events = collect(accepted.events);
    await flush();
    s.answers[0].resolve("Salut.");
    expect(await events).toEqual([{ type: "FINAL_RESPONSE", text: "Salut." }]);
    expect(await s.messages()).toEqual([
      ["user", "bonjour"],
      ["assistant", "Salut."],
    ]);
    const [conversation] = await s.conversations.listConversations();
    expect(accepted.conversationId).toBe(conversation.id);
  });

  it("is idempotent on turnId, even concurrently", async () => {
    const s = setup();
    const signal = new AbortController().signal;
    await Promise.all([
      s.adapter.submitTurn(turn("t-1"), signal),
      s.adapter.submitTurn(turn("t-1"), signal),
    ]);
    await s.adapter.submitTurn(turn("t-1"), signal);
    await flush();
    expect(await s.messages()).toEqual([["user", "bonjour"]]);
    expect(s.answers).toHaveLength(1);
  });

  it("a phone hang-up does not cancel the answer: it is still stored", async () => {
    const s = setup();
    const hangUp = new AbortController();
    const accepted = await s.adapter.submitTurn(turn("t-1"), hangUp.signal);
    const events = collect(accepted.events);
    hangUp.abort("SESSION_CLOSED");
    await flush();
    s.answers[0].resolve("Réponse gardée.");
    expect(await events).toEqual([]); // nobody to speak to
    await flush();
    expect(await s.messages()).toEqual([
      ["user", "bonjour"],
      ["assistant", "Réponse gardée."],
    ]);
  });

  it("a store failure is CognitiveUnavailable and a resend retries", async () => {
    const s = setup();
    const original = s.conversations.addMessage.bind(s.conversations);
    s.conversations.addMessage = () => Promise.reject(new Error("db down"));
    await expect(
      s.adapter.submitTurn(turn("t-1"), new AbortController().signal),
    ).rejects.toBeInstanceOf(CognitiveUnavailableError);
    s.conversations.addMessage = original;
    await s.adapter.submitTurn(turn("t-1"), new AbortController().signal);
    expect(await s.messages()).toEqual([["user", "bonjour"]]);
  });

  it("a brain failure yields one ERROR and stores no answer", async () => {
    const s = setup();
    const accepted = await s.adapter.submitTurn(turn("t-1"), new AbortController().signal);
    const events = collect(accepted.events);
    await flush();
    s.answers[0].reject(new Error("OmniRoute HTTP 503 secret-detail"));
    const out = await events;
    expect(out).toEqual([{ type: "ERROR", message: "the ICOS brain did not answer" }]);
    expect(await s.messages()).toEqual([["user", "bonjour"]]);
  });

  it("ignores a client conversationId: turns land in the single CEO conversation", async () => {
    const s = setup();
    const existing = await s.conversations.startConversation("Conversation CEO");
    const accepted = await s.adapter.submitTurn(
      turn("t-1", "bonjour", "someone-else"),
      new AbortController().signal,
    );
    expect(accepted.conversationId).toBe(existing.id);
    expect(await s.conversations.getMessages("someone-else").catch(() => [])).toEqual([]);
  });

  it("stated limit: idempotency memory is bounded", async () => {
    const s = setup(2);
    const signal = new AbortController().signal;
    for (const id of ["t-1", "t-2", "t-3"]) await s.adapter.submitTurn(turn(id, id), signal);
    await s.adapter.submitTurn(turn("t-1", "t-1"), signal); // forgotten -> written again
    expect((await s.messages()).map(([, c]) => c)).toEqual(["t-1", "t-2", "t-3", "t-1"]);
  });
});

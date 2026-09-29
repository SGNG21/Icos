import { describe, expect, it } from "vitest";

import { governOutcome } from "@/core/cognitive/turn-policy";

import {
  NotConnectedCognitionEngine,
  OmniRouteCognitionEngine,
  parseCognitionOutput,
} from "./cognition";

const input = {
  userText: "Bonjour",
  context: "(aucun contexte pertinent)",
  conversationTitle: null,
};

describe("cognition boundary", () => {
  it("degrades any invalid model output to a harmless answer (never an action or memory)", () => {
    const smuggled =
      '{"result":{"kind":"ACTION_REQUEST","text":"x","action":{"kind":"Rm -rf","description":"d"}}}';
    expect(parseCognitionOutput(smuggled)).toEqual({
      result: { kind: "ANSWER_ONLY", text: smuggled },
      memorySuggestions: [],
    });
    expect(parseCognitionOutput("pas du json").result).toEqual({
      kind: "ANSWER_ONLY",
      text: "pas du json",
    });
    expect(parseCognitionOutput("").result.kind).toBe("ANSWER_ONLY");
  });

  it("accepts a valid structured output wrapped in prose", () => {
    const out = parseCognitionOutput(
      'Voici : {"result":{"kind":"MISSION_REQUEST","text":"ok","goal":{"title":"T","objective":"O"}},"memorySuggestions":[]}',
    );
    expect(out.result).toMatchObject({
      kind: "MISSION_REQUEST",
      goal: { title: "T", riskLevel: "reversible" },
    });
  });

  it("calls OmniRoute with the configured model and bearer auth, and parses the reply", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"result":{"kind":"CLARIFICATION","question":"Quel client ?"}}',
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const engine = new OmniRouteCognitionEngine("http://omni.test", "k-test", "model-x", fakeFetch);
    const out = await engine.think(input, new AbortController().signal);
    expect(out.result).toEqual({ kind: "CLARIFICATION", question: "Quel client ?" });
    expect(calls[0].url).toBe("http://omni.test/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer k-test");
    expect(JSON.parse(String(calls[0].init.body)).model).toBe("model-x");
    expect(engine.label).toBe("omniroute:model-x");
  });

  it("surfaces an HTTP failure (the runtime marks the turn failed) and honours cancellation", async () => {
    const down = new OmniRouteCognitionEngine(
      "http://omni.test",
      "k",
      "m",
      (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
    );
    await expect(down.think(input, new AbortController().signal)).rejects.toThrow("HTTP 503");
    const slow = new OmniRouteCognitionEngine(
      "http://omni.test",
      "k",
      "m",
      ((_: string, init: RequestInit) =>
        new Promise((_r, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        )) as unknown as typeof fetch,
    );
    const ctrl = new AbortController();
    const pending = slow.think(input, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  it("is explicitly NOT_CONNECTED without full configuration", async () => {
    expect(
      OmniRouteCognitionEngine.fromEnv({
        OMNIROUTE_BASE_URL: "http://x",
      } as unknown as NodeJS.ProcessEnv),
    ).toBeInstanceOf(NotConnectedCognitionEngine);
    const out = await new NotConnectedCognitionEngine().think();
    expect(out.result).toMatchObject({ kind: "ANSWER_ONLY" });
    expect(out.result.kind === "ANSWER_ONLY" && out.result.text).toContain("NOT_CONNECTED");
  });

  it("policy: the engine can only propose — actions need approval, missions become proposals", () => {
    expect(
      governOutcome({
        kind: "ACTION_REQUEST",
        text: "t",
        action: { kind: "email.send", description: "d", riskLevel: "sensitive" },
      }),
    ).toMatchObject({
      outcome: "APPROVAL_REQUEST",
      proposal: { kind: "action_request" },
    });
    expect(
      governOutcome({
        kind: "MISSION_REQUEST",
        text: "t",
        goal: {
          title: "T",
          objective: "O",
          successCriteria: [],
          constraints: [],
          riskLevel: "reversible",
        },
      }),
    ).toMatchObject({
      outcome: "MISSION_REQUEST",
      proposal: { kind: "goal_proposal" },
    });
    expect(governOutcome({ kind: "NO_ACTION" })).toEqual({
      outcome: "NO_ACTION",
      reply: "Aucune action nécessaire.",
    });
    expect(governOutcome({ kind: "ANSWER_ONLY", text: "a" }).proposal).toBeUndefined();
  });
});

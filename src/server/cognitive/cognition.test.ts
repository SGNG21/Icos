import { describe, expect, it } from "vitest";

import { governOutcome, launchPolicy } from "@/core/cognitive/turn-policy";
import { InMemoryScheduledJobRepository } from "@/server/scheduler/in-memory-scheduled-job-repository";
import { SchedulerService } from "@/server/scheduler/scheduler-service";

import {
  NotConnectedCognitionEngine,
  OmniRouteCognitionEngine,
  normalizeCognitionEnvelope,
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
    const degraded = parseCognitionOutput(smuggled);
    // Still fails closed: never an action, never a memory.
    expect(degraded.result.kind).toBe("ANSWER_ONLY");
    expect(degraded.memorySuggestions).toEqual([]);
    // And the rejected payload is NOT echoed back to the user: showing it put
    // internal JSON on a real phone screen (conv-a1a93dc6 regression below).
    expect("text" in degraded.result && degraded.result.text).not.toContain("Rm -rf");
    expect("text" in degraded.result && degraded.result.text).toContain("Reformule");
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
      }),
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

  it("launch policy: a model-asserted risk never skips human approval", () => {
    expect(launchPolicy("goal_proposal")).toEqual({
      status: "approval_required",
      reason: "CONVERSATIONAL_GOAL_RISK_MODEL_ASSERTED",
    });
    expect(launchPolicy("action_request").status).toBe("approval_required");
  });

  it("canonical scheduler: start_mission carries goal lineage and is idempotent on the key", async () => {
    const scheduler = new SchedulerService(new InMemoryScheduledJobRepository());
    const input = {
      kind: "start_mission",
      idempotencyKey: "cognitive-proposal:tref-1",
      payload: { title: "T", objective: "O", goalId: "goal-t-o" },
    };
    const first = await scheduler.enqueue(input);
    const again = await scheduler.enqueue(input);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.job.missionId).toBe(first.job.missionId);
    expect(first.job.payload).toMatchObject({ goalId: "goal-t-o", missionId: first.job.missionId });
    // Unchanged for existing callers: goalId stays optional.
    await expect(
      scheduler.enqueue({
        kind: "start_mission",
        idempotencyKey: "k2",
        payload: { title: "T", objective: "O" },
      }),
    ).resolves.toMatchObject({ created: true });
  });
});

/**
 * Decision 0062. The prompt used to ASSERT capability in prose:
 * "Tu n'exécutes jamais rien toi-même" and "Ce n'est qu'une proposition soumise à
 * approbation humaine". On a real phone that produced a generic-assistant
 * self-description — no external access, every action human-validated — which
 * contradicted ICOS's own governed execution. Capability must come from the
 * runtime context, so the prompt must not contain capability absolutes.
 */
describe("system prompt: no static capability claims", () => {
  const systemPromptOf = async (): Promise<string> => {
    let body = "";
    const fake = (async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"result":{"kind":"NO_ACTION"}}' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await new OmniRouteCognitionEngine("http://o.test", "k", "m", fake).think(
      { userText: "De quoi es-tu capable ?", context: "(vide)", conversationTitle: null },
      new AbortController().signal,
    );
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] })
      .messages;
    return messages.find((m) => m.role === "system")!.content;
  };

  it("no longer claims ICOS can never execute anything", async () => {
    const prompt = await systemPromptOf();
    expect(prompt).not.toContain("Tu n'exécutes jamais rien toi-même");
    // The precise, true statement replaces it.
    expect(prompt).toContain("tu n'exécutes rien directement");
    expect(prompt).toContain("tu PROPOSES");
describe("workload routing: the model is chosen per turn, before the call", () => {
  const requestedModel = async (
    engine: OmniRouteCognitionEngine,
    workload?: "VOICE" | "CONVERSATION_FAST" | "CONVERSATION_DEEP",
  ) => {
    let body = "";
    const fake = (async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"result":{"kind":"NO_ACTION"}}' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const routed = new OmniRouteCognitionEngine(
      "http://o.test",
      "k",
      engine.modelFor(workload),
      fake,
    );
    await routed.think({ ...input, workload }, new AbortController().signal);
    return (JSON.parse(body) as { model: string }).model;
  };

  it("a class with an override gets its model; the others get the default", async () => {
    const engine = new OmniRouteCognitionEngine("http://o.test", "k", {
      default: "deep",
      VOICE: "fast-voice",
    });
    expect(await requestedModel(engine, "VOICE")).toBe("fast-voice");
    expect(await requestedModel(engine, "CONVERSATION_DEEP")).toBe("deep");
    expect(await requestedModel(engine)).toBe("deep");
    expect(engine.label).toBe("omniroute:deep (voice=fast-voice)");
  });

  it("fromEnv reads the per-class overrides and stays NOT_CONNECTED without a default", () => {
    expect(
      OmniRouteCognitionEngine.fromEnv({
        OMNIROUTE_BASE_URL: "http://o",
        OMNIROUTE_API_KEY: "k",
        ICOS_COGNITIVE_MODEL_FAST: "f",
      }).label,
    ).toBe("not_connected");
    const engine = OmniRouteCognitionEngine.fromEnv({
      OMNIROUTE_BASE_URL: "http://o",
      OMNIROUTE_API_KEY: "k",
      ICOS_COGNITIVE_MODEL: "d",
      ICOS_COGNITIVE_MODEL_FAST: "f",
    }) as OmniRouteCognitionEngine;
    expect(engine.modelFor("CONVERSATION_FAST")).toBe("f");
    expect(engine.modelFor("VOICE")).toBe("d");
  });
});

  });

  it("states that an approved mission then runs durably without a human", async () => {
    const prompt = await systemPromptOf();
    expect(prompt).toContain("durablement");
    expect(prompt).toContain("sans supervision humaine continue");
  });

  it("sends capability questions to the runtime context, not to prose", async () => {
    const prompt = await systemPromptOf();
    expect(prompt).toContain("[runtime:capability.*]");
    for (const state of [
      "AUTONOMOUS",
      "GOVERNED",
      "APPROVAL_REQUIRED",
      "NOT_CONNECTED",
      "NOT_SUPPORTED",
    ]) {
      expect(prompt).toContain(state);
    }
  });

  it("forbids claiming an unavailable capability, and forbids 'everything needs approval'", async () => {
    const prompt = await systemPromptOf();
    expect(prompt).toContain("Ne revendique jamais une capacité");
    expect(prompt).toContain("NOT_CONNECTED");
    expect(prompt).toContain("n'affirme jamais que TOUTE action exige une approbation");
  });

  it("fails closed: with no capability lines, ICOS must say it cannot establish its state", async () => {
    const prompt = await systemPromptOf();
    expect(prompt).toContain("Si aucune ligne de capacité n'est fournie");
  });

  it("ranks current runtime state above any earlier self-description", async () => {
    const prompt = await systemPromptOf();
    expect(prompt).toContain("de l'historique, jamais la vérité courante");
    expect(prompt).toContain("ÉTAT ACTUEL DU SYSTÈME");
  });
});

/**
 * Executive conversation model. ICOS is Geoffrey's operational associate, and the
 * answers are SPOKEN on a phone, so a document read aloud is a defect. Identity and
 * style belong in the prompt; capability never does (decision 0062).
 */
describe("system prompt: executive associate, not generic assistant", () => {
  const promptOf = async (): Promise<string> => {
    let body = "";
    const fake = (async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"result":{"kind":"NO_ACTION"}}' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await new OmniRouteCognitionEngine("http://o.test", "k", "m", fake).think(
      { userText: "On en est où ?", context: "(vide)", conversationTitle: null },
      new AbortController().signal,
    );
    return (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages.find(
      (m) => m.role === "system",
    )!.content;
  };

  it("states the associate identity and refuses the generic-assistant framing", async () => {
    const p = await promptOf();
    expect(p).toContain("associé cognitif et opérationnel persistant de Geoffrey");
    expect(p).toContain("ni un chatbot généraliste");
  });

  it("optimises for speech: short, no markdown, no filler", async () => {
    const p = await promptOf();
    expect(p).toContain("STYLE ORAL");
    expect(p).toContain("Pas de markdown");
    expect(p).toContain("Comment puis-je vous aider ?");
  });

  it("takes initiative instead of asking what to do when context suffices", async () => {
    const p = await promptOf();
    expect(p).toContain("que veux-tu que je fasse");
    expect(p).toContain("ambiguïté change réellement l'action");
  });

  /** The discipline that keeps an executive tone from becoming overclaiming. */
  it("separates fact, deduction, recommendation and executed action", async () => {
    const p = await promptOf();
    for (const label of ["FAIT", "DÉDUCTION", "RECOMMANDATION", "ACTION FAITE"]) {
      expect(p).toContain(label);
    }
    expect(p).toContain("JAMAIS une recommandation ou une proposition comme une action accomplie");
  });

  it("forbids inventing a client, project, decision or figure", async () => {
    const p = await promptOf();
    expect(p).toContain("Tu n'inventes jamais");
    for (const noun of ["client", "projet", "décision"]) expect(p).toContain(noun);
  });
});

/**
 * REGRESSION — the phone mission-request bug, 2026-10-01 18:34 (conv-a1a93dc6).
 *
 * The user asked for a bounded test mission. The model returned a valid
 * MISSION_REQUEST but nested `memorySuggestions` and `intent` INSIDE `result`.
 * The result variants are `.strict()`, so the envelope was rejected, the fail-safe
 * turned the raw JSON into the answer TEXT, and the user read internal JSON on
 * their phone. Durable consequence: outcome ANSWER_ONLY, zero proposals, zero
 * jobs, zero missions — the mission silently never existed.
 */
describe("phone mission-request envelope (conv-a1a93dc6 regression)", () => {
  /** The payload the model actually returned, keys and nesting verbatim. */
  const PHONE_RAW = JSON.stringify({
    result: {
      kind: "MISSION_REQUEST",
      text: "Je propose de lancer une mission de test qui analysera l'état actuel du système (capacités, connexions, mémoire) et fournira un résumé sans effectuer d'action externe.",
      goal: {
        title: "Mission de test – analyse système",
        objective:
          "Obtenir un résumé de l'état actuel du système ICOS (capacités, connexions, mémoire) sans déclencher d'action externe.",
        successCriteria: [
          "Résumé clair de l'état actuel produit",
          "Aucun appel à des outils externes",
        ],
        constraints: [
          "Utiliser uniquement les capacités internes",
          "Ne pas déclencher d'actions externes",
        ],
        riskLevel: "read_only",
      },
      memorySuggestions: [
        {
          type: "procedural",
          subjectKey: "mission-test-analyse-systeme",
          content: "Proposition de mission de test pour analyser l'état du système.",
        },
      ],
      intent: "propose-mission",
    },
  });

  it("recovers the MISSION_REQUEST instead of degrading it to an answer", () => {
    const out = parseCognitionOutput(PHONE_RAW);
    expect(out.result.kind).toBe("MISSION_REQUEST");
    if (out.result.kind !== "MISSION_REQUEST") throw new Error("unreachable");
    expect(out.result.goal.title).toBe("Mission de test – analyse système");
    expect(out.result.goal.riskLevel).toBe("read_only");
    expect(out.result.text).toContain("sans effectuer d'action externe");
  });

  it("lifts the misnested keys to their canonical position", () => {
    const out = parseCognitionOutput(PHONE_RAW);
    expect(out.memorySuggestions).toHaveLength(1);
    expect(out.memorySuggestions[0].subjectKey).toBe("mission-test-analyse-systeme");
    expect(out.intent).toBe("propose-mission");
    // The lifted keys must not survive inside the result.
    expect(out.result).not.toHaveProperty("memorySuggestions");
    expect(out.result).not.toHaveProperty("intent");
  });

  it("NEVER renders internal JSON to the user", () => {
    const out = parseCognitionOutput(PHONE_RAW);
    const shown = "text" in out.result ? out.result.text : "";
    expect(shown).not.toContain("MISSION_REQUEST");
    expect(shown).not.toContain('{"');
    expect(shown).not.toContain("memorySuggestions");
  });

  it("an unrecoverable structured answer is reported, not echoed", () => {
    for (const raw of [
      '{"result":{"kind":"NOT_A_KIND"}}',
      '{"result":{"kind":"MISSION_REQUEST","text":"x"}}', // no goal
      '{"totally":"different"}',
      "[1,2,3]",
      "",
    ]) {
      const out = parseCognitionOutput(raw);
      expect(out.result.kind).toBe("ANSWER_ONLY");
      const shown = "text" in out.result ? out.result.text : "";
      expect(shown).not.toContain('{"');
      expect(shown).not.toContain("kind");
      expect(shown).toContain("Reformule");
      // Fails closed: never a mission, an action or a memory.
      expect(out.memorySuggestions).toEqual([]);
    }
  });

  it("still passes plain prose through, which is the useful half of the fail-safe", () => {
    const out = parseCognitionOutput("Oui, je fonctionne correctement.");
    expect(out.result).toEqual({ kind: "ANSWER_ONLY", text: "Oui, je fonctionne correctement." });
  });

  it("does not accept an arbitrary wrapper: only the canonical misnesting is lifted", () => {
    // A foreign key inside `result` must still fail closed.
    const foreign = JSON.stringify({
      result: { kind: "ANSWER_ONLY", text: "ok", somethingElse: 1 },
    });
    const out = parseCognitionOutput(foreign);
    expect("text" in out.result && out.result.text).toContain("Reformule");
    // An extra TOP-LEVEL key must still fail closed too (the envelope is strict).
    const extra = JSON.stringify({ result: { kind: "ANSWER_ONLY", text: "ok" }, stray: true });
    const extraOut = parseCognitionOutput(extra).result;
    expect(extraOut.kind).toBe("ANSWER_ONLY");
    expect("text" in extraOut && extraOut.text).toContain("Reformule");
  });

  it("an outer value wins over a nested one, and already-correct output is untouched", () => {
    const both = JSON.stringify({
      result: { kind: "ANSWER_ONLY", text: "ok", intent: "nested" },
      intent: "outer",
    });
    expect(parseCognitionOutput(both).intent).toBe("outer");
    const correct = JSON.stringify({
      result: { kind: "ANSWER_ONLY", text: "ok" },
      memorySuggestions: [],
      intent: "fine",
    });
    expect(normalizeCognitionEnvelope(JSON.parse(correct))).toEqual(JSON.parse(correct));
  });
});

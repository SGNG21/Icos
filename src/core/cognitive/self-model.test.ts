import { describe, expect, it } from "vitest";

import {
  CAPABILITY_STATES,
  capabilityCandidates,
  capabilityFacts,
  type RuntimeCapabilityProbe,
} from "./self-model";

/**
 * Decision 0062. On a real Xiaomi 13T, ICOS described itself as a generic
 * assistant: "aucun accès externe en temps réel", "je ne peux exécuter aucune
 * action moi-même", "chaque action doit être validée par un humain". All three
 * came from static prose in the cognition prompt, not from the runtime. These
 * tests pin the description to measurement.
 */

/** Everything connected: the shape a fully wired ICOS reports. */
const FULL: RuntimeCapabilityProbe = {
  cognitionConfigured: true,
  conversationDurable: true,
  memoryDurable: true,
  missionIntakeConnected: true,
  durableSchedulerRunning: true,
  toolConnectors: 3,
  toolGrants: 2,
  registeredWorkers: 4,
  routableWorkers: 4,
  governedExecutors: 2,
  realtimeConnectors: 1,
  durableBrains: 12,
  registeredCapabilities: 7,
  speechToText: true,
  textToSpeech: true,
};

/** What the live phone runtime actually reported: cognition yes, tools/workers none. */
const PHONE_RUNTIME: RuntimeCapabilityProbe = {
  ...FULL,
  toolConnectors: 0,
  toolGrants: 0,
  registeredWorkers: 0,
  routableWorkers: 0,
  governedExecutors: 0,
  realtimeConnectors: 0,
  durableBrains: 0,
  registeredCapabilities: 0,
};

const stateOf = (probe: RuntimeCapabilityProbe, key: string) =>
  capabilityFacts(probe).find((f) => f.key === key)?.state;

describe("self-model: the description is a measurement, not prose", () => {
  it("describes autonomous capability as autonomous when the runtime allows it", () => {
    expect(stateOf(FULL, "conversation.context")).toBe("AUTONOMOUS");
    expect(stateOf(FULL, "memory.durable")).toBe("AUTONOMOUS");
    expect(stateOf(FULL, "reasoning.propose")).toBe("AUTONOMOUS");
  });

  it("never claims that EVERY action needs approval", () => {
    const states = capabilityFacts(FULL).map((f) => f.state);
    expect(states).toContain("AUTONOMOUS");
    expect(states).toContain("GOVERNED");
    /*
     * Launching is GOVERNED, not blanket-approval-gated. The class is decided per goal by
     * `classifyMissionAutonomy` from the capabilities it declares: verifiably read-only or
     * worktree-confined work starts on its own, external and irreversible work is asked
     * about. Reporting APPROVAL_REQUIRED for everything was simpler and false.
     */
    expect(stateOf(FULL, "mission.launch")).toBe("GOVERNED");
    expect(states).not.toContain("NOT_SUPPORTED");
  });

  it("describes an approved mission as running durably without a human", () => {
    expect(stateOf(FULL, "mission.execute")).toBe("GOVERNED");
    const fact = capabilityFacts(FULL).find((f) => f.key === "mission.execute");
    expect(fact?.label).toContain("sans superviseur humain");
    // No durable scheduler => the claim is withdrawn, not softened.
    expect(stateOf({ ...FULL, durableSchedulerRunning: false }, "mission.execute")).toBe(
      "NOT_CONNECTED",
    );
  });

  it("does not claim tools or external access when nothing is connected", () => {
    expect(stateOf(PHONE_RUNTIME, "tools.governed")).toBe("NOT_CONNECTED");
    expect(stateOf(PHONE_RUNTIME, "external.realtime")).toBe("NOT_CONNECTED");
    expect(stateOf(PHONE_RUNTIME, "workforce.delegate")).toBe("NOT_CONNECTED");
  });

  it("does not claim external access merely because a connector exists without a grant", () => {
    /* A grant-less connector is not a usable tool, and no executor is available either. */
    expect(stateOf({ ...FULL, toolGrants: 0, governedExecutors: 0 }, "tools.governed")).toBe(
      "NOT_CONNECTED",
    );
    expect(stateOf({ ...FULL, realtimeConnectors: 0 }, "external.realtime")).toBe("NOT_CONNECTED");
  });

  it("claims realtime access only from a real web/search connector", () => {
    expect(stateOf(FULL, "external.realtime")).toBe("GOVERNED");
    /*
     * Tool connectors and grants are NOT web access. This used to follow `toolsUsable`,
     * so any connector at all made ICOS claim it could consult live external data.
     */
    expect(stateOf({ ...FULL, realtimeConnectors: 0 }, "external.realtime")).toBe("NOT_CONNECTED");
  });

  it("reports governed tools when only the Execution Gateway is available", () => {
    /*
     * Hermes and codex launch under the sandbox with no Tool Gateway connector in sight.
     * ICOS used to answer "aucun outil utilisable" on exactly that runtime.
     */
    const gatewayOnly = { ...FULL, toolConnectors: 0, toolGrants: 0, governedExecutors: 2 };
    expect(stateOf(gatewayOnly, "tools.governed")).toBe("GOVERNED");
    expect(stateOf({ ...gatewayOnly, governedExecutors: 0 }, "tools.governed")).toBe(
      "NOT_CONNECTED",
    );
  });

  it("fails closed: an unmeasurable capability is NOT_CONNECTED, never assumed", () => {
    const unknown: RuntimeCapabilityProbe = {
      cognitionConfigured: undefined,
      conversationDurable: undefined,
      memoryDurable: undefined,
      missionIntakeConnected: undefined,
      durableSchedulerRunning: undefined,
      toolConnectors: undefined,
      toolGrants: undefined,
      registeredWorkers: undefined,
      routableWorkers: undefined,
  governedExecutors: undefined,
  realtimeConnectors: undefined,
  durableBrains: undefined,
  registeredCapabilities: undefined,
      speechToText: undefined,
      textToSpeech: undefined,
    };
    const states = new Set(capabilityFacts(unknown).map((f) => f.state));
    expect([...states]).toEqual(["NOT_CONNECTED"]);
  });

  it("withdraws everything cognitive when no engine is configured", () => {
    const noEngine = { ...FULL, cognitionConfigured: false };
    expect(stateOf(noEngine, "conversation.context")).toBe("NOT_CONNECTED");
    expect(stateOf(noEngine, "reasoning.propose")).toBe("NOT_CONNECTED");
  });

  it("says text-only, honestly, when TTS is missing but STT works", () => {
    const fact = capabilityFacts({ ...FULL, textToSpeech: false }).find(
      (f) => f.key === "voice.speech",
    );
    expect(fact?.state).toBe("AUTONOMOUS");
    expect(fact?.evidence).toContain("texte");
  });

  it("only ever uses the five declared states", () => {
    for (const probe of [FULL, PHONE_RUNTIME]) {
      for (const fact of capabilityFacts(probe)) {
        expect(CAPABILITY_STATES).toContain(fact.state);
      }
    }
  });

  it("carries no secret: evidence never contains a key, URL or model id", () => {
    for (const fact of capabilityFacts(FULL)) {
      expect(fact.evidence).not.toMatch(/https?:\/\/|sk-|Bearer|api[_-]?key/i);
    }
  });
});

describe("self-model as context: it must outrank recalled self-description", () => {
  const now = new Date("2026-10-01T18:00:00.000Z");

  it("enters the context as a measured runtime fact, anchored and current", () => {
    const candidates = capabilityCandidates(FULL, now);
    expect(candidates).toHaveLength(capabilityFacts(FULL).length);
    for (const c of candidates) {
      expect(c.stage).toBe("runtime");
      expect(c.kind).toBe("runtime_state");
      // TOOL_CONFIRMED: observed from the system, not inferred by the model.
      expect(c.epistemic).toBe("TOOL_CONFIRMED");
      expect(c.anchored).toBe(true);
      expect(c.trust).toBe("trusted");
      expect(c.occurredAt).toBe(now.toISOString());
      expect(c.ref).toMatch(/^runtime:capability\./);
      expect(c.confidence).toBe(1);
    }
  });

  it("states the capability class in the text the model reads", () => {
    const text = capabilityCandidates(PHONE_RUNTIME, now)
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("NOT_CONNECTED — utiliser des outils");
    expect(text).toContain("GOVERNED — lancer une mission");
    expect(text).toContain("AUTONOMOUS — converser");
  });
});

describe("temporal self-state: current measurement beats recalled prose", () => {
  const now = new Date("2026-10-01T18:00:00.000Z");

  /**
   * REGRESSION for the observed loop. ICOS answered "oui, je ne suis toujours pas
   * connecté" for 8 minutes after cognition was fixed, because two pre-fix
   * assistant turns sat in its context as episodic MODEL_INFERRED items and
   * nothing of higher authority contradicted them. A runtime measurement must
   * always score above a recalled self-description.
   */
  it("a runtime fact outscores a recalled 'I am not connected' turn", async () => {
    const { selectContext } = await import("./context-selection");
    const staleProse = {
      stage: "episodic" as const,
      kind: "turn" as const,
      ref: "turn:stale",
      text: "ICOS: Le moteur cognitif d'ICOS n'est pas connecté (NOT_CONNECTED).",
      anchored: true,
      entityIds: [],
      occurredAt: new Date("2026-10-01T17:39:00.000Z").toISOString(),
      confidence: 1,
      epistemic: "MODEL_INFERRED" as const,
      trust: "trusted" as const,
    };
    const runtime = capabilityCandidates(FULL, now).filter(
      (c) => c.ref === "runtime:capability.conversation.context",
    );
    const selection = selectContext(
      [staleProse, ...runtime],
      // The user's words, which share no vocabulary with the capability line.
      "es-tu connecte",
      new Set<string>(),
      { tokenBudget: 2_000, maxSensitivity: "normal" },
      now,
    );
    const refs = selection.items.map((i) => i.ref);
    expect(refs).toContain("runtime:capability.conversation.context");
    const runtimeItem = selection.items.find((i) => i.ref.startsWith("runtime:"));
    const staleItem = selection.items.find((i) => i.ref === "turn:stale");
    expect(runtimeItem).toBeDefined();
    expect(staleItem).toBeDefined();
    expect(runtimeItem!.score).toBeGreaterThan(staleItem!.score);
  });
});

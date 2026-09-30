import { describe, expect, it } from "vitest";

import type { ServerMessage } from "@/core/voice/contracts";

import {
  initialVoiceState,
  voiceReducer,
  type VoiceAction,
  type VoiceUiState,
} from "./voice-client";
import {
  PHASE,
  isBlocking,
  operationalEvent,
  plainText,
  relativeTime,
  userMessage,
  voicePhase,
} from "./voice-presentation";

const server = (message: ServerMessage): VoiceAction => ({ type: "server", message });
const run = (actions: VoiceAction[], from: VoiceUiState = initialVoiceState) =>
  actions.reduce(voiceReducer, from);
const ready = run([
  server({
    type: "ready",
    sessionId: "s-1",
    conversationId: null,
    resumed: false,
    acceptedTurnIds: [],
    retention: { audio: "none", transcript: "cognitive_runtime", diagnostics: "metadata_only" },
  }),
]);

describe("voicePhase: every phase comes from protocol state", () => {
  it("walks one real turn through its phases", () => {
    expect(voicePhase(initialVoiceState, false)).toBe("CONNECTING");
    expect(voicePhase(ready, false)).toBe("IDLE");
    const talking = run([{ type: "talk", turnId: "t-1" }], ready);
    expect(voicePhase(talking, false)).toBe("LISTENING");
    const sent = run(
      [
        server({ type: "transcript", turnId: "t-1", final: false, rev: 1, text: "bon" }),
        { type: "stop_talking" },
      ],
      talking,
    );
    expect(voicePhase(sent, false)).toBe("TRANSCRIBING");
    const accepted = run(
      [server({ type: "turn_accepted", turnId: "t-1", conversationId: "c" })],
      sent,
    );
    expect(voicePhase(accepted, false)).toBe("THINKING");
    const answered = run(
      [server({ type: "response_final", turnId: "t-1", text: "Oui." })],
      accepted,
    );
    expect(voicePhase(answered, false)).toBe("THINKING"); // text only: no audio playing
    expect(voicePhase(answered, true)).toBe("SPEAKING"); // only when audio really plays
    const done = run(
      [server({ type: "turn_metrics", metrics: { turnId: "t-1" } as never })],
      answered,
    );
    expect(voicePhase(done, false)).toBe("IDLE");
  });

  it("reports interruption, link loss and errors", () => {
    const speaking = run(
      [
        { type: "talk", turnId: "t-1" },
        { type: "stop_talking" },
        server({ type: "turn_accepted", turnId: "t-1", conversationId: "c" }),
        { type: "interrupt" },
      ],
      ready,
    );
    expect(voicePhase(speaking, false)).toBe("INTERRUPTED");
    expect(voicePhase(run([{ type: "link", link: "reconnecting" }], ready), false)).toBe(
      "RECONNECTING",
    );
    expect(voicePhase(run([{ type: "link", link: "offline" }], ready), false)).toBe("OFFLINE");
    expect(voicePhase(run([{ type: "link", link: "unavailable" }], ready), false)).toBe("ERROR");
    const dropped = run(
      [
        { type: "talk", turnId: "t-2" },
        server({
          type: "error",
          code: "TURN_DROPPED",
          retryable: false,
          turnId: "t-2",
          audioLost: true,
          message: "m",
        }),
        { type: "stop_talking" },
      ],
      ready,
    );
    expect(voicePhase(dropped, false)).toBe("ERROR");
  });

  it("every phase has a label and a tone", () => {
    for (const meta of Object.values(PHASE)) {
      expect(meta.label).not.toBe("");
      expect(meta.tone).toBeTruthy();
    }
  });
});

describe("user-facing errors", () => {
  it("never shows a raw code, and maps the protocol codes to French", () => {
    const codes = [
      "TURN_DROPPED",
      "STT_TIMEOUT",
      "TTS_UNAVAILABLE",
      "COGNITIVE_UNAVAILABLE",
      "COGNITIVE_TIMEOUT",
      "COGNITIVE_ERROR",
      "PROVIDER_NOT_CONFIGURED",
      "SESSION_EXPIRED",
      "FORBIDDEN",
      "MICROPHONE",
      "INSECURE_CONTEXT",
      "SOMETHING_UNKNOWN",
    ];
    for (const code of codes) {
      const text = userMessage(code);
      expect(text).not.toMatch(/[A-Z]{3,}_[A-Z]/); // no CODE_LIKE tokens
      expect(text.length).toBeGreaterThan(10);
    }
    expect(isBlocking("PROVIDER_NOT_CONFIGURED")).toBe(true);
    expect(isBlocking("TURN_DROPPED")).toBe(false);
  });
});

describe("operational events: only real runtime data, never JSON", () => {
  it("builds a mission card only from the fields the runtime sent", () => {
    const event = operationalEvent({
      kind: "MISSION_EVENT",
      payload: { title: "Audit fournisseurs", status: "running", workersActive: 3 },
    });
    expect(event).toEqual({
      kind: "mission",
      label: "Mission en cours",
      tone: "flow",
      mission: { title: "Audit fournisseurs", status: "running", workersActive: 3 },
    });
  });

  it("drops what it cannot trust instead of inventing", () => {
    expect(operationalEvent({ kind: "MISSION_EVENT", payload: { status: "running" } })).toBeNull();
    expect(
      operationalEvent({ kind: "MISSION_EVENT", payload: { title: "x", progress: 250 } }),
    ).toBeNull();
    expect(operationalEvent({ kind: "ACTION_EVENT", payload: { raw: { a: 1 } } })).toBeNull();
    expect(operationalEvent({ kind: "APPROVAL_EVENT", payload: 42 })).toEqual({
      kind: "note",
      label: "Approbation requise",
      tone: "warn",
    });
    expect(
      operationalEvent({ kind: "ACTION_EVENT", payload: { summary: "3 workers actifs" } }),
    ).toEqual({ kind: "note", label: "3 workers actifs", tone: "flow" });
  });

  it("keeps runtime events on their turn", () => {
    const s = run(
      [
        server({
          type: "response_event",
          turnId: "t-1",
          kind: "APPROVAL_EVENT",
          payload: { summary: "Paiement fournisseur" },
        }),
      ],
      ready,
    );
    expect(s.turns[0].events).toEqual([
      { kind: "APPROVAL_EVENT", payload: { summary: "Paiement fournisseur" } },
    ]);
  });
});

describe("formatting helpers", () => {
  it("relative time and plain text", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(relativeTime("2026-09-30T11:59:40Z", now)).toBe("à l'instant");
    expect(relativeTime("2026-09-30T11:45:00Z", now)).toBe("il y a 15 min");
    expect(relativeTime("2026-09-30T09:00:00Z", now)).toBe("il y a 3 h");
    expect(plainText("**Mission** `x` __y__")).toBe("Mission x y");
  });
});

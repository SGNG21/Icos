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
  decisionOutcome,
  isBlocking,
  latestMissionEvents,
  operationalEvent,
  plainText,
  proposalCard,
  proposalCards,
  relativeTime,
  userMessage,
  voicePhase,
} from "./voice-presentation";

const server = (message: ServerMessage): VoiceAction => ({ type: "server", message });
const run = (actions: VoiceAction[], from: VoiceUiState = initialVoiceState) =>
  actions.reduce(voiceReducer, from);
const readyMessage: ServerMessage = {
  type: "ready",
  sessionId: "s-1",
  conversationId: null,
  resumed: true,
  acceptedTurnIds: [],
  retention: { audio: "none", transcript: "cognitive_runtime", diagnostics: "metadata_only" },
};
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

describe("regressions from the mobile walkthrough", () => {
  it("a refused or cancelled mic leaves no phantom turn stuck in TRANSCRIBING", () => {
    const refused = run(
      [
        { type: "talk", turnId: "t-1" },
        { type: "discard_turn", turnId: "t-1" },
        { type: "local_error", code: "MICROPHONE", message: "denied" },
      ],
      ready,
    );
    expect(refused.turns).toEqual([]);
    expect(refused.talkingTurnId).toBeNull();
    expect(voicePhase(refused, false)).toBe("ERROR");
    expect(voicePhase(run([{ type: "clear_error" }], refused), false)).toBe("IDLE");
  });

  it("never discards a turn that already reached ICOS", () => {
    const heard = run(
      [
        { type: "talk", turnId: "t-1" },
        server({ type: "transcript", turnId: "t-1", final: true, rev: 1, text: "oui" }),
        { type: "discard_turn", turnId: "t-1" },
      ],
      ready,
    );
    expect(heard.turns).toHaveLength(1);
  });

  it("a dropped turn is an error only while the error is current", () => {
    const dropped = run(
      [
        server({
          type: "error",
          code: "TURN_DROPPED",
          retryable: false,
          turnId: "t-9",
          audioLost: true,
          message: "m",
        }),
      ],
      ready,
    );
    expect(voicePhase(dropped, false)).toBe("ERROR");
    const reconnected = run([server(readyMessage)], dropped);
    expect(voicePhase(reconnected, false)).toBe("IDLE"); // ready clears the error
  });
});

describe("independent review regressions", () => {
  it("H1: a rejected submission is a failed, resendable turn with an honest message", () => {
    const s = run(
      [
        { type: "talk", turnId: "t-1" },
        server({ type: "transcript", turnId: "t-1", final: true, rev: 1, text: "oui" }),
        { type: "stop_talking" },
        server({
          type: "error",
          code: "COGNITIVE_ERROR",
          retryable: true,
          turnId: "t-1",
          text: "oui",
          message: "not confirmed",
        }),
      ],
      ready,
    );
    expect(s.turns[0].state).toBe("failed");
    expect(voicePhase(s, false)).toBe("ERROR");
    expect(userMessage(s.error!.code)).toMatch(/pas confirmé/);
    expect(userMessage("COGNITIVE_ERROR")).toMatch(/bien enregistré/); // mid-answer path
  });

  it("L6: a forbidden session disables the voice link", () => {
    const s = run(
      [server({ type: "error", code: "SESSION_FORBIDDEN", retryable: false, message: "m" })],
      ready,
    );
    expect(s.link).toBe("unavailable");
    expect(voicePhase(s, false)).toBe("ERROR");
  });

  it("M3: one card per mission — only its latest update is drawn", () => {
    const s = run(
      [
        server({
          type: "response_event",
          turnId: "t-1",
          kind: "MISSION_EVENT",
          payload: { missionId: "m-1", title: "Audit", status: "running" },
        }),
        server({
          type: "response_event",
          turnId: "t-2",
          kind: "MISSION_EVENT",
          payload: { missionId: "m-1", title: "Audit", status: "completed" },
        }),
      ],
      ready,
    );
    expect([...latestMissionEvents(s.turns)]).toEqual(["t-2:0"]);
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

describe("durable proposals: the only mission state the phone can show", () => {
  /** Exactly what GET /api/cognitive/conversations/{id} returns for a launched mission. */
  const launched = {
    id: "tref_1",
    conversationId: "conv_1",
    turnId: "turn_1",
    kind: "goal_proposal",
    status: "launched",
    payload: {
      title: "Analyse de l'état du système",
      objective: "Produire un résumé sans action externe.",
      successCriteria: [],
      constraints: [],
      riskLevel: "read_only",
    },
    policyReason: "CONVERSATIONAL_GOAL_RISK_MODEL_ASSERTED",
    decidedBy: "user_1",
    decidedAt: "2026-10-01T10:00:00.000Z",
    goalId: "goal_1",
    missionId: "11111111-2222-3333-4444-555555555555",
    launchJobId: "job_1",
    failureReason: null,
    createdAt: "2026-10-01T09:59:00.000Z",
  };

  it("surfaces the real title and the CORE3 mission id", () => {
    expect(proposalCard(launched)).toEqual({
      refId: "tref_1",
      kind: "goal_proposal",
      title: "Analyse de l'état du système",
      detail: "Produire un résumé sans action externe.",
      label: "Mission lancée",
      tone: "ok",
      missionId: "11111111-2222-3333-4444-555555555555",
      decidable: false,
      failureReason: null,
    });
  });

  /**
   * REGRESSION. The `proposal.created` event payload is only
   * {refId, kind, status, policyReason} — it has no title and no missionId, so it can
   * never be a mission card. The phone must read the record; if someone ever points
   * the mission UI back at the event payload, this test fails.
   */
  it("the proposal.created event payload is not, and cannot be, a mission card", () => {
    const eventPayload = {
      refId: "tref_1",
      kind: "goal_proposal",
      status: "approval_required",
      policyReason: "CONVERSATIONAL_GOAL_RISK_MODEL_ASSERTED",
    };
    expect(operationalEvent({ kind: "MISSION_EVENT", payload: eventPayload })).toBeNull();
    expect(proposalCard(eventPayload)).toBeNull();
  });

  it("only a pending proposal is decidable, and every status has an honest label", () => {
    const at = (status: string) => proposalCard({ ...launched, status, missionId: null });
    expect(at("approval_required")).toMatchObject({
      decidable: true,
      label: "Approbation requise",
      tone: "warn",
    });
    expect(at("proposed")).toMatchObject({ decidable: true, tone: "warn" });
    expect(at("launching")).toMatchObject({ decidable: false, label: "Lancement en cours" });
    expect(at("rejected")).toMatchObject({ decidable: false, label: "Rejetée" });
    expect(at("not_connected")).toMatchObject({ decidable: false, tone: "critical" });
    expect(
      proposalCard({
        ...launched,
        status: "failed",
        missionId: null,
        failureReason: "invalid_goal",
      }),
    ).toMatchObject({ label: "Lancement échoué", tone: "critical", failureReason: "invalid_goal" });
  });

  it("renders an action request from its description", () => {
    expect(
      proposalCard({
        ...launched,
        kind: "action_request",
        status: "approval_required",
        missionId: null,
        payload: { kind: "send_email", description: "Envoyer la relance", riskLevel: "sensitive" },
      }),
    ).toMatchObject({ kind: "action_request", title: "Envoyer la relance", detail: null });
  });

  it("drops a shape it does not understand instead of showing something invented", () => {
    expect(proposalCard({ id: "x", kind: "goal_proposal", status: "launched" })).toBeNull();
    expect(proposalCard({ ...launched, status: "elsewhere" })).toBeNull();
    expect(proposalCard({ ...launched, payload: { title: "" } })).toBeNull();
    expect(proposalCard(null)).toBeNull();
  });

  it("lists the newest first and never breaks on a bad row", () => {
    const older = {
      ...launched,
      id: "tref_0",
      payload: { ...launched.payload, title: "Ancienne" },
    };
    const cards = proposalCards([older, { nope: true }, launched]);
    expect(cards.map((c) => c.refId)).toEqual(["tref_1", "tref_0"]);
    expect(proposalCards(undefined)).toEqual([]);
  });

  /**
   * REGRESSION. A double tap sends two decisions; the server answers the second
   * 409 already_decided. Telling the user "votre décision n'a pas été transmise"
   * there would be false — it was transmitted, and it won.
   */
  it("reads 409 already_decided as landed, not as a failure", () => {
    expect(decisionOutcome(200)).toEqual({ landed: true });
    expect(decisionOutcome(409)).toEqual({ landed: true });
    expect(decisionOutcome(403)).toEqual({ landed: false, code: "DECISION_FORBIDDEN" });
    expect(decisionOutcome(404)).toEqual({ landed: false, code: "DECISION" });
    expect(decisionOutcome(503)).toEqual({ landed: false, code: "DECISION" });
  });

  it("names the decision failures in French", () => {
    expect(userMessage("DECISION")).toContain("décision");
    expect(userMessage("DECISION_FORBIDDEN")).toContain("droit");
    expect(isBlocking("DECISION")).toBe(false);
    expect(isBlocking("DECISION_FORBIDDEN")).toBe(false);
  });
});

describe("formatting helpers", () => {
  it("relative time and plain text", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(relativeTime("2026-09-30T11:59:40Z", now)).toBe("à l'instant");
    expect(relativeTime("2026-09-30T11:45:00Z", now)).toBe("il y a 15 min");
    expect(relativeTime("2026-09-30T09:00:00Z", now)).toBe("il y a 3 h");
    expect(plainText("**Mission** `x` __y__")).toBe("Mission x y");
    expect(plainText("appelle my__init__ ou a__b")).toBe("appelle my__init__ ou a__b");
  });
});

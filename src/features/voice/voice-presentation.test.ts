import { describe, expect, it } from "vitest";

import type { ServerMessage } from "@/core/voice/contracts";

import {
  initialVoiceState,
  voiceReducer,
  type VoiceAction,
  type VoiceUiState,
} from "./voice-client";
import { VOICE_PHASES } from "./voice-session-machine";
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

/*
 * La dérivation de phase a quitté ce module : elle appartient désormais à
 * `voice-session-machine.ts`, seule autorité, avec ses propres preuves (dont « jamais
 * LISTENING sans micro ouvert »). Ce qui est resté ici est l'HABILLAGE, testé ci-dessous ;
 * garder une seconde dérivation sous test aurait recréé exactement la divergence qu'on
 * vient de supprimer.
 */
describe("PHASE: chaque phase de la machine a un libellé, un ton et une aide", () => {
  it("couvre les DIX phases, sans trou", () => {
    expect(Object.keys(PHASE).sort()).toEqual([...VOICE_PHASES].sort());
  });

  it("aucune aide ne demande encore de toucher le micro pour parler", () => {
    /*
     * La session est CONTINUE : un texte qui réclamerait un geste entre deux tours serait
     * une régression d'interface même avec un code juste.
     */
    for (const [phase, meta] of Object.entries(PHASE)) {
      expect(meta.hint, phase).not.toMatch(/touchez le micro/i);
    }
  });

  it("dit explicitement comment ouvrir quand la voix est fermée, et comment interrompre", () => {
    expect(PHASE.OFF.hint).toMatch(/Touchez pour ouvrir/i);
    expect(PHASE.ICOS_SPEAKING.hint).toMatch(/interrompre/i);
    expect(PHASE.LISTENING.hint).toMatch(/quand vous voulez/i);
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
    /* L'erreur est effaçable : c'est elle que la phase lisait, et elle disparaît bien. */
    expect(run([{ type: "clear_error" }], refused).error).toBeNull();
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
    const reconnected = run([server(readyMessage)], dropped);
    expect(reconnected.error).toBeNull(); // un `ready` efface l'erreur
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
    expect(userMessage(s.error!.code)).toMatch(/pas confirmé/);
    expect(userMessage("COGNITIVE_ERROR")).toMatch(/bien enregistré/); // mid-answer path
  });

  it("L6: a forbidden session disables the voice link", () => {
    const s = run(
      [server({ type: "error", code: "SESSION_FORBIDDEN", retryable: false, message: "m" })],
      ready,
    );
    expect(s.link).toBe("unavailable");
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
    // An unconfigured cognition engine blocks the screen: retrying cannot fix config.
    expect(isBlocking("COGNITION_NOT_CONFIGURED")).toBe(true);
    expect(userMessage("COGNITION_NOT_CONFIGURED")).toContain("moteur cognitif");
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
    policyReason: "APPROVAL_REQUIRED: aucune capacité déclarée : portée non vérifiable",
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
      policyReason: "APPROVAL_REQUIRED: aucune capacité déclarée : portée non vérifiable",
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

/**
 * The boundary that actually broke on the phone, end to end at the pure layer:
 * model output → envelope normalization → governed outcome → launch policy →
 * the durable proposal shape → the card the phone draws. Each step is the real
 * function, so a regression anywhere in the chain fails here.
 */
describe("phone mission request renders an approval card, never raw JSON", () => {
  const PHONE_RAW = JSON.stringify({
    result: {
      kind: "MISSION_REQUEST",
      text: "Je propose de lancer une mission de test qui analysera l'état actuel du système.",
      goal: {
        title: "Mission de test – analyse système",
        objective: "Obtenir un résumé de l'état actuel du système ICOS.",
        successCriteria: ["Résumé clair produit"],
        constraints: ["Aucune action externe"],
        riskLevel: "read_only",
      },
      memorySuggestions: [],
      intent: "propose-mission",
    },
  });

  it("turns the phone's own payload into a decidable card with the real title", async () => {
    const { parseCognitionOutput } = await import("@/server/cognitive/cognition");
    const { governOutcome, launchPolicy } = await import("@/core/cognitive/turn-policy");

    const out = parseCognitionOutput(PHONE_RAW);
    expect(out.result.kind).toBe("MISSION_REQUEST");

    const governed = governOutcome(out.result);
    expect(governed.outcome).toBe("MISSION_REQUEST");
    expect(governed.proposal?.kind).toBe("goal_proposal");

    // The policy that decides the initial status of the persisted proposal.
    const policy = launchPolicy("goal_proposal");
    expect(policy.status).toBe("approval_required");

    // The durable row that status produces, as the API returns it.
    const card = proposalCard({
      id: "tref_phone",
      kind: "goal_proposal",
      status: policy.status,
      payload: governed.proposal!.payload,
      missionId: null,
      failureReason: null,
    });

    expect(card).toMatchObject({
      kind: "goal_proposal",
      title: "Mission de test – analyse système",
      label: "Approbation requise",
      decidable: true,
      missionId: null,
    });
    // The spoken/displayed reply is prose, and the card title is not JSON.
    expect(governed.reply).not.toContain('{"');
    expect(card!.title).not.toContain('{"');
  });

  it("a refused proposal stops being decidable and claims no mission", () => {
    const card = proposalCard({
      id: "tref_phone",
      kind: "goal_proposal",
      status: "rejected",
      payload: { title: "Mission de test", objective: "x" },
      missionId: null,
      failureReason: null,
    });
    expect(card).toMatchObject({ decidable: false, label: "Rejetée", missionId: null });
  });
});

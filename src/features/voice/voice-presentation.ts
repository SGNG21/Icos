import { z } from "zod";

import { REF_KINDS, REF_STATUSES, type RefKind, type RefStatus } from "@/core/cognitive/contracts";
import { MissionEventPayloadSchema, type MissionEventPayload } from "@/core/voice/contracts";

import type { VoiceTurnView, VoiceUiState } from "./voice-client";

/**
 * What the phone shows (decision 0056): every visual state is derived from
 * real protocol state — nothing is simulated for effect. Pure, so it is tested
 * without a browser.
 */

export type VoicePhase =
  | "CONNECTING"
  | "IDLE"
  | "LISTENING"
  | "TRANSCRIBING"
  | "THINKING"
  | "SPEAKING"
  | "INTERRUPTED"
  | "RECONNECTING"
  | "ERROR"
  | "OFFLINE";

/** Locked Control Center tones: colour is never the only channel (icon + word too). */
export type Tone = "flow" | "ok" | "critical" | "autonomy" | "warn" | "unknown";

export const PHASE: Record<VoicePhase, { label: string; hint: string; tone: Tone }> = {
  CONNECTING: { label: "Connexion", hint: "Connexion sécurisée à ICOS…", tone: "unknown" },
  IDLE: { label: "Prêt", hint: "Touchez le micro pour parler", tone: "ok" },
  LISTENING: { label: "À l'écoute", hint: "Parlez, puis touchez pour envoyer", tone: "flow" },
  TRANSCRIBING: {
    label: "Transcription",
    hint: "ICOS finalise ce que vous avez dit",
    tone: "flow",
  },
  THINKING: { label: "Réflexion", hint: "ICOS prépare sa réponse", tone: "autonomy" },
  SPEAKING: { label: "ICOS parle", hint: "Touchez le micro pour l'interrompre", tone: "autonomy" },
  INTERRUPTED: { label: "Interrompu", hint: "Touchez le micro pour reprendre", tone: "warn" },
  RECONNECTING: { label: "Reconnexion", hint: "Le lien avec ICOS est rétabli…", tone: "warn" },
  ERROR: { label: "Problème", hint: "", tone: "critical" },
  OFFLINE: { label: "Hors ligne", hint: "Vérifiez votre connexion réseau", tone: "critical" },
};

/** The single phase the screen shows, from the reducer state and the real playback flag. */
export function voicePhase(state: VoiceUiState, speaking: boolean): VoicePhase {
  if (state.link === "offline") return "OFFLINE";
  if (state.link === "unavailable") return "ERROR";
  if (state.link === "reconnecting") return "RECONNECTING";
  if (state.link === "connecting") return "CONNECTING";
  if (state.talkingTurnId) return "LISTENING";
  if (speaking) return "SPEAKING";
  const last = state.turns.at(-1);
  if (!last) return state.error ? "ERROR" : "IDLE";
  switch (last.state) {
    case "listening":
      // Sent, but ICOS has not accepted it yet: the final transcript is being made.
      return "TRANSCRIBING";
    case "thinking":
    case "answering":
      return "THINKING";
    case "interrupted":
      return "INTERRUPTED";
    case "dropped":
    case "failed":
      // Only while the problem is current; the turn itself keeps its badge.
      return state.error ? "ERROR" : "IDLE";
    case "done":
      return "IDLE";
  }
}

/**
 * User-facing French for protocol and local error codes. The code itself is
 * kept for the diagnostics panel only.
 */
export function userMessage(code: string): string {
  switch (code) {
    case "TURN_DROPPED":
      return "Je n'ai rien entendu. Touchez le micro et réessayez.";
    case "STT_UNAVAILABLE":
    case "STT_TIMEOUT":
      return "La reconnaissance vocale ne répond pas. Réessayez dans un instant.";
    case "TTS_UNAVAILABLE":
    case "TTS_TIMEOUT":
      return "La voix d'ICOS est indisponible : la réponse s'affiche en texte.";
    case "COGNITIVE_UNAVAILABLE":
      return "ICOS n'a pas pu recevoir votre message. Vous pouvez le renvoyer.";
    case "COGNITIVE_TIMEOUT":
      return "ICOS met trop de temps à répondre. Vous pouvez renvoyer votre message.";
    case "COGNITIVE_ERROR":
      return "ICOS n'a pas pu terminer sa réponse. Votre message est bien enregistré.";
    case "COGNITIVE_REJECTED":
      return "ICOS n'a pas confirmé votre message. Vous pouvez le renvoyer.";
    case "PROVIDER_NOT_CONFIGURED":
      return "La voix n'est pas activée sur ce serveur ICOS.";
    case "SESSION_EXPIRED":
      return "Session vocale expirée : une nouvelle session a démarré.";
    case "SESSION_FORBIDDEN":
    case "FORBIDDEN":
      return "Accès vocal refusé pour ce compte.";
    case "MICROPHONE":
      return "Micro inaccessible. Autorisez le micro pour ICOS dans votre navigateur.";
    case "INSECURE_CONTEXT":
      return "Le micro exige une connexion sécurisée (HTTPS).";
    case "PLAYBACK":
      return "Un extrait audio n'a pas pu être lu.";
    case "DECISION":
      return "Votre décision n'a pas été transmise. Réessayez.";
    case "DECISION_FORBIDDEN":
      return "Votre compte n'a pas le droit d'approuver une mission.";
    default:
      return "Un problème est survenu. Réessayez.";
  }
}

/** Errors that concern the whole screen (not one message bubble). */
export function isBlocking(code: string): boolean {
  return ["PROVIDER_NOT_CONFIGURED", "FORBIDDEN", "SESSION_FORBIDDEN", "INSECURE_CONTEXT"].includes(
    code,
  );
}

// --- operational events ------------------------------------------------------

const Text = z.string().trim().min(1).max(200);

export type MissionCard = MissionEventPayload;

const SummaryPayload = z.object({ summary: Text });

export type OperationalEvent =
  | { kind: "mission"; label: string; tone: Tone; mission: MissionCard }
  | { kind: "note"; label: string; tone: Tone };

const MISSION_STATUS: Record<NonNullable<MissionCard["status"]>, { label: string; tone: Tone }> = {
  created: { label: "Mission créée", tone: "flow" },
  running: { label: "Mission en cours", tone: "flow" },
  blocked: { label: "Mission bloquée", tone: "warn" },
  completed: { label: "Mission terminée", tone: "ok" },
  failed: { label: "Mission en échec", tone: "critical" },
};

export function missionStatusLabel(status: MissionCard["status"]): { label: string; tone: Tone } {
  return status ? MISSION_STATUS[status] : { label: "Mission", tone: "unknown" };
}

/** Turns a runtime event into something worth showing — or null. Never raw JSON. */
export function operationalEvent(event: VoiceTurnView["events"][number]): OperationalEvent | null {
  if (event.kind === "MISSION_EVENT") {
    const mission = MissionEventPayloadSchema.safeParse(event.payload);
    if (!mission.success) return null;
    const { label, tone } = missionStatusLabel(mission.data.status);
    return { kind: "mission", label, tone, mission: mission.data };
  }
  const summary = SummaryPayload.safeParse(event.payload);
  if (event.kind === "APPROVAL_EVENT") {
    return {
      kind: "note",
      label: summary.success
        ? `Approbation requise — ${summary.data.summary}`
        : "Approbation requise",
      tone: "warn",
    };
  }
  return summary.success ? { kind: "note", label: summary.data.summary, tone: "flow" } : null;
}

/** "il y a 3 min" — only from a real timestamp. */
export function relativeTime(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `il y a ${hours} h` : `il y a ${Math.floor(hours / 24)} j`;
}

/** Answers are plain text on a phone: drop markdown emphasis markers. */
export function plainText(text: string): string {
  // Paired markers only: `__init__`-like text inside a sentence stays intact.
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|\s)__(\S(?:.*?\S)?)__(?=\s|$|[.,;:!?])/g, "$1$2");
}

/**
 * Mission events that should be drawn: one card per mission (its latest
 * update), so a stale "en cours" never sits next to "terminée".
 */
export function latestMissionEvents(turns: VoiceTurnView[]): Set<string> {
  const latest = new Map<string, string>();
  for (const turn of turns) {
    turn.events.forEach((event, i) => {
      const parsed = operationalEvent(event);
      if (parsed?.kind === "mission") {
        latest.set(parsed.mission.missionId ?? `${turn.id}:${i}`, `${turn.id}:${i}`);
      }
    });
  }
  return new Set(latest.values());
}

// --- durable proposals -------------------------------------------------------

/**
 * What the phone shows for a mission/action PROPOSAL, read from the durable
 * record (`GET /api/cognitive/conversations/{id}` → `proposals`) rather than
 * from the `proposal.created` event: that event carries only
 * `{refId, kind, status, policyReason}`, so the mission's real title and its
 * CORE3 `missionId` exist nowhere else. The runtime is the authority — same
 * rule the voice adapter already applies to the reply text.
 */
export type ProposalCard = {
  refId: string;
  kind: RefKind;
  title: string;
  detail: string | null;
  label: string;
  tone: Tone;
  /** Canonical CORE3 identity; only ever set once the launch fixed it. */
  missionId: string | null;
  /** This human still owes a decision: the only state with actions. */
  decidable: boolean;
  failureReason: string | null;
};

const PROPOSAL_STATUS: Record<RefStatus, { label: string; tone: Tone }> = {
  proposed: { label: "Proposition", tone: "warn" },
  approval_required: { label: "Approbation requise", tone: "warn" },
  approved: { label: "Approuvée", tone: "flow" },
  launching: { label: "Lancement en cours", tone: "flow" },
  launched: { label: "Mission lancée", tone: "ok" },
  rejected: { label: "Rejetée", tone: "unknown" },
  failed: { label: "Lancement échoué", tone: "critical" },
  not_connected: { label: "Backend non connecté", tone: "critical" },
};

/** Only these two await a human; every other status is a fact, not a question. */
const DECIDABLE: ReadonlySet<RefStatus> = new Set<RefStatus>(["proposed", "approval_required"]);

const Nullable = (max: number) => z.string().trim().min(1).max(max).nullish();

/** The subset of a durable TurnReference the phone renders. Unknown shapes are dropped. */
const ProposalRefSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(REF_KINDS),
  status: z.enum(REF_STATUSES),
  payload: z.union([
    z.object({ title: Text, objective: Nullable(4_000) }),
    z.object({ description: z.string().trim().min(1).max(2_000) }),
  ]),
  missionId: Nullable(128),
  failureReason: Nullable(500),
});

/**
 * One durable proposal as a card — or null when the shape is not what this
 * client understands. Pure: the component only renders what comes back.
 */
export function proposalCard(ref: unknown): ProposalCard | null {
  const parsed = ProposalRefSchema.safeParse(ref);
  if (!parsed.success) return null;
  const { id, kind, status, payload, missionId, failureReason } = parsed.data;
  const { label, tone } = PROPOSAL_STATUS[status];
  const goal = "title" in payload;
  return {
    refId: id,
    kind,
    title: goal ? payload.title : payload.description.slice(0, 200),
    detail: goal ? (payload.objective ?? null) : null,
    label,
    tone,
    missionId: missionId ?? null,
    decidable: DECIDABLE.has(status),
    failureReason: failureReason ?? null,
  };
}

/** Newest first: a phone screen shows the decision it owes before its history. */
export function proposalCards(proposals: unknown): ProposalCard[] {
  if (!Array.isArray(proposals)) return [];
  return proposals
    .map(proposalCard)
    .filter((card): card is ProposalCard => card !== null)
    .reverse();
}

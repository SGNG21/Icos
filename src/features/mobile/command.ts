import {
  ASK_MAX_LENGTH,
  type AskProposal,
  type AskTurn,
  type Reply,
  type SubmitPhase,
  type TurnResult,
} from "@/features/cockpit/ask";

/**
 * Mobile command bar — PURE state machine.
 *
 * The phone's only conversational write path, modelled here so every hazard is
 * testable without a DOM: a double submit must never create two durable turns, an
 * UNKNOWN submission must be reconciled with the SAME idempotency key, and a settled
 * failure must never be shown as "connecting".
 *
 * It renders only what ICOS stored and returned. It never reads the conversation back
 * through `resume`: that endpoint closes interrupted turns and finishes approved
 * proposals (see `CognitiveRuntime.resume`), so calling it on arrival would make opening
 * the home screen mutate durable state and could complete a goal launch. Rendering stays
 * a read; everything shown here is the response to a submission the owner made.
 *
 * Arrival is INERT — `idle`, not `loading`. Even listing conversations is not free: every
 * entry into the Cognitive Runtime's HTTP surface composes the runtime, and composing it
 * relaunches the tenant's interrupted goal launches at most once a minute
 * (`cognitiveRuntimeFor` -> `recoverLaunches` -> `launch`, which enqueues `start_mission`).
 * That is lane C's behaviour behind a GET, not ours to change here; what is ours is to
 * stop provoking it from the root page. So the link is probed on the owner's FIRST
 * GESTURE, never on mount: opening the Mobile Home touches the runtime zero times.
 */

export type CommandLink =
  /** Nothing has been asked of the runtime yet. The only state a fresh render may show. */
  | "idle"
  | "loading"
  | "ready"
  | "not_connected"
  | "unavailable"
  | "error";

export interface PendingSubmission {
  readonly text: string;
  readonly idempotencyKey: string;
  readonly phase: SubmitPhase;
  readonly detail?: string;
}

export interface CommandState {
  /** Availability of the Cognitive Runtime itself. */
  readonly link: CommandLink;
  readonly engine: string | null;
  /** The durable conversation every submission continues (the runtime holds the context). */
  readonly conversationId: string | null;
  /** Turns submitted from this device and the stored replies ICOS returned for them. */
  readonly turns: readonly AskTurn[];
  readonly proposals: readonly AskProposal[];
  readonly pending: PendingSubmission | null;
  readonly message: string | null;
  /** A submission is on the wire. Guards the window before React re-renders. */
  readonly sending: boolean;
}

export const initialCommand: CommandState = {
  link: "idle",
  engine: null,
  conversationId: null,
  turns: [],
  proposals: [],
  pending: null,
  message: null,
  sending: false,
};

export type CommandAction =
  | { type: "probing" }
  | { type: "listed"; engine: string; conversationId: string | null }
  | { type: "link"; link: CommandLink; message?: string }
  | { type: "message"; message: string | null }
  | { type: "conversation"; id: string }
  | { type: "sending"; text: string; idempotencyKey: string }
  | { type: "settled"; result: TurnResult; phase: SubmitPhase; detail?: string }
  | { type: "failed"; phase: SubmitPhase; detail?: string }
  | { type: "proposal"; proposal: AskProposal };

const upsertTurn = (turns: readonly AskTurn[], turn: AskTurn): AskTurn[] => {
  const next = turns.filter((t) => t.id !== turn.id);
  next.push(turn);
  return next.sort((a, b) => a.seq - b.seq);
};

const upsertProposal = (
  proposals: readonly AskProposal[],
  proposal: AskProposal,
): AskProposal[] => [...proposals.filter((p) => p.id !== proposal.id), proposal];

export function commandReducer(state: CommandState, action: CommandAction): CommandState {
  switch (action.type) {
    case "probing":
      // Only an idle link may be probed: never restart a settled failure as "connecting".
      return state.link === "idle" ? { ...state, link: "loading" } : state;
    case "listed":
      return {
        ...state,
        link: "ready",
        engine: action.engine,
        conversationId: action.conversationId ?? state.conversationId,
      };
    case "link": {
      // A link that is no longer ready settles any submission still shown as in flight:
      // "ICOS traite ce tour" and "rien n'a été envoyé" must never appear together.
      const stalled = action.link !== "ready" && state.pending?.phase === "submitting";
      return {
        ...state,
        link: action.link,
        message: action.message ?? state.message,
        sending: action.link === "ready" ? state.sending : false,
        pending:
          stalled && state.pending
            ? { ...state.pending, phase: "rejected", detail: undefined }
            : state.pending,
      };
    }
    case "message":
      return { ...state, message: action.message };
    case "conversation":
      return { ...state, conversationId: action.id };
    case "sending":
      return {
        ...state,
        sending: true,
        message: null,
        pending: { text: action.text, idempotencyKey: action.idempotencyKey, phase: "submitting" },
      };
    case "settled": {
      let turns = upsertTurn(state.turns, action.result.turn);
      if (action.result.reply) turns = upsertTurn(turns, action.result.reply);
      return {
        ...state,
        sending: false,
        turns,
        proposals: action.result.proposal
          ? upsertProposal(state.proposals, action.result.proposal)
          : state.proposals,
        pending: state.pending
          ? { ...state.pending, phase: action.phase, detail: action.detail }
          : null,
      };
    }
    case "failed":
      return {
        ...state,
        sending: false,
        pending: state.pending
          ? { ...state.pending, phase: action.phase, detail: action.detail }
          : null,
      };
    case "proposal":
      return { ...state, proposals: upsertProposal(state.proposals, action.proposal) };
  }
}

/** A user turn ICOS has not settled yet. A second turn would be refused (409) anyway. */
export const openTurn = (state: CommandState): AskTurn | undefined =>
  state.turns.find(
    (t) => t.role === "user" && (t.status === "received" || t.status === "processing"),
  );

export const isBusy = (state: CommandState): boolean =>
  state.sending || state.pending?.phase === "submitting" || Boolean(openTurn(state));

/** The runtime has never been asked anything: the owner's first gesture may probe it. */
export const needsProbe = (state: CommandState): boolean => state.link === "idle";

/**
 * Whether the owner may type. `idle` is typable on purpose: the field is what triggers the
 * probe, so disabling it until the link is known would make the probe unreachable. Sending
 * still requires `ready` — a draft is not a submission.
 */
export const canType = (state: CommandState): boolean =>
  (state.link === "idle" || state.link === "ready") && !isBusy(state);

/** Body-only validity. `canSend` is this plus a ready link and nothing in flight. */
export const bodyFits = (body: string): boolean => {
  const text = body.trim();
  return text.length > 0 && text.length <= ASK_MAX_LENGTH;
};

export function canSend(state: CommandState, body: string): boolean {
  return state.link === "ready" && bodyFits(body) && !isBusy(state);
}

/**
 * The key a submission must carry. The SAME unresolved question keeps its key whichever
 * button sent it, so a retry after an UNKNOWN reply returns the stored turn instead of
 * creating a second one. A different question always gets a fresh key.
 */
export function keyFor(state: CommandState, body: string, fresh: () => string): string {
  const pending = state.pending;
  if (pending && pending.text === body.trim() && !TERMINAL_PHASES.has(pending.phase))
    return pending.idempotencyKey;
  return fresh();
}

/** Phases after which the submission is settled: a new send is a new question. */
const TERMINAL_PHASES: ReadonlySet<SubmitPhase> = new Set<SubmitPhase>([
  "accepted",
  "replayed",
  "failed",
  "cancelled",
  "rejected",
]);

/**
 * Whether the pending submission may be sent again under its OWN key.
 *
 * This deliberately does NOT check `isBusy`: a replay carries the same idempotency key,
 * so the runtime returns the stored turn instead of running it twice — it cannot create a
 * second turn. Blocking it on the open turn it is asking about is what would deadlock the
 * screen, because a turn settled as `processing` has no other way to ever be resolved.
 */
export const canReplay = (state: CommandState): boolean =>
  state.link === "ready" &&
  !state.sending &&
  state.pending !== null &&
  !TERMINAL_PHASES.has(state.pending.phase);

/** An unresolved submission the owner can act on: ask ICOS again for its stored outcome. */
export const canRetry = (state: CommandState): boolean =>
  canReplay(state) && (state.pending?.phase === "unknown" || state.pending?.phase === "processing");

/**
 * Link state for a failed call. A settled hard failure is UNKNOWN, never left as
 * "connecting": the owner must never read an indefinite progress state for a dead link.
 */
export function linkFor(reply: Exclude<Reply<unknown>, { kind: "ok" }>): CommandLink {
  if (reply.kind === "not_connected") return "not_connected";
  if (reply.status === 503) return "unavailable";
  return "error";
}

export const describeFailure = (reply: Exclude<Reply<unknown>, { kind: "ok" }>): string =>
  reply.kind === "not_connected" ? "non connecté" : `${reply.code} (HTTP ${reply.status})`;

/** The conversation a submission continues: the runtime's most recently updated one. */
export function latestConversation<T extends { updatedAt: string }>(
  conversations: readonly T[],
): T | undefined {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * What an approval actually commits to. The proposal text is model-authored and may come
 * from untrusted retrieved content, so the owner is shown the canonical payload fields the
 * decision acts on — action/objective, risk, criteria, constraints — not a summary alone.
 */
export function proposalRows(proposal: AskProposal): { label: string; value: string | null }[] {
  const p = proposal.payload;
  if (proposal.kind === "goal_proposal")
    return [
      { label: "Objectif", value: str(p.title) },
      { label: "Détail", value: str(p.objective) },
      { label: "Risque", value: str(p.riskLevel) },
      { label: "Critères de succès", value: strs(p.successCriteria).join(" · ") || null },
      { label: "Contraintes", value: strs(p.constraints).join(" · ") || null },
    ];
  return [
    { label: "Action", value: str(p.kind) },
    { label: "Détail", value: str(p.description) },
    { label: "Risque", value: str(p.riskLevel) },
  ];
}

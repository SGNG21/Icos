import { z } from "zod";

import { REF_STATUSES } from "@/core/cognitive/contracts";

/**
 * ASK ICOS — cockpit client of the Cognitive Runtime (lane C, decision 0056,
 * committed on feat/cognitive-runtime). The browser renders durable state and
 * the durable event log; it never produces, interprets or approves anything
 * itself. Contract consumed (BR-28, as committed by lane C):
 *
 *   GET  /api/cognitive/conversations                 → { conversations, engine }
 *   POST /api/cognitive/conversations                 { title? } → 201 { conversation }
 *   GET  /api/cognitive/conversations/:id             → ConversationState (resume; recovers interrupted turns)
 *   POST /api/cognitive/conversations/:id/turns       { text, idempotencyKey } → 201 | 200 replayed: TurnResult
 *        synchronous until the turn settles; 409 invalid_transition = a turn is already in flight
 *   GET  /api/cognitive/conversations/:id/events?after=N  (Accept: text/event-stream; SSE id = seq,
 *        server closes after ~25 s → reconnect with the cursor)
 *   POST /api/cognitive/conversations/:id/turns/:turnId/cancel
 *   POST /api/cognitive/conversations/:id/proposals/:refId/decision { decision } (missions.write)
 *
 * No token streaming exists: the reply is a whole assistant turn. A mission request becomes a
 * goal PROPOSAL; approval files a pending goal — the turn never waits on a mission lifecycle.
 */
export const ASK_MAX_LENGTH = 20_000;

/** Structural subset of lane C's types (extra keys pass: the runtime may add fields). */
const turnSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    seq: z.number(),
    role: z.enum(["user", "assistant"]),
    content: z.object({ parts: z.array(z.object({ kind: z.string(), text: z.string() })) }),
    status: z.enum(["received", "processing", "completed", "failed", "cancelled"]),
    outcome: z.string().nullable(),
    replyToTurnId: z.string().nullable(),
    failureReason: z.string().nullable(),
    createdAt: z.string(),
  })
  .passthrough();
export type AskTurn = z.infer<typeof turnSchema>;

/**
 * A `TurnReference` as the runtime actually serializes it (`src/core/cognitive/contracts.ts`).
 *
 * This schema used to require an `externalId` the runtime has never had, and a status
 * vocabulary (`awaiting_approval`, `submitted`) it never emits — so EVERY real proposal
 * failed `safeParse`. The visible effect was severe: a decision that the server had
 * already recorded, and whose goal it had already filed through canonical intake, came
 * back as `unexpected_response` and was shown to the owner as "refused". The schema now
 * follows `REF_STATUSES`, and the two legacy strings are still accepted so the cockpit's
 * own branches keep working while they are migrated.
 */
const proposalSchema = z
  .object({
    id: z.string(),
    turnId: z.string(),
    kind: z.enum(["goal_proposal", "action_request"]),
    status: z.enum([...REF_STATUSES, "awaiting_approval", "submitted"]),
    payload: z.record(z.string(), z.unknown()),
    /** Canonical launch identity, set once a proposal reaches CORE3 / goal intake. */
    goalId: z.string().nullable().optional(),
    missionId: z.string().nullable().optional(),
    launchJobId: z.string().nullable().optional(),
    /** Why the policy put the proposal in its initial state. */
    policyReason: z.string().optional(),
    failureReason: z.string().nullable().optional(),
    /** Legacy alias kept for the cockpit screen; the runtime does not send it. */
    externalId: z.string().nullable().optional(),
  })
  .passthrough();
export type AskProposal = z.infer<typeof proposalSchema>;

/** The canonical state in which a proposal is waiting for a human decision. */
export const PROPOSAL_AWAITING: readonly AskProposal["status"][] = [
  "approval_required",
  "awaiting_approval",
];

const conversationSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable(),
    status: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type AskConversation = z.infer<typeof conversationSchema>;

export const CONVERSATION_EVENT_TYPES = [
  "conversation.created",
  "turn.received",
  "turn.processing",
  "context.assembled",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "proposal.created",
  "proposal.decided",
  "proposal.submitted",
  "memory.written",
] as const;
export const conversationEventSchema = z
  .object({
    conversationId: z.string(),
    seq: z.number().int().nonnegative(),
    type: z.enum(CONVERSATION_EVENT_TYPES),
    turnId: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .passthrough();
export type ConversationEvent = z.infer<typeof conversationEventSchema>;

export const listSchema = z.object({
  conversations: z.array(conversationSchema),
  engine: z.string(),
});
export const stateSchema = z
  .object({
    conversation: conversationSchema,
    turns: z.array(turnSchema),
    proposals: z.array(proposalSchema),
    recoveredTurnIds: z.array(z.string()),
  })
  .passthrough();
export type ConversationState = z.infer<typeof stateSchema>;
export const turnResultSchema = z.object({
  turn: turnSchema,
  reply: turnSchema.nullable(),
  proposal: proposalSchema.nullable(),
  replayed: z.boolean(),
});
export type TurnResult = z.infer<typeof turnResultSchema>;

/**
 * The runtime's CURRENT engine label (process-wide, not per turn). `not_connected` means new
 * replies are the runtime's canned notice, not analysis — the UI must say so prominently.
 */
export const ENGINE_NOT_CONNECTED = "not_connected";

// ------------------------------------------------------------------ transport

export type Reply<T> =
  | { kind: "ok"; status: number; value: T }
  | { kind: "not_connected" }
  | { kind: "error"; status: number; code: string; message: string; typed: boolean };

const envelope = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

async function parse<T>(res: Response, schema: z.ZodType<T>): Promise<Reply<T>> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const ok = res.ok ? schema.safeParse(body) : null;
  if (ok?.success) return { kind: "ok", status: res.status, value: ok.data };
  const env = envelope.safeParse(body);
  if (env.success) return { kind: "error", status: res.status, ...env.data.error, typed: true };
  if (res.status === 404) return { kind: "not_connected" };
  return {
    kind: "error",
    status: res.status,
    code: "unexpected_response",
    message: "",
    typed: false,
  };
}

export type StreamOutcome = "closed" | "not_connected" | "not_found" | "link_lost";

export interface CognitiveTransport {
  list(): Promise<Reply<z.infer<typeof listSchema>>>;
  create(title?: string): Promise<Reply<{ conversation: AskConversation }>>;
  resume(id: string): Promise<Reply<ConversationState>>;
  submit(id: string, input: { text: string; idempotencyKey: string }): Promise<Reply<TurnResult>>;
  events(
    id: string,
    after: number,
    onEvent: (e: ConversationEvent) => void,
    signal?: AbortSignal,
  ): Promise<StreamOutcome>;
  cancel(id: string, turnId: string): Promise<Reply<{ cancelled: boolean }>>;
  decide(
    id: string,
    refId: string,
    decision: "approve" | "reject",
  ): Promise<Reply<{ proposal: AskProposal }>>;
}

/** Rendering cap: a runaway frame must not hang the tab. */
export const MAX_FRAME_BUFFER = 1_000_000;

/** Parses an SSE body; frames that are not valid conversation events are dropped. */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: ConversationEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    if (buffer.length > MAX_FRAME_BUFFER) {
      await reader.cancel();
      throw new Error("SSE_FRAME_TOO_LARGE");
    }
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const parsed = conversationEventSchema.safeParse(JSON.parse(data));
        if (parsed.success) onEvent(parsed.data);
      } catch {
        // malformed frame (incl. the runtime's `event: error` with {}): ignored, never rendered
      }
    }
  }
}

export function httpCognitiveTransport(doFetch: typeof fetch = fetch): CognitiveTransport {
  const base = "/api/cognitive/conversations";
  const conv = (id: string) => `${base}/${encodeURIComponent(id)}`;
  const get = (url: string) => doFetch(url, { credentials: "same-origin", cache: "no-store" });
  const post = (url: string, body?: unknown) =>
    doFetch(url, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    list: async () => parse(await get(base), listSchema),
    create: async (title) =>
      parse(
        await post(base, title ? { title } : {}),
        z.object({ conversation: conversationSchema }),
      ),
    resume: async (id) => parse(await get(conv(id)), stateSchema),
    submit: async (id, input) => parse(await post(`${conv(id)}/turns`, input), turnResultSchema),
    cancel: async (id, turnId) =>
      parse(
        await post(`${conv(id)}/turns/${encodeURIComponent(turnId)}/cancel`),
        z.object({ cancelled: z.boolean() }),
      ),
    decide: async (id, refId, decision) =>
      parse(
        await post(`${conv(id)}/proposals/${encodeURIComponent(refId)}/decision`, { decision }),
        z.object({ proposal: proposalSchema }),
      ),
    async events(id, after, onEvent, signal) {
      try {
        const res = await doFetch(`${conv(id)}/events?after=${after}`, {
          credentials: "same-origin",
          headers: { accept: "text/event-stream" },
          signal,
        });
        if (res.status === 404) {
          const r = await parse(res, z.never());
          return r.kind === "not_connected" ? "not_connected" : "not_found";
        }
        if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("text/event-stream"))
          return "link_lost";
        await readEventStream(res.body, onEvent);
        return "closed";
      } catch {
        return "link_lost";
      }
    },
  };
}

// ------------------------------------------------------------------ view state

export type SubmitPhase =
  | "submitting"
  | "accepted"
  | "replayed"
  | "processing"
  | "failed"
  | "cancelled"
  | "busy"
  | "unknown"
  | "rejected";

export interface AskState {
  /** Availability of the runtime itself. */
  link: "loading" | "ready" | "not_connected" | "unavailable" | "error";
  engine: string | null;
  conversations: AskConversation[];
  current: ConversationState | null;
  /** Highest event seq applied; the stream resumes after it. */
  cursor: number;
  /** Latest lifecycle event per in-flight turn (received → processing → context.assembled). */
  progress: Record<string, ConversationEvent["type"]>;
  /** The owner's submission, keyed by its idempotency key (resent verbatim to reconcile). */
  pending: { text: string; idempotencyKey: string; phase: SubmitPhase; detail?: string } | null;
  message: string | null;
}

export const initialAsk: AskState = {
  link: "loading",
  engine: null,
  conversations: [],
  current: null,
  cursor: 0,
  progress: {},
  pending: null,
  message: null,
};

export type AskAction =
  | { type: "listed"; conversations: AskConversation[]; engine: string }
  | { type: "resumed"; state: ConversationState }
  /** "New conversation": nothing of the previous one stays on screen. */
  | { type: "cleared" }
  | { type: "event"; event: ConversationEvent }
  | { type: "submit"; text: string; idempotencyKey: string }
  | { type: "submitted"; phase: SubmitPhase; detail?: string }
  | { type: "link"; link: AskState["link"]; message?: string }
  | { type: "message"; message: string | null };

const SETTLED = new Set<ConversationEvent["type"]>([
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "proposal.created",
  "proposal.decided",
  "proposal.submitted",
]);

/** Events after which the durable state must be re-read (the log signals, the state is truth). */
export const needsRefresh = (e: ConversationEvent) => SETTLED.has(e.type);

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case "listed":
      return {
        ...state,
        link: "ready",
        conversations: action.conversations,
        engine: action.engine,
      };
    case "resumed": {
      // Only turns that are still open keep a progress entry.
      const open = new Set(
        action.state.turns
          .filter((t) => t.status === "received" || t.status === "processing")
          .map((t) => t.id),
      );
      const progress = Object.fromEntries(
        Object.entries(state.progress).filter(([id]) => open.has(id)),
      );
      const same = state.current?.conversation.id === action.state.conversation.id;
      return { ...state, current: action.state, progress, cursor: same ? state.cursor : 0 };
    }
    case "cleared":
      return { ...state, current: null, cursor: 0, progress: {}, pending: null };
    case "event": {
      const e = action.event;
      if (!state.current || e.conversationId !== state.current.conversation.id) return state;
      if (e.seq <= state.cursor) return state; // replay after reconnect
      const progress =
        e.turnId && !SETTLED.has(e.type) && e.type !== "memory.written"
          ? { ...state.progress, [e.turnId]: e.type }
          : state.progress;
      return { ...state, cursor: e.seq, progress };
    }
    case "submit":
      return {
        ...state,
        pending: { text: action.text, idempotencyKey: action.idempotencyKey, phase: "submitting" },
        message: null,
      };
    case "submitted":
      return state.pending
        ? { ...state, pending: { ...state.pending, phase: action.phase, detail: action.detail } }
        : state;
    case "link":
      return { ...state, link: action.link, message: action.message ?? state.message };
    case "message":
      return { ...state, message: action.message };
  }
}

/**
 * Maps a submit reply. After the POST left the device, only a typed 4xx proves nothing was
 * created; a 5xx or unreadable reply is UNKNOWN and is resolved by resending the same key.
 */
export function submitPhase(
  reply: Reply<TurnResult>,
): { phase: SubmitPhase; detail?: string } | "not_connected" {
  if (reply.kind === "not_connected") return "not_connected";
  if (reply.kind === "ok") {
    // The phase follows the stored turn, not the HTTP status: a 201/200 can carry a turn
    // that failed, was cancelled, or (on replay) is still in flight with no reply yet.
    const { turn, replayed } = reply.value;
    if (turn.status === "failed") return { phase: "failed", detail: failureCode(turn) };
    if (turn.status === "cancelled") return { phase: "cancelled" };
    if (turn.status === "received" || turn.status === "processing") return { phase: "processing" };
    return { phase: replayed ? "replayed" : "accepted" };
  }
  const text = `${reply.code}${reply.message ? `: ${reply.message}` : ""} (HTTP ${reply.status})`;
  if (reply.status >= 500 || !reply.typed) return { phase: "unknown", detail: text };
  if (reply.status === 409)
    return { phase: "busy", detail: "A turn is already in progress in this conversation." };
  return { phase: "rejected", detail: text };
}

export const turnText = (t: AskTurn) => t.content.parts.map((p) => p.text).join("\n");

/**
 * The runtime stores `Name: message` (provider/HTTP internals possible). The cockpit shows only
 * the leading code (e.g. `interrupted`, `cancelled_by_user`, `Error`), never the raw message.
 */
export function failureCode(t: Pick<AskTurn, "failureReason">): string | undefined {
  if (!t.failureReason) return undefined;
  const code = t.failureReason.split(":")[0]!.trim();
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,40}$/.test(code) ? code : "failed";
}

export const ASK_EXAMPLES = [
  "Pourquoi CORE3 est bloqué ?",
  "Quels providers sont dégradés ?",
  "Quelle amélioration d'ICOS apporte le plus d'autonomie pour le moins de risque ?",
];

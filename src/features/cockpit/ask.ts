import { z } from "zod";

/**
 * ASK ICOS — frontend boundary for the Cognitive Runtime (lane C).
 *
 * The browser holds the owner's text and renders what the runtime streams
 * back. It never interprets intent, picks actions, approves anything or
 * produces an answer itself. Until the runtime exposes the endpoints below,
 * every turn ends NOT_CONNECTED. Proposed contract (BR-28):
 *
 *   POST /api/ask/turns                         { conversationId?, text } → SSE of AskEvent
 *   GET  /api/ask/turns/:turnId/events?afterSeq  → SSE resume (SSE id = seq)
 *   POST /api/ask/turns/:turnId/cancel           stop and discard the turn
 *   POST /api/ask/turns/:turnId/interrupt        stop generating, keep what was said
 */
export const ASK_MAX_LENGTH = 2000;

const base = { turnId: z.string().min(1), seq: z.number().int().nonnegative() };

export const askEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn.started"), conversationId: z.string().min(1), ...base }),
  z.object({ type: z.literal("text.delta"), text: z.string(), ...base }),
  z.object({
    type: z.literal("tool.call"),
    toolCallId: z.string(),
    name: z.string(),
    status: z.enum(["started", "succeeded", "failed"]),
    summary: z.string().optional(),
    ...base,
  }),
  z.object({ type: z.literal("mission.created"), missionId: z.string(), title: z.string(), ...base }),
  /** The runtime asks; the decision goes through the governed approval path, not this chat. */
  z.object({
    type: z.literal("approval.requested"),
    approvalId: z.string(),
    summary: z.string(),
    risk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    ...base,
  }),
  z.object({
    type: z.literal("context.used"),
    memory: z.array(z.object({ id: z.string(), label: z.string() })),
    contextTokens: z.number().int().nonnegative().optional(),
    ...base,
  }),
  z.object({ type: z.literal("turn.completed"), ...base }),
  z.object({ type: z.literal("turn.interrupted"), ...base }),
  z.object({ type: z.literal("turn.cancelled"), ...base }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    ...base,
  }),
]);
export type AskEvent = z.infer<typeof askEventSchema>;

export type AskStatus =
  | "idle"
  | "sending"
  | "streaming"
  | "completed"
  | "interrupted"
  | "cancelled"
  | "error"
  | "reconnecting"
  | "not_connected";

export interface AskState {
  status: AskStatus;
  conversationId: string | null;
  turnId: string | null;
  /** Highest seq applied: resume asks for events after it; replays below it are ignored. */
  lastSeq: number;
  text: string;
  tools: { id: string; name: string; status: "started" | "succeeded" | "failed"; summary?: string }[];
  missions: { id: string; title: string }[];
  approvals: { id: string; summary: string; risk: string }[];
  context: { memory: { id: string; label: string }[]; contextTokens?: number } | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

export const initialAsk = (conversationId: string | null = null): AskState => ({
  status: "idle",
  conversationId,
  turnId: null,
  lastSeq: -1,
  text: "",
  tools: [],
  missions: [],
  approvals: [],
  context: null,
  error: null,
});

export type AskAction =
  | { type: "send" }
  | { type: "event"; event: AskEvent }
  | { type: "not_connected" }
  | { type: "link_lost" }
  | { type: "reconnecting" };

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case "send":
      return { ...initialAsk(state.conversationId), status: "sending" };
    case "not_connected":
      return { ...state, status: "not_connected" };
    case "reconnecting":
      return { ...state, status: "reconnecting" };
    case "link_lost":
      // What arrived stays on screen; the turn outcome is unknown until resumed.
      return {
        ...state,
        status: "error",
        error: { code: "LINK_LOST", message: "Connection to ICOS lost mid-turn.", retryable: true },
      };
    case "event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: AskState, e: AskEvent): AskState {
  if (e.type !== "turn.started" && state.turnId !== null && e.turnId !== state.turnId) return state;
  if (e.seq <= state.lastSeq) return state; // replay after resume
  const s = { ...state, lastSeq: e.seq };
  switch (e.type) {
    case "turn.started":
      return { ...s, status: "streaming", turnId: e.turnId, conversationId: e.conversationId };
    case "text.delta":
      return { ...s, status: "streaming", text: s.text + e.text };
    case "tool.call": {
      const tools = s.tools.filter((t) => t.id !== e.toolCallId);
      return { ...s, tools: [...tools, { id: e.toolCallId, name: e.name, status: e.status, summary: e.summary }] };
    }
    case "mission.created":
      return { ...s, missions: [...s.missions, { id: e.missionId, title: e.title }] };
    case "approval.requested":
      return { ...s, approvals: [...s.approvals, { id: e.approvalId, summary: e.summary, risk: e.risk }] };
    case "context.used":
      return { ...s, context: { memory: e.memory, contextTokens: e.contextTokens } };
    case "turn.completed":
      return { ...s, status: "completed" };
    case "turn.interrupted":
      return { ...s, status: "interrupted" };
    case "turn.cancelled":
      return { ...s, status: "cancelled" };
    case "error":
      return { ...s, status: "error", error: { code: e.code, message: e.message, retryable: e.retryable } };
  }
}

// ------------------------------------------------------------------ transport

export type StreamOutcome = "ended" | "not_connected" | "link_lost";

export interface AskTransport {
  start(
    input: { conversationId: string | null; text: string },
    onEvent: (e: AskEvent) => void,
    signal?: AbortSignal,
  ): Promise<StreamOutcome>;
  resume(turnId: string, afterSeq: number, onEvent: (e: AskEvent) => void, signal?: AbortSignal): Promise<StreamOutcome>;
  cancel(turnId: string): Promise<"ok" | "not_connected" | "failed">;
  interrupt(turnId: string): Promise<"ok" | "not_connected" | "failed">;
}

/** Parses an SSE body; each `data:` block must be a valid AskEvent or it is dropped. */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: AskEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
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
        const parsed = askEventSchema.safeParse(JSON.parse(data));
        if (parsed.success) onEvent(parsed.data);
      } catch {
        // malformed frame: ignored, never rendered
      }
    }
  }
}

export function httpAskTransport(doFetch: typeof fetch = fetch): AskTransport {
  const stream = async (res: Response, onEvent: (e: AskEvent) => void): Promise<StreamOutcome> => {
    if (res.status === 404) return "not_connected";
    if (!res.ok || !res.body || !res.headers.get("content-type")?.includes("text/event-stream"))
      return "link_lost";
    try {
      await readEventStream(res.body, onEvent);
      return "ended";
    } catch {
      return "link_lost";
    }
  };
  const post = async (path: string, body?: unknown, signal?: AbortSignal) =>
    doFetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  const control = async (path: string) => {
    try {
      const res = await post(path);
      return res.status === 404 ? "not_connected" : res.ok ? "ok" : "failed";
    } catch {
      return "failed";
    }
  };
  return {
    async start(input, onEvent, signal) {
      try {
        return await stream(await post("/api/ask/turns", input, signal), onEvent);
      } catch {
        return "link_lost";
      }
    },
    async resume(turnId, afterSeq, onEvent, signal) {
      try {
        const res = await doFetch(
          `/api/ask/turns/${encodeURIComponent(turnId)}/events?afterSeq=${afterSeq}`,
          { credentials: "same-origin", headers: { accept: "text/event-stream" }, signal },
        );
        return await stream(res, onEvent);
      } catch {
        return "link_lost";
      }
    },
    cancel: (turnId) => control(`/api/ask/turns/${encodeURIComponent(turnId)}/cancel`),
    interrupt: (turnId) => control(`/api/ask/turns/${encodeURIComponent(turnId)}/interrupt`),
  };
}

export const ASK_EXAMPLES = [
  "Pourquoi CORE3 est bloqué ?",
  "Quels providers sont dégradés ?",
  "Quelle amélioration d'ICOS apporte le plus d'autonomie pour le moins de risque ?",
];

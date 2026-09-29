"use client";

import { Brain, CircleStop, Hand, RefreshCw, Send } from "lucide-react";
import Link from "next/link";
import { useReducer, useRef, useState } from "react";

import {
  ASK_EXAMPLES,
  ASK_MAX_LENGTH,
  askReducer,
  httpAskTransport,
  initialAsk,
  type AskEvent,
  type AskState,
  type StreamOutcome,
} from "@/features/cockpit/ask";

const transport = httpAskTransport();
const TERMINAL = new Set<AskEvent["type"]>([
  "turn.completed",
  "turn.interrupted",
  "turn.cancelled",
  "error",
]);

const STATUS_TEXT: Record<AskState["status"], string> = {
  idle: "",
  sending: "Sending to ICOS…",
  streaming: "ICOS is answering",
  completed: "Turn completed",
  interrupted: "Interrupted — partial answer kept",
  cancelled: "Cancelled",
  error: "Error",
  reconnecting: "Reconnecting…",
  not_connected: "NOT CONNECTED — nothing was sent to a model",
};

/**
 * Chat surface for the Cognitive Runtime. Renders only what the runtime
 * streams; with no runtime deployed it says so and shows no answer.
 */
export function AskIcos() {
  const [text, setText] = useState("");
  const [state, dispatch] = useReducer(askReducer, initialAsk());
  const abort = useRef<AbortController | null>(null);

  /** Runs one stream; a stream that ends without a terminal event did not finish the turn. */
  const run = async (
    open: (onEvent: (event: AskEvent) => void, signal: AbortSignal) => Promise<StreamOutcome>,
  ) => {
    abort.current?.abort();
    abort.current = new AbortController();
    let terminal = false;
    const outcome = await open((event) => {
      if (TERMINAL.has(event.type)) terminal = true;
      dispatch({ type: "event", event });
    }, abort.current.signal);
    if (outcome === "not_connected") dispatch({ type: "not_connected" });
    else if (!terminal) dispatch({ type: "link_lost" });
  };

  const send = async () => {
    const body = text.trim();
    if (!body || body.length > ASK_MAX_LENGTH) return;
    dispatch({ type: "send" });
    await run((onEvent, signal) =>
      transport.start({ conversationId: state.conversationId, text: body }, onEvent, signal),
    );
  };

  const resume = async () => {
    const { turnId, lastSeq } = state;
    if (!turnId) return;
    dispatch({ type: "reconnecting" });
    await run((onEvent, signal) => transport.resume(turnId, lastSeq, onEvent, signal));
  };

  // Stopping is a server decision: the UI only asks and waits for turn.cancelled / turn.interrupted.
  const stop = async (kind: "cancel" | "interrupt") => {
    const { turnId } = state;
    if (!turnId) return;
    const r = await transport[kind](turnId);
    if (r === "not_connected") dispatch({ type: "not_connected" });
  };

  const busy = ["sending", "streaming", "reconnecting"].includes(state.status);

  return (
    <div className="cx-ask">
      <form
        className="cx-ask"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="cx-field">
          Ask or instruct ICOS
          <textarea
            value={text}
            maxLength={ASK_MAX_LENGTH}
            onChange={(e) => setText(e.target.value)}
            placeholder="Pourquoi CORE3 est bloqué ?"
            disabled={busy}
          />
        </label>
        <div className="cx-examples" aria-label="Examples">
          {ASK_EXAMPLES.map((ex) => (
            <button type="button" key={ex} onClick={() => setText(ex)} disabled={busy}>
              {ex}
            </button>
          ))}
        </div>
        <div className="cx-actions">
          <button
            type="submit"
            className="cx-btn cx-btn--primary"
            disabled={busy || text.trim().length === 0}
          >
            <Send aria-hidden size={14} /> Send to ICOS
          </button>
          {state.status === "streaming" && (
            <>
              <button type="button" className="cx-btn" onClick={() => void stop("interrupt")}>
                <Hand aria-hidden size={14} /> Interrupt
              </button>
              <button type="button" className="cx-btn" onClick={() => void stop("cancel")}>
                <CircleStop aria-hidden size={14} /> Cancel
              </button>
            </>
          )}
          {state.status === "error" && state.error?.retryable && state.turnId && (
            <button type="button" className="cx-btn" onClick={() => void resume()}>
              <RefreshCw aria-hidden size={14} /> Resume
            </button>
          )}
        </div>
      </form>

      {state.status !== "idle" && (
        <p className="cx-outcome" data-status={state.status} role="status" aria-live="polite">
          <strong>{STATUS_TEXT[state.status]}</strong>
          {state.status === "not_connected" && (
            <span>
              The Cognitive Runtime is not deployed with this build (BR-28). Your text stayed on
              this device; no answer is shown because none was produced.
            </span>
          )}
          {state.error && (
            <span>
              {state.error.code}: {state.error.message}
            </span>
          )}
        </p>
      )}

      {state.context && (
        <p className="cx-dim" aria-label="Context used">
          <Brain aria-hidden size={12} /> Context: {state.context.memory.length} memory item(s)
          {state.context.contextTokens !== undefined && ` · ${state.context.contextTokens} tokens`}
          {state.context.memory.length > 0 &&
            ` — ${state.context.memory.map((m) => m.label).join(", ")}`}
        </p>
      )}

      {state.text && (
        <div className="cx-answer" aria-live="polite">
          {state.text}
        </div>
      )}

      {state.tools.length > 0 && (
        <ul className="cx-list" aria-label="Tool activity">
          {state.tools.map((t) => (
            <li key={t.id}>
              <code>{t.name}</code> · {t.status}
              {t.summary && <span className="cx-dim"> — {t.summary}</span>}
            </li>
          ))}
        </ul>
      )}

      {state.missions.map((m) => (
        <p key={m.id} className="cx-outcome" data-status="SUCCEEDED">
          <strong>Mission created by ICOS</strong>
          <Link href={`/cockpit/missions/${m.id}`}>{m.title}</Link>
        </p>
      ))}

      {state.approvals.map((a) => (
        <p key={a.id} className="cx-outcome" data-status="AUTH_REQUIRED">
          <strong>
            Approval requested ·{" "}
            <span className="cx-risk" data-risk={a.risk}>
              {a.risk}
            </span>
          </strong>
          <span>{a.summary} — decide it in the governed approvals flow, not in this chat.</span>
        </p>
      ))}
    </div>
  );
}

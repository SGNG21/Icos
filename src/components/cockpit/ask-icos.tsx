"use client";

import { Brain, CircleStop, RefreshCw, Send } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import {
  ASK_EXAMPLES,
  ASK_MAX_LENGTH,
  ENGINE_NOT_CONNECTED,
  askReducer,
  httpCognitiveTransport,
  initialAsk,
  needsRefresh,
  submitPhase,
  turnText,
  type AskProposal,
  type AskState,
  type Reply,
  type SubmitPhase,
  type TurnResult,
} from "@/features/cockpit/ask";

const transport = httpCognitiveTransport();

const PHASE_TEXT: Record<SubmitPhase, string> = {
  submitting: "Sent — ICOS is working on this turn",
  accepted: "Turn settled",
  replayed: "Stored result of the same submission (replayed, not re-run)",
  busy: "Rejected — a turn is already in progress",
  unknown: "UNKNOWN — the answer did not come back",
  rejected: "Rejected — nothing was created",
};

const PROGRESS_TEXT: Record<string, string> = {
  "turn.received": "received",
  "turn.processing": "processing",
  "context.assembled": "context assembled — waiting for the model",
};

const LINK_TEXT: Record<Exclude<AskState["link"], "ready">, string> = {
  loading: "Reading conversations…",
  not_connected: "NOT CONNECTED — the Cognitive Runtime API is not deployed with this build.",
  unavailable:
    "UNAVAILABLE — the Cognitive Runtime answered but cannot serve (PostgreSQL required).",
  error: "ERROR — the Cognitive Runtime did not answer as expected.",
};

type Failure = Exclude<Reply<unknown>, { kind: "ok" }>;
const describe = (r: Failure) =>
  r.kind === "not_connected" ? "not connected" : `${r.code} (HTTP ${r.status})`;

/**
 * Ask ICOS surface over the Cognitive Runtime (decision 0056). It renders the durable
 * conversation and its event log; every answer shown is a stored assistant turn.
 */
export function AskIcos() {
  const [state, dispatch] = useReducer(askReducer, initialAsk);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [ack, setAck] = useState<Record<string, boolean>>({});
  const cursor = useRef(0);
  useEffect(() => {
    cursor.current = state.cursor;
  }, [state.cursor]);

  const failLink = useCallback((r: Failure) => {
    if (r.kind === "not_connected") dispatch({ type: "link", link: "not_connected" });
    else if (r.status === 503) dispatch({ type: "link", link: "unavailable" });
    else dispatch({ type: "message", message: `Cognitive Runtime: ${describe(r)}` });
  }, []);

  const refresh = useCallback(
    async (id: string) => {
      try {
        const r = await transport.resume(id);
        if (r.kind === "ok") dispatch({ type: "resumed", state: r.value });
        else failLink(r);
      } catch {
        dispatch({ type: "message", message: "Could not re-read the conversation." });
      }
    },
    [failLink],
  );

  // Conversations + current engine label; the most recent conversation is resumed.
  useEffect(() => {
    let live = true;
    transport
      .list()
      .then((r) => {
        if (!live) return;
        if (r.kind !== "ok") return failLink(r);
        dispatch({ type: "listed", conversations: r.value.conversations, engine: r.value.engine });
        const latest = [...r.value.conversations].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        )[0];
        if (latest) setSelected(latest.id);
      })
      .catch(() => live && dispatch({ type: "link", link: "error" }));
    return () => {
      live = false;
    };
  }, [failLink]);

  // Resume + durable event stream (the server closes every ~25 s: reconnect after the cursor).
  useEffect(() => {
    if (!selected) return;
    const ac = new AbortController();
    void refresh(selected);
    void (async () => {
      let delay = 1_000;
      while (!ac.signal.aborted) {
        const out = await transport.events(
          selected,
          cursor.current,
          (event) => {
            dispatch({ type: "event", event });
            if (needsRefresh(event)) void refresh(selected);
          },
          ac.signal,
        );
        if (ac.signal.aborted) return;
        if (out === "closed") {
          delay = 1_000;
          continue;
        }
        if (out === "not_connected") return dispatch({ type: "link", link: "not_connected" });
        if (out === "not_found")
          return dispatch({ type: "message", message: "This conversation is not available." });
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    })();
    return () => ac.abort();
  }, [selected, refresh]);

  const send = async (resend = false) => {
    const pending = state.pending;
    const body = resend && pending ? pending.text : text.trim();
    if (!body || body.length > ASK_MAX_LENGTH) return;
    let id = selected;
    if (!id) {
      const c = await transport.create().catch(() => null);
      if (!c) return dispatch({ type: "message", message: "Could not open a conversation." });
      if (c.kind !== "ok") return failLink(c);
      id = c.value.conversation.id;
      setSelected(id);
    }
    let key: string;
    try {
      key = resend && pending ? pending.idempotencyKey : crypto.randomUUID();
    } catch {
      return dispatch({ type: "message", message: "Not a secure context; nothing was sent." });
    }
    dispatch({ type: "submit", text: body, idempotencyKey: key });
    let reply: Reply<TurnResult>;
    try {
      reply = await transport.submit(id, { text: body, idempotencyKey: key });
    } catch {
      reply = { kind: "error", status: 0, code: "network", message: "", typed: false };
    }
    const p = submitPhase(reply);
    if (p === "not_connected") return dispatch({ type: "link", link: "not_connected" });
    dispatch({ type: "submitted", ...p });
    if (p.phase === "accepted" || p.phase === "replayed") setText("");
    void refresh(id);
  };

  const cancel = async (turnId: string) => {
    if (!selected) return;
    const r = await transport.cancel(selected, turnId).catch(() => null);
    if (!r) return dispatch({ type: "message", message: "Cancel request did not reach ICOS." });
    if (r.kind !== "ok") dispatch({ type: "message", message: `Cancel refused: ${describe(r)}` });
    void refresh(selected);
  };

  const decide = async (p: AskProposal, decision: "approve" | "reject") => {
    if (!selected) return;
    const r = await transport.decide(selected, p.id, decision).catch(() => null);
    if (!r) return dispatch({ type: "message", message: "The decision did not reach ICOS." });
    if (r.kind !== "ok") dispatch({ type: "message", message: `Decision refused: ${describe(r)}` });
    void refresh(selected);
  };

  const current = state.current;
  const open = current?.turns.find(
    (t) => t.role === "user" && (t.status === "received" || t.status === "processing"),
  );
  const busy = state.pending?.phase === "submitting" || Boolean(open);
  const ready = state.link === "ready";

  return (
    <div className="cx-ask">
      {state.link !== "ready" && (
        <p
          className="cx-outcome"
          data-status={state.link === "loading" ? "REQUESTED" : "NOT_CONNECTED"}
          role="status"
        >
          <strong>{LINK_TEXT[state.link]}</strong>
          {state.link === "not_connected" && (
            <span>Nothing was sent to a model. No answer is shown because none exists.</span>
          )}
        </p>
      )}

      {ready && state.engine === ENGINE_NOT_CONNECTED && (
        <p className="cx-outcome" data-status="NOT_CONNECTED" role="status">
          <strong>COGNITIVE ENGINE: NOT CONNECTED</strong>
          <span>
            The runtime stores your turns, but no model is configured: new replies are the
            runtime&apos;s not-connected notice, not an analysis by ICOS.
          </span>
        </p>
      )}

      {ready && (
        <label className="cx-field">
          Conversation
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value || null)}
            disabled={busy}
          >
            <option value="">New conversation</option>
            {state.conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title ?? c.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      )}

      {current && current.recoveredTurnIds.length > 0 && (
        <p className="cx-dim">
          {current.recoveredTurnIds.length} turn(s) interrupted by a restart were closed as failed
          (never silently re-run).
        </p>
      )}

      {current && current.turns.length > 0 && (
        <ol className="cx-list" aria-label="Conversation">
          {current.turns.map((t) => (
            <li key={t.id} data-role={t.role}>
              <span className="cx-dim">
                {t.role === "user" ? "You" : "ICOS"} · {t.status}
                {t.outcome && ` · ${t.outcome}`}
                {state.progress[t.id] &&
                  ` · ${PROGRESS_TEXT[state.progress[t.id]] ?? state.progress[t.id]}`}
              </span>
              <div className={t.role === "assistant" ? "cx-answer" : undefined}>{turnText(t)}</div>
              {t.failureReason && <span className="cx-dim">Failure: {t.failureReason}</span>}
            </li>
          ))}
        </ol>
      )}

      {current?.proposals.map((p) => (
        <div
          key={p.id}
          className="cx-outcome"
          data-status={p.status === "awaiting_approval" ? "AUTH_REQUIRED" : "REQUESTED"}
        >
          <strong>
            {p.kind === "goal_proposal" ? "Goal proposal" : "Action request"} ·{" "}
            {p.status.replace("_", " ")}
          </strong>
          <span>{String(p.payload.title ?? p.payload.description ?? "")}</span>
          {p.status === "submitted" && p.externalId && (
            <span>
              Filed as pending goal <code>{p.externalId}</code>. Starting it stays an operator step:
              a conversation never starts workers.
            </span>
          )}
          {p.status === "not_connected" && (
            <span>Approved, but actions have no conversational backend yet (NOT CONNECTED).</span>
          )}
          {p.status === "awaiting_approval" && (
            <span className="cx-actions">
              <label className="cx-check">
                <input
                  type="checkbox"
                  checked={Boolean(ack[p.id])}
                  onChange={(e) => setAck({ ...ack, [p.id]: e.target.checked })}
                />
                I reviewed this proposal (the decision is authorized and recorded by ICOS)
              </label>
              <button
                type="button"
                className="cx-btn"
                disabled={!ack[p.id]}
                onClick={() => void decide(p, "approve")}
              >
                Approve
              </button>
              <button
                type="button"
                className="cx-btn cx-btn--ghost"
                disabled={!ack[p.id]}
                onClick={() => void decide(p, "reject")}
              >
                Reject
              </button>
            </span>
          )}
        </div>
      ))}

      {state.pending && (
        <p
          className="cx-outcome"
          data-status={state.pending.phase === "unknown" ? "UNKNOWN" : "REQUESTED"}
          role="status"
          aria-live="polite"
        >
          <strong>{PHASE_TEXT[state.pending.phase]}</strong>
          {state.pending.detail && <span>{state.pending.detail}</span>}
          {state.pending.phase === "unknown" && (
            <span>
              Checking again resends the same submission; ICOS returns the stored turn instead of
              running it twice.
            </span>
          )}
        </p>
      )}

      {state.message && (
        <p className="cx-dim" role="status">
          {state.message}
        </p>
      )}

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
            disabled={!ready || busy}
          />
        </label>
        <div className="cx-examples" aria-label="Examples">
          {ASK_EXAMPLES.map((ex) => (
            <button type="button" key={ex} onClick={() => setText(ex)} disabled={!ready || busy}>
              {ex}
            </button>
          ))}
        </div>
        <div className="cx-actions">
          <button
            type="submit"
            className="cx-btn cx-btn--primary"
            disabled={!ready || busy || text.trim().length === 0}
          >
            <Send aria-hidden size={14} /> Send to ICOS
          </button>
          {open && (
            <button type="button" className="cx-btn" onClick={() => void cancel(open.id)}>
              <CircleStop aria-hidden size={14} /> Cancel turn
            </button>
          )}
          {state.pending?.phase === "unknown" && (
            <button type="button" className="cx-btn" onClick={() => void send(true)}>
              <RefreshCw aria-hidden size={14} /> Check again
            </button>
          )}
        </div>
      </form>

      {current && (
        <p className="cx-dim" aria-label="Event log position">
          <Brain aria-hidden size={12} /> Durable event log at #{state.cursor} · engine{" "}
          <code>{state.engine ?? "UNKNOWN"}</code>
        </p>
      )}
    </div>
  );
}

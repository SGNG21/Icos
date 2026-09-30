"use client";

import {
  Ban,
  Lock,
  Pause,
  Play,
  Power,
  ShieldAlert,
  ShieldOff,
  type LucideIcon,
} from "lucide-react";
import { useId, useRef, useState } from "react";

import {
  COMMAND_LABEL,
  buildRequest,
  confirmationPhrase,
  dialogMode,
  executeCommand,
  httpControlTransport,
  loadVersion,
  needsReauth,
  proofUsable,
  reauthenticate,
  resultTrail,
  reconcileCommand,
  riskOf,
  type ControlCommandType,
  type ControlPhase,
  type ControlTarget,
  type Outcome,
} from "@/features/cockpit/commands";

const ICON: Record<ControlCommandType, LucideIcon> = {
  PAUSE_MISSION: Pause,
  RESUME_MISSION: Play,
  CANCEL_MISSION: Ban,
  DISABLE_WORKER: Power,
  ENABLE_WORKER: Play,
  ENTER_SAFE_MODE: ShieldAlert,
  EXIT_SAFE_MODE: ShieldOff,
};

const PHASE_TEXT: Record<ControlPhase, string> = {
  REQUESTED: "Reading current version from ICOS…",
  AUTH_REQUIRED: "Re-authentication required",
  AUTHORIZED: "Ready to send",
  EXECUTING: "Executing — waiting for ICOS",
  SUCCEEDED: "SUCCEEDED",
  REJECTED: "REJECTED — nothing changed",
  FAILED: "FAILED — nothing changed",
  UNKNOWN: "UNKNOWN EXECUTION STATE",
  NOT_CONNECTED: "NOT CONNECTED — nothing executed",
  UNAVAILABLE: "UNAVAILABLE — nothing executed",
};

const transport = httpControlTransport();

/**
 * One governed control (decision 0044). Reads the target version, collects
 * reason / re-auth / confirmation as the risk demands, sends ONE request and
 * renders the backend's typed answer. It never reports success it did not
 * receive and never resends except through the idempotent reconcile path.
 */
export function CommandButton({
  type,
  target,
  label,
  compact = false,
}: {
  type: ControlCommandType;
  target: ControlTarget;
  /** Human name of the target (display only; the id is what is sent). */
  label: string;
  compact?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const risk = riskOf(type);
  const reauth = needsReauth(type);
  const phrase = confirmationPhrase(type, target);
  const Icon = ICON[type];

  const [phase, setPhase] = useState<ControlPhase>("REQUESTED");
  const [version, setVersion] = useState<number | null>(null);
  const [key, setKey] = useState("");
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [proof, setProof] = useState<string | null>(null);
  const [proofExpiresAt, setProofExpiresAt] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [sent, setSent] = useState<ReturnType<typeof buildRequest> | null>(null);
  /** A sent command whose outcome is not known yet: its session must survive a close. */
  const pinned = sent !== null && (phase === "EXECUTING" || phase === "UNKNOWN");

  /** Dialog session: a response belonging to an older (closed/restarted) session is dropped. */
  const generation = useRef(0);
  const settle = (gen: number, o: Outcome) => {
    if (gen !== generation.current) return;
    setOutcome(o);
    setPhase(o.phase);
  };

  /** Drops everything sensitive or single-use (password, proof, typed phrase, request). */
  const reset = () => {
    generation.current += 1;
    setReason("");
    setAck(false);
    setTyped("");
    setPassword("");
    setProof(null);
    setProofExpiresAt(null);
    setOutcome(null);
    setSent(null);
    setVersion(null);
  };

  const start = async () => {
    reset();
    setPhase("REQUESTED");
    let fresh: string;
    try {
      fresh = crypto.randomUUID(); // unavailable outside a secure context
    } catch {
      setOutcome({ phase: "UNAVAILABLE", detail: "This page is not a secure context." });
      setPhase("UNAVAILABLE");
      return;
    }
    setKey(fresh);
    const gen = generation.current;
    const v = await loadVersion(transport, target);
    if (gen !== generation.current) return;
    if (!v.ok) return settle(gen, v.outcome);
    setVersion(v.version);
    setPhase(reauth ? "AUTH_REQUIRED" : "AUTHORIZED");
  };

  const open = () => {
    dialog.current?.showModal();
    if (!pinned) void start();
  };

  const doReauth = async () => {
    const pw = password;
    setPassword(""); // never kept past the request
    const gen = generation.current;
    const r = await reauthenticate(transport, pw);
    if (gen !== generation.current) return;
    if (r.ok) {
      setProof(r.proof);
      setProofExpiresAt(r.expiresAt);
      setOutcome(null);
      setPhase("AUTHORIZED");
    } else settle(gen, r.outcome);
  };

  const send = async () => {
    if (version === null) return;
    if (reauth && !proofUsable(proofExpiresAt)) {
      // Not sent yet, so the key is still unspent: ask for a fresh proof instead of burning it.
      setProof(null);
      setProofExpiresAt(null);
      setOutcome({
        phase: "AUTH_REQUIRED",
        detail: "Your re-authentication expired. Re-authenticate to send.",
      });
      setPhase("AUTH_REQUIRED");
      return;
    }
    const request = buildRequest({
      type,
      target,
      expectedVersion: version,
      reason: reason.trim(),
      idempotencyKey: key,
      reauthProof: proof ?? undefined,
      confirmation: typed,
    });
    setSent(request);
    setPhase("EXECUTING");
    const gen = generation.current;
    settle(gen, await executeCommand(transport, request));
  };

  const reconcile = async () => {
    if (!sent) return;
    setPhase("EXECUTING");
    const gen = generation.current;
    settle(gen, await reconcileCommand(transport, sent, outcome?.result));
  };

  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 500;
  const ready =
    phase === "AUTHORIZED" &&
    version !== null &&
    reasonOk &&
    (risk === "LOW" || ack) &&
    (!reauth || proof !== null) &&
    (risk !== "CRITICAL" || typed === phrase);
  const mode = dialogMode(phase, sent !== null, outcome);
  const editable = mode === "edit";

  return (
    <>
      <button
        type="button"
        className="cx-cmd"
        data-risk={risk}
        onClick={open}
        aria-haspopup="dialog"
      >
        <Icon aria-hidden size={14} />
        {compact ? <span className="cx-sr">{COMMAND_LABEL[type]}</span> : COMMAND_LABEL[type]}
      </button>

      <dialog
        ref={dialog}
        className="cx-dialog"
        aria-labelledby={`${id}-t`}
        onClose={() => {
          // An in-flight or UNKNOWN command keeps its session (the only reconcile
          // handle); reopening resumes it. Anything else is wiped.
          if (pinned) setPassword("");
          else reset();
        }}
      >
        <form method="dialog" onSubmit={(e) => e.preventDefault()}>
          <header>
            <span className="cx-risk" data-risk={risk}>
              {risk} RISK
            </span>
            <h2 id={`${id}-t`}>
              {COMMAND_LABEL[type]} · {label}
            </h2>
          </header>

          <dl className="cx-kv">
            <dt>Command</dt>
            <dd>
              <code>{type}</code>
            </dd>
            <dt>Target</dt>
            <dd>
              {target.kind} <code>{target.id}</code>
            </dd>
            <dt>Expected version</dt>
            <dd>
              {version ?? (
                <span className="cx-missing" data-kind="unknown">
                  UNKNOWN
                </span>
              )}
            </dd>
            <dt>Idempotency</dt>
            <dd>
              <code>{key || "—"}</code>
            </dd>
          </dl>

          <p className="cx-dim">
            ICOS decides: authorization → risk → re-auth → version → state → execution → audit.
          </p>

          {editable && (
            <>
              <label className="cx-field">
                <span>Reason (recorded in the audit log)</span>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                  autoComplete="off"
                  required
                />
              </label>
              {risk !== "LOW" && (
                <label className="cx-check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  I understand the effect of “{COMMAND_LABEL[type]}” on {label}.
                </label>
              )}
              {risk === "CRITICAL" && (
                <label className="cx-field">
                  <span>
                    Type <code>{phrase}</code> to confirm
                  </span>
                  <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              )}
              {reauth && proof === null && (
                <div className="cx-reauth">
                  <label className="cx-field">
                    <span>
                      <Lock aria-hidden size={12} /> Password (fresh authentication, single use, 5
                      min)
                    </span>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                  </label>
                  <button
                    type="button"
                    className="cx-btn"
                    onClick={doReauth}
                    disabled={password.length === 0}
                  >
                    Re-authenticate
                  </button>
                </div>
              )}
              {reauth && proof !== null && (
                <p className="cx-dim">Re-authenticated for this command.</p>
              )}
            </>
          )}

          <p className="cx-outcome" data-status={phase} role="status" aria-live="polite">
            <strong>{PHASE_TEXT[phase]}</strong>
            {outcome?.detail && <span>{outcome.detail}</span>}
            {outcome?.result &&
              resultTrail(outcome.result).map((line) => (
                <span key={line} className="cx-dim">
                  {line}
                </span>
              ))}
          </p>

          <footer>
            <button
              type="button"
              className="cx-btn cx-btn--ghost"
              onClick={() => dialog.current?.close()}
            >
              Close
            </button>
            {mode === "reconcile" && (
              <button type="button" className="cx-btn" onClick={reconcile}>
                Check server state
              </button>
            )}
            {mode === "restart" && (
              <button type="button" className="cx-btn" onClick={() => void start()}>
                Start over
              </button>
            )}
            {editable && (
              <button
                type="button"
                className="cx-btn cx-btn--primary"
                data-risk={risk}
                onClick={send}
                disabled={!ready}
              >
                Send command
              </button>
            )}
          </footer>
        </form>
      </dialog>
    </>
  );
}

/** A control the owner may expect but ICOS has no canonical command for. Never clickable. */
export function NotCommandable({ label, requirement }: { label: string; requirement: string }) {
  return (
    <span className="cx-cmd" data-risk="NONE" aria-disabled="true" title="No canonical command">
      {label}
      <span className="cx-missing" data-kind="not_connected">
        NO COMMAND <span className="cx-missing__req">{requirement}</span>
      </span>
    </span>
  );
}

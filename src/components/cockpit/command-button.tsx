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
  executeCommand,
  httpControlTransport,
  loadVersion,
  mayReconcile,
  needsReauth,
  reauthenticate,
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
  NOT_CONNECTED: "NOT CONNECTED — nothing was sent",
  UNAVAILABLE: "UNAVAILABLE — nothing was sent",
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
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [sent, setSent] = useState<ReturnType<typeof buildRequest> | null>(null);

  const start = async () => {
    setKey(crypto.randomUUID());
    setReason("");
    setAck(false);
    setTyped("");
    setPassword("");
    setProof(null);
    setOutcome(null);
    setSent(null);
    setVersion(null);
    setPhase("REQUESTED");
    const v = await loadVersion(transport, target);
    if (!v.ok) {
      setOutcome(v.outcome);
      setPhase(v.outcome.phase);
      return;
    }
    setVersion(v.version);
    setPhase(reauth ? "AUTH_REQUIRED" : "AUTHORIZED");
  };

  const open = () => {
    dialog.current?.showModal();
    void start();
  };

  const doReauth = async () => {
    const pw = password;
    setPassword(""); // never kept past the request
    const r = await reauthenticate(transport, pw);
    if (r.ok) {
      setProof(r.proof);
      setOutcome(null);
      setPhase("AUTHORIZED");
    } else {
      setOutcome(r.outcome);
      setPhase(r.outcome.phase);
    }
  };

  const send = async () => {
    if (version === null) return;
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
    const o = await executeCommand(transport, request);
    setOutcome(o);
    setPhase(o.phase);
  };

  const reconcile = async () => {
    if (!sent) return;
    setPhase("EXECUTING");
    const o = await reconcileCommand(transport, sent, outcome?.result);
    setOutcome(o);
    setPhase(o.phase);
  };

  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 500;
  const ready =
    phase === "AUTHORIZED" &&
    version !== null &&
    reasonOk &&
    (risk === "LOW" || ack) &&
    (!reauth || proof !== null) &&
    (risk !== "CRITICAL" || typed === phrase);
  const editable = phase === "AUTHORIZED" || phase === "AUTH_REQUIRED";
  const terminal = !editable && phase !== "REQUESTED" && phase !== "EXECUTING";

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

      <dialog ref={dialog} className="cx-dialog" aria-labelledby={`${id}-t`}>
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
            {outcome?.result?.replayed && (
              <span>Stored result of an earlier identical request.</span>
            )}
          </p>

          <footer>
            <button
              type="button"
              className="cx-btn cx-btn--ghost"
              onClick={() => dialog.current?.close()}
            >
              Close
            </button>
            {mayReconcile(outcome) && (
              <button type="button" className="cx-btn" onClick={reconcile}>
                Check server state
              </button>
            )}
            {terminal && !mayReconcile(outcome) && phase !== "SUCCEEDED" && (
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

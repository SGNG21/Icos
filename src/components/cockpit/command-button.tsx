"use client";

import { Lock, Pause, Play, RotateCcw, ShieldAlert, Snowflake, Square, ArrowUpDown, type LucideIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import {
  COMMAND_ACTIONS,
  canSubmit,
  confirmationPolicy,
  createCommand,
  mayResubmit,
  notWiredTransport,
  reconcileCommand,
  submitCommand,
  type CommandAction,
  type CommandOutcome,
  type ControlCommand,
} from "@/features/cockpit/commands";

const ICON: Partial<Record<CommandAction, LucideIcon>> = {
  "worker.pause": Pause,
  "mission.pause": Pause,
  "worker.resume": Play,
  "mission.resume": Play,
  "worker.stop": Square,
  "mission.stop": Square,
  "worker.retry": RotateCcw,
  "mission.change_priority": ArrowUpDown,
  "system.freeze_integrations": Snowflake,
  "system.lock_self_modification": Lock,
  "system.enter_safe_mode": ShieldAlert,
};

const OUTCOME_TEXT: Record<CommandOutcome["status"], string> = {
  accepted: "Accepted by ICOS",
  executed: "Executed by ICOS",
  rejected: "Rejected by ICOS policy",
  requires_reauth: "ICOS requires re-authentication",
  not_wired: "NOT YET WIRED — nothing was executed",
  unknown_execution_state: "UNKNOWN EXECUTION STATE",
  not_received: "Not received by ICOS",
};

/**
 * One governed control. It builds a ControlCommand, walks the owner through
 * the confirmation its risk class demands, and hands it to the command
 * transport. It never mutates ICOS state and never reports success it did not
 * receive from the backend.
 */
export function CommandButton({
  action,
  target,
  expectedStateVersion = null,
  compact = false,
}: {
  action: CommandAction;
  target: ControlCommand["target"];
  expectedStateVersion?: string | null;
  compact?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [command, setCommand] = useState<ControlCommand | null>(null);
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CommandOutcome | null>(null);
  const spec = COMMAND_ACTIONS[action];
  const policy = confirmationPolicy(spec.risk);
  const Icon = ICON[action] ?? ShieldAlert;

  const open = () => {
    setCommand(createCommand({ action, target, expectedStateVersion }));
    setAck(false);
    setTyped("");
    setOutcome(null);
    dialog.current?.showModal();
  };

  const send = async () => {
    if (!command) return;
    setBusy(true);
    setOutcome(await submitCommand(notWiredTransport, command));
    setBusy(false);
  };

  const reconcile = async () => {
    if (!command) return;
    setBusy(true);
    setOutcome(await reconcileCommand(notWiredTransport, command));
    setBusy(false);
  };

  // Step-up re-auth does not exist yet (BR-18): HIGH can never be submitted today.
  const ready = command ? canSubmit(command, { acknowledged: ack, typed, reauthenticated: false }) : false;
  const firstSend = outcome === null;

  return (
    <>
      <button type="button" className="cx-cmd" data-risk={spec.risk} onClick={open} aria-haspopup="dialog">
        <Icon aria-hidden size={14} />
        {!compact && spec.label}
        {compact && <span className="cx-sr">{spec.label}</span>}
      </button>

      <dialog ref={dialog} className="cx-dialog" aria-labelledby={`${id}-t`} onClose={() => setCommand(null)}>
        {command && (
          <form method="dialog" onSubmit={(e) => e.preventDefault()}>
            <header>
              <span className="cx-risk" data-risk={spec.risk}>
                {spec.risk} RISK
              </span>
              <h2 id={`${id}-t`}>
                {spec.label} · {target.label}
              </h2>
            </header>

            <dl className="cx-kv">
              <dt>Intent</dt>
              <dd>{command.intent}</dd>
              <dt>Target</dt>
              <dd>
                {target.kind} <code>{target.id}</code>
              </dd>
              <dt>Command</dt>
              <dd>
                <code>{command.commandId}</code>
              </dd>
              <dt>Idempotency</dt>
              <dd>
                <code>{command.idempotencyKey}</code>
              </dd>
              <dt>Expected version</dt>
              <dd>{command.expectedStateVersion ?? <span className="cx-missing" data-kind="not_available">NOT AVAILABLE <span className="cx-missing__req">BR-11</span></span>}</dd>
            </dl>

            <p className="cx-dim">
              Path: authorization → policy → risk → state validation → execution → audit. ICOS decides; this screen only asks.
            </p>

            {policy.kind === "explicit" || policy.kind === "typed_reauth" ? (
              <label className="cx-check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={!firstSend} />I
                understand the effect of “{spec.label}” on {target.label}.
              </label>
            ) : null}

            {policy.kind === "typed_reauth" && (
              <>
                <label className="cx-field">
                  <span>
                    Type <strong>{target.label}</strong> to confirm
                  </span>
                  <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" disabled={!firstSend} />
                </label>
                <button type="button" className="cx-btn" disabled>
                  <Lock aria-hidden size={14} /> Re-authenticate (passkey) — NOT YET WIRED · BR-18
                </button>
              </>
            )}

            {policy.kind === "escalation" && (
              <p className="cx-warn-text">CRITICAL actions never execute from the cockpit. Governance escalation is NOT YET WIRED (BR-10).</p>
            )}

            {outcome && (
              <p className="cx-outcome" data-status={outcome.status} role="status">
                <strong>{OUTCOME_TEXT[outcome.status]}</strong>
                {outcome.detail && <span>{outcome.detail}</span>}
              </p>
            )}

            <footer>
              <button type="button" className="cx-btn cx-btn--ghost" onClick={() => dialog.current?.close()}>
                Close
              </button>
              {outcome?.status === "unknown_execution_state" && (
                <button type="button" className="cx-btn" onClick={reconcile} disabled={busy}>
                  Check server state
                </button>
              )}
              {(firstSend || mayResubmit(outcome)) && policy.kind !== "escalation" && (
                <button type="button" className="cx-btn cx-btn--primary" data-risk={spec.risk} onClick={send} disabled={!ready || busy}>
                  {firstSend ? "Send command" : "Send again (same command)"}
                </button>
              )}
            </footer>
          </form>
        )}
      </dialog>
    </>
  );
}

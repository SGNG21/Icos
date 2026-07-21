"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import type { Agent, AgentAction, RiskLevel } from "@/core/contracts";

const riskLabel: Record<RiskLevel, string> = {
  read_only: "Lecture seule",
  reversible: "Réversible",
  sensitive: "Sensible",
};

/** Libellés de résultat — jamais « Action exécutée » : rien n'est exécuté. */
const executionLabel = {
  allowed: "Décision autorisée",
  awaiting_approval: "En attente d’approbation",
  refused: "Décision refusée",
} as const;

type ExecutionOutcome = keyof typeof executionLabel;

const DECIDER_LABEL = "Opérateur (simulé)";

export interface ApprovalsPanelProps {
  initialActions: readonly AgentAction[];
  agents: readonly Agent[];
}

interface DecisionOutcome {
  outcome: ExecutionOutcome;
}

export function ApprovalsPanel({ initialActions, agents }: ApprovalsPanelProps) {
  const router = useRouter();
  const [actions, setActions] = useState<readonly AgentAction[]>(initialActions);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ExecutionOutcome>>({});

  const agentName = (id: string): string => agents.find((a) => a.id === id)?.name ?? id;

  const reload = useCallback(async () => {
    const response = await fetch("/api/actions?approvalStatus=pending", { cache: "no-store" });
    if (response.ok) {
      const data = (await response.json()) as { actions: AgentAction[] };
      setActions(data.actions);
    }
    // Resynchronise aussi les Server Components (tâches, audit).
    router.refresh();
  }, [router]);

  const decide = useCallback(
    async (actionId: string, decision: "approved" | "rejected", motive?: string) => {
      setBusyId(actionId);
      setError(null);
      try {
        const response = await fetch(`/api/actions/${actionId}/decision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decidedByLabel: DECIDER_LABEL,
            decision,
            ...(motive ? { reason: motive } : {}),
          }),
        });

        const data = (await response.json()) as {
          execution?: DecisionOutcome;
          error?: { message: string };
        };
        const execution = data.execution;
        if (!response.ok || !execution) {
          setError(data.error?.message ?? "La décision a échoué.");
          return;
        }

        setResults((prev) => ({ ...prev, [actionId]: execution.outcome }));
        setRejectingId(null);
        setReason("");
        await reload();
      } catch {
        setError("Impossible de contacter l’API interne.");
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  return (
    <section className="panel approvals-panel" id="approvals">
      <div className="panel-heading compact">
        <div>
          <p className="eyebrow">Gouvernance</p>
          <h2>Approbations</h2>
        </div>
        <span className="badge">Simulation</span>
      </div>

      <p className="approvals-note">
        Décisions simulées et non persistantes. L’identité du décideur («&nbsp;{DECIDER_LABEL}
        &nbsp;») n’est pas authentifiée. Aucune action externe n’est exécutée.
      </p>

      {error ? (
        <p className="approvals-error" role="alert">
          {error}
        </p>
      ) : null}

      {actions.length === 0 ? (
        <p className="approvals-empty">Aucune action en attente d’approbation.</p>
      ) : (
        <ul className="approvals-list">
          {actions.map((action) => {
            const result = results[action.id];
            const busy = busyId === action.id;
            return (
              <li key={action.id} className="approval-item">
                <div className="approval-head">
                  <strong>{action.kind}</strong>
                  <span className={`risk-chip risk-${action.risk}`}>{riskLabel[action.risk]}</span>
                </div>
                <small className="approval-initiator">
                  Initiée par {agentName(action.initiatedByAgentId)}
                </small>

                {result ? (
                  <p className={`approval-result outcome-${result}`}>{executionLabel[result]}</p>
                ) : rejectingId === action.id ? (
                  <div className="approval-reject">
                    <label htmlFor={`reason-${action.id}`}>Motif du rejet (obligatoire)</label>
                    <textarea
                      id={`reason-${action.id}`}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      rows={2}
                    />
                    <div className="approval-actions">
                      <button
                        type="button"
                        disabled={busy || reason.trim().length === 0}
                        onClick={() => decide(action.id, "rejected", reason.trim())}
                      >
                        Confirmer le rejet
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => {
                          setRejectingId(null);
                          setReason("");
                        }}
                      >
                        Annuler
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="approval-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => decide(action.id, "approved")}
                    >
                      Approuver
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => {
                        setRejectingId(action.id);
                        setReason("");
                        setError(null);
                      }}
                    >
                      Rejeter
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

import { eq } from "drizzle-orm";

import type { AgentAction } from "@/core/contracts";
import type { Database } from "@/server/database/client";
import {
  classifyDbError,
  PersistenceUnavailableError,
  TransientConflictError,
  uniqueConstraintName,
} from "@/server/database/errors";
import { approvalToRow, auditToRow } from "@/server/database/mappers";
import { actions, approvals, auditEntries } from "@/server/database/schema";

import type { ActionDecisionUnitOfWork, CommitDecisionResult } from "./ports";

const TERMINAL: ReadonlySet<AgentAction["approvalStatus"]> = new Set(["approved", "rejected"]);

/**
 * Unité de travail transactionnelle PostgreSQL derrière le port existant.
 *
 * La transaction verrouille l'action (`SELECT … FOR UPDATE`) puis revérifie ses
 * invariants — existence, statut non terminal, absence d'approbation — même si
 * le use case les a déjà vérifiés. L'existence de l'agent initiateur et de la
 * tâche liée est garantie par les clés étrangères `ON DELETE RESTRICT`.
 *
 * Aucune logique HTTP, aucune dépendance aux Route Handlers. Les erreurs
 * d'infrastructure sont converties en erreurs typées (`TransientConflictError`,
 * `PersistenceUnavailableError`) ; les violations d'unicité concurrentes sont
 * mappées en `already_decided`.
 */
export class PostgresActionDecisionUnitOfWork implements ActionDecisionUnitOfWork {
  constructor(private readonly db: Database) {}

  async commitDecision(input: {
    approval: Parameters<ActionDecisionUnitOfWork["commitDecision"]>[0]["approval"];
    action: AgentAction;
    auditEntries: Parameters<ActionDecisionUnitOfWork["commitDecision"]>[0]["auditEntries"];
  }): Promise<CommitDecisionResult> {
    const { approval, action, auditEntries: entries } = input;

    try {
      return await this.db.transaction(async (tx) => {
        // 2. verrou de ligne sur l'action
        const locked = await tx
          .select()
          .from(actions)
          .where(eq(actions.id, action.id))
          .for("update")
          .limit(1);
        const row = locked[0];

        // 3. existence
        if (!row) {
          return {
            ok: false as const,
            reason: "action_not_found" as const,
            message: `action introuvable : ${action.id}`,
          };
        }

        // 4. statut non terminal
        if (TERMINAL.has(row.approvalStatus as AgentAction["approvalStatus"])) {
          return alreadyDecided(action.id);
        }

        // 5. aucune approbation définitive déjà présente
        const existing = await tx
          .select({ id: approvals.id })
          .from(approvals)
          .where(eq(approvals.actionId, action.id))
          .limit(1);
        if (existing[0]) {
          return alreadyDecided(action.id);
        }

        // 8-10. approbation, action, audit (l'UNIQUE(action_id) garde le concurrent)
        await tx.insert(approvals).values(approvalToRow(approval));
        await tx
          .update(actions)
          .set({ approvalStatus: action.approvalStatus, updatedAt: new Date() })
          .where(eq(actions.id, action.id));
        if (entries.length > 0) {
          await tx.insert(auditEntries).values(entries.map(auditToRow));
        }

        // 11-12. commit implicite + retour
        return { ok: true as const, approval, action };
      });
    } catch (error) {
      return this.mapError(error, action.id);
    }
  }

  private mapError(error: unknown, actionId: string): CommitDecisionResult {
    // Seule la violation de l'unicité action↔approbation signifie « déjà
    // décidée » (course concurrente gagnée par l'autre). Toute AUTRE violation
    // d'unicité (ex. collision de clé primaire) doit remonter : le rollback a
    // déjà eu lieu.
    if (uniqueConstraintName(error) === "approvals_action_id_unique") {
      return alreadyDecided(actionId);
    }
    switch (classifyDbError(error)) {
      case "transient":
        throw new TransientConflictError("décision concurrente");
      case "unavailable":
        throw new PersistenceUnavailableError("connexion base de données");
      default:
        throw error;
    }
  }
}

function alreadyDecided(actionId: string): CommitDecisionResult {
  return {
    ok: false,
    reason: "already_decided",
    message: `l'action ${actionId} a déjà reçu une décision définitive`,
  };
}

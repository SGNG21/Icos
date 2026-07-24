import { eq } from "drizzle-orm";

import type { AuditEntry, Capability, CapabilityStatus } from "@/core/contracts";
import type { AgentCapability } from "@/core/contracts";
import type { Database } from "@/server/database/client";
import {
  classifyDbError,
  PersistenceUnavailableError,
  TransientConflictError,
  uniqueConstraintName,
} from "@/server/database/errors";
import {
  auditToRow,
  capabilityToRow,
  agentCapabilityToRow,
  rowToCapability,
} from "@/server/database/mappers";
import { capabilities, agentCapabilities, auditEntries } from "@/server/database/schema";

import type { CapabilityUnitOfWork, CapabilityUowResult } from "./ports";

/**
 * Unité de travail transactionnelle PostgreSQL pour les opérations du
 * Capability Registry.
 *
 * Chaque méthode encapsule mutation + audit dans `db.transaction()` :
 * soit l'ensemble réussit, soit rien n'est appliqué (rollback automatique
 * sur erreur). Le verrouillage `FOR UPDATE` détecte les modifications
 * concurrentes sur les lignes `capabilities`.
 */
export class PostgresCapabilityUnitOfWork implements CapabilityUnitOfWork {
  constructor(private readonly db: Database) {}

  async createCapabilityWithAudit(input: {
    capability: Capability;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ capability: Capability }>> {
    try {
      return await this.db.transaction(async (tx) => {
        const row = capabilityToRow(input.capability);
        await tx.insert(capabilities).values(row);
        await tx.insert(auditEntries).values(auditToRow(input.auditEntry));
        return { ok: true as const, data: { capability: input.capability } };
      });
    } catch (error) {
      if (uniqueConstraintName(error) === "capabilities_key_unique") {
        return { ok: false, reason: "creation_failed", message: "key déjà utilisé" };
      }
      return this.mapError(error, "createCapability");
    }
  }

  async changeStatusWithAudit(input: {
    id: string;
    expectedStatus: CapabilityStatus;
    targetStatus: CapabilityStatus;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ capability: Capability }>> {
    try {
      return await this.db.transaction(async (tx) => {
        // 1. Verrouillage de la ligne
        const locked = await tx
          .select()
          .from(capabilities)
          .where(eq(capabilities.id, input.id))
          .for("update")
          .limit(1);

        if (locked.length === 0) {
          return { ok: false as const, reason: "not_found", message: "Capacité introuvable" };
        }

        // 2. Détection de modification concurrente
        if (locked[0].status !== input.expectedStatus) {
          return {
            ok: false as const,
            reason: "concurrent_modification",
            message: `Statut modifié de manière concurrente : attendu ${input.expectedStatus}, réel ${locked[0].status}`,
          };
        }

        // 3. Mise à jour
        const updated = await tx
          .update(capabilities)
          .set({ status: input.targetStatus, updatedAt: new Date() })
          .where(eq(capabilities.id, input.id))
          .returning();

        // 4. Audit
        await tx.insert(auditEntries).values(auditToRow(input.auditEntry));

        return { ok: true as const, data: { capability: rowToCapability(updated[0]) } };
      });
    } catch (error) {
      return this.mapError(error, "changeStatus");
    }
  }

  async grantCapabilityWithAudit(input: {
    agentCapability: AgentCapability;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ id: string }>> {
    try {
      return await this.db.transaction(async (tx) => {
        const row = agentCapabilityToRow(input.agentCapability);
        await tx.insert(agentCapabilities).values(row);
        await tx.insert(auditEntries).values(auditToRow(input.auditEntry));
        return { ok: true as const, data: { id: input.agentCapability.id } };
      });
    } catch (error) {
      if (uniqueConstraintName(error) === "agent_capabilities_agent_capability_unique") {
        return { ok: false, reason: "grant_failed", message: "Assignation déjà existante" };
      }
      return this.mapError(error, "grantCapability");
    }
  }

  async revokeCapabilityWithAudit(input: {
    id: string;
    auditEntry: AuditEntry;
  }): Promise<CapabilityUowResult<{ revoked: boolean }>> {
    try {
      return await this.db.transaction(async (tx) => {
        const result = await tx
          .delete(agentCapabilities)
          .where(eq(agentCapabilities.id, input.id))
          .returning({ id: agentCapabilities.id });

        if (result.length === 0) {
          return { ok: false as const, reason: "not_found", message: "Assignation introuvable" };
        }

        await tx.insert(auditEntries).values(auditToRow(input.auditEntry));
        return { ok: true as const, data: { revoked: true } };
      });
    } catch (error) {
      return this.mapError(error, "revokeCapability");
    }
  }

  private mapError<T>(error: unknown, _operation: string): CapabilityUowResult<T> {
    switch (classifyDbError(error)) {
      case "transient":
        throw new TransientConflictError(_operation);
      case "unavailable":
        throw new PersistenceUnavailableError("connexion base de données");
      default:
        throw error;
    }
  }
}

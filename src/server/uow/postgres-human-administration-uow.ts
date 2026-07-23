import { and, asc, eq } from "drizzle-orm";

import {
  highestRole,
  humanAgentLinkSchema,
  humanAgentRelationSchema,
  roleSchema,
  userStatusSchema,
  type HumanAgentLink,
} from "@/core/identity";
import { buildHumanAdministrationAudit } from "@/server/administration/audit";
import { session, user, userRoles } from "@/server/database/auth-schema";
import type { Database } from "@/server/database/client";
import {
  classifyDbError,
  PersistenceUnavailableError,
  TransientConflictError,
  uniqueConstraintName,
} from "@/server/database/errors";
import { auditToRow } from "@/server/database/mappers";
import { agents, auditEntries, humanAgentLinks } from "@/server/database/schema";
import type { AdminHumanUser } from "@/server/repositories/ports";

import type { HumanAdministrationResult, HumanAdministrationUnitOfWork } from "./ports";

type UserRow = typeof user.$inferSelect;
type HumanAgentLinkRow = typeof humanAgentLinks.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const targetNotFound = <T>(): HumanAdministrationResult<T> => ({
  ok: false,
  reason: "not_found",
  message: "utilisateur humain introuvable",
});

const lastOwner = <T>(): HumanAdministrationResult<T> => ({
  ok: false,
  reason: "last_owner",
  message: "le dernier owner actif doit être conservé",
});

function toAdminHumanUser(row: UserRow, roles: readonly string[]): AdminHumanUser {
  const parsedRoles = roles.map((role) => roleSchema.parse(role));
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: userStatusSchema.parse(row.status),
    role: highestRole(parsedRoles),
  };
}

function toHumanAgentLink(row: HumanAgentLinkRow): HumanAgentLink {
  return humanAgentLinkSchema.parse({
    id: row.id,
    humanUserId: row.humanUserId,
    agentId: row.agentId,
    relation: row.relation,
    createdAt: row.createdAt.toISOString(),
    createdByHumanUserId: row.createdByHumanUserId,
  });
}

async function lockActiveOwners(tx: Transaction): Promise<ReadonlySet<string>> {
  const rows = await tx
    .select({ id: user.id })
    .from(user)
    .innerJoin(userRoles, eq(userRoles.userId, user.id))
    .where(and(eq(user.status, "active"), eq(userRoles.role, "owner")))
    .orderBy(asc(user.id))
    .for("update");

  return new Set(rows.map(({ id }) => id));
}

async function lockTarget(
  tx: Transaction,
  targetUserId: string,
): Promise<{ row: UserRow; roles: string[] } | null> {
  const rows = await tx.select().from(user).where(eq(user.id, targetUserId)).for("update").limit(1);
  const row = rows[0];
  if (!row) return null;

  const roles = await tx
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, targetUserId));
  return { row, roles: roles.map(({ role }) => role) };
}

function throwMappedInfrastructure(error: unknown, operation: string): never {
  switch (classifyDbError(error)) {
    case "transient":
      throw new TransientConflictError(operation);
    case "unavailable":
      throw new PersistenceUnavailableError("connexion base de données");
    default:
      throw error;
  }
}

export class PostgresHumanAdministrationUnitOfWork implements HumanAdministrationUnitOfWork {
  constructor(private readonly db: Database) {}

  async finalizeHumanCreation(
    input: Parameters<HumanAdministrationUnitOfWork["finalizeHumanCreation"]>[0],
  ): ReturnType<HumanAdministrationUnitOfWork["finalizeHumanCreation"]> {
    try {
      return await this.db.transaction(async (tx) => {
        const target = await lockTarget(tx, input.targetUserId);
        if (target === null) return targetNotFound();

        await tx.insert(userRoles).values({
          userId: input.targetUserId,
          role: input.role,
          grantedAt: new Date(input.occurredAt),
        });
        await tx.insert(auditEntries).values(
          auditToRow(
            buildHumanAdministrationAudit({
              id: input.auditId,
              occurredAt: input.occurredAt,
              actorUserId: input.actorUserId,
              eventType: "human_user.created",
              targetUserId: input.targetUserId,
              role: input.role,
            }),
          ),
        );

        return {
          ok: true as const,
          value: toAdminHumanUser(target.row, [input.role]),
          changed: true,
        };
      });
    } catch (error) {
      throwMappedInfrastructure(error, "finalisation de création humaine");
    }
  }

  async replaceRole(
    input: Parameters<HumanAdministrationUnitOfWork["replaceRole"]>[0],
  ): ReturnType<HumanAdministrationUnitOfWork["replaceRole"]> {
    try {
      return await this.db.transaction(async (tx) => {
        const activeOwnerIds = await lockActiveOwners(tx);
        const target = await lockTarget(tx, input.targetUserId);
        if (target === null) return targetNotFound();

        const previousRole = highestRole(target.roles.map((role) => roleSchema.parse(role)));
        if (previousRole === null) return targetNotFound();

        const changed = previousRole !== input.nextRole;
        if (
          changed &&
          previousRole === "owner" &&
          target.row.status === "active" &&
          activeOwnerIds.size === 1 &&
          activeOwnerIds.has(input.targetUserId)
        ) {
          return lastOwner();
        }

        if (changed) {
          await tx.delete(userRoles).where(eq(userRoles.userId, input.targetUserId));
          await tx.insert(userRoles).values({
            userId: input.targetUserId,
            role: input.nextRole,
            grantedAt: new Date(input.occurredAt),
          });
          await tx.delete(session).where(eq(session.userId, input.targetUserId));
        }

        await tx.insert(auditEntries).values(
          auditToRow(
            buildHumanAdministrationAudit({
              id: input.auditId,
              occurredAt: input.occurredAt,
              actorUserId: input.actorUserId,
              eventType: "human_user.role_changed",
              targetUserId: input.targetUserId,
              previousRole,
              nextRole: input.nextRole,
              changed,
            }),
          ),
        );

        return {
          ok: true as const,
          value: toAdminHumanUser(target.row, changed ? [input.nextRole] : target.roles),
          changed,
        };
      });
    } catch (error) {
      throwMappedInfrastructure(error, "remplacement du rôle humain");
    }
  }

  async setStatus(
    input: Parameters<HumanAdministrationUnitOfWork["setStatus"]>[0],
  ): ReturnType<HumanAdministrationUnitOfWork["setStatus"]> {
    try {
      return await this.db.transaction(async (tx) => {
        const activeOwnerIds = await lockActiveOwners(tx);
        const target = await lockTarget(tx, input.targetUserId);
        if (target === null) return targetNotFound();

        const previousStatus = userStatusSchema.parse(target.row.status);
        const role = highestRole(target.roles.map((value) => roleSchema.parse(value)));
        if (role === null) return targetNotFound();

        const changed = previousStatus !== input.nextStatus;
        if (
          changed &&
          previousStatus === "active" &&
          input.nextStatus === "disabled" &&
          role === "owner" &&
          activeOwnerIds.size === 1 &&
          activeOwnerIds.has(input.targetUserId)
        ) {
          return lastOwner();
        }

        if (changed) {
          await tx
            .update(user)
            .set({ status: input.nextStatus })
            .where(eq(user.id, input.targetUserId));
          if (input.nextStatus === "disabled") {
            await tx.delete(session).where(eq(session.userId, input.targetUserId));
          }
        }

        await tx.insert(auditEntries).values(
          auditToRow(
            buildHumanAdministrationAudit({
              id: input.auditId,
              occurredAt: input.occurredAt,
              actorUserId: input.actorUserId,
              eventType:
                input.nextStatus === "active" ? "human_user.enabled" : "human_user.disabled",
              targetUserId: input.targetUserId,
              previousStatus,
              nextStatus: input.nextStatus,
              changed,
            }),
          ),
        );

        return {
          ok: true as const,
          value: toAdminHumanUser(
            { ...target.row, status: changed ? input.nextStatus : previousStatus },
            target.roles,
          ),
          changed,
        };
      });
    } catch (error) {
      throwMappedInfrastructure(error, "modification du statut humain");
    }
  }

  async createAgentLink(
    input: Parameters<HumanAdministrationUnitOfWork["createAgentLink"]>[0],
  ): ReturnType<HumanAdministrationUnitOfWork["createAgentLink"]> {
    try {
      return await this.db.transaction(async (tx) => {
        const target = await lockTarget(tx, input.targetUserId);
        if (target === null) return targetNotFound();

        const agentRows = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, input.agentId))
          .for("update")
          .limit(1);
        if (!agentRows[0]) return targetNotFound();

        const row: HumanAgentLinkRow = {
          id: input.id,
          humanUserId: input.targetUserId,
          agentId: input.agentId,
          relation: input.relation,
          createdAt: new Date(input.occurredAt),
          createdByHumanUserId: input.actorUserId,
        };
        await tx.insert(humanAgentLinks).values(row);
        await tx.insert(auditEntries).values(
          auditToRow(
            buildHumanAdministrationAudit({
              id: input.auditId,
              occurredAt: input.occurredAt,
              actorUserId: input.actorUserId,
              eventType: "human_agent_link.created",
              targetUserId: input.targetUserId,
              agentId: input.agentId,
              relation: input.relation,
            }),
          ),
        );

        return {
          ok: true as const,
          value: toHumanAgentLink(row),
          changed: true,
        };
      });
    } catch (error) {
      if (uniqueConstraintName(error) === "human_agent_links_human_user_agent_unique") {
        return {
          ok: false,
          reason: "already_exists",
          message: "lien humain-agent déjà existant",
        };
      }
      throwMappedInfrastructure(error, "création du lien humain-agent");
    }
  }

  async removeAgentLink(
    input: Parameters<HumanAdministrationUnitOfWork["removeAgentLink"]>[0],
  ): ReturnType<HumanAdministrationUnitOfWork["removeAgentLink"]> {
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(humanAgentLinks)
          .where(
            and(
              eq(humanAgentLinks.humanUserId, input.targetUserId),
              eq(humanAgentLinks.agentId, input.agentId),
            ),
          )
          .for("update")
          .limit(1);
        const row = rows[0];
        if (!row) {
          return {
            ok: false as const,
            reason: "not_found" as const,
            message: "lien humain-agent introuvable",
          };
        }

        await tx.delete(humanAgentLinks).where(eq(humanAgentLinks.id, row.id));
        await tx.insert(auditEntries).values(
          auditToRow(
            buildHumanAdministrationAudit({
              id: input.auditId,
              occurredAt: input.occurredAt,
              actorUserId: input.actorUserId,
              eventType: "human_agent_link.removed",
              targetUserId: input.targetUserId,
              agentId: input.agentId,
              relation: humanAgentRelationSchema.parse(row.relation),
            }),
          ),
        );

        return {
          ok: true as const,
          value: toHumanAgentLink(row),
          changed: true,
        };
      });
    } catch (error) {
      throwMappedInfrastructure(error, "retrait du lien humain-agent");
    }
  }
}

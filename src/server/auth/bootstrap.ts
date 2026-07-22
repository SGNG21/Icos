import { randomUUID } from "node:crypto";

import type { AuditEntry } from "@/core/contracts";
import type { AuditRepository } from "@/server/repositories/ports";

import type { AuthGateway, RoleRepository } from "./ports";

export interface BootstrapOwnerDeps {
  auth: AuthGateway;
  roles: RoleRepository;
  audit: AuditRepository;
  now?: () => string;
  newId?: (prefix: string) => string;
}

export type BootstrapOwnerResult =
  | { ok: true; status: "created" | "repaired" | "already_present"; userId?: string }
  | {
      ok: false;
      reason: "user_create_failed" | "role_grant_failed" | "compensation_failed";
      message: string;
    };

/**
 * Crée (ou répare) le premier owner de façon idempotente.
 *
 * Cas gérés :
 * - un ou plusieurs owners actifs existent déjà → `already_present` (refus de
 *   créer un second owner initial ; aucun owner existant n'est modifié) ;
 * - aucun owner et un utilisateur correspondant existe déjà (bootstrap
 *   incomplet) → attribution du rôle `owner` → `repaired` ;
 * - aucun owner ni utilisateur → création via Better Auth + rôle `owner` →
 *   `created`.
 *
 * Better Auth et l'attribution du rôle ne partagent pas une transaction unique :
 * en cas d'échec d'attribution APRÈS création, une suppression compensatoire de
 * l'utilisateur est tentée (cascade). Une nouvelle exécution peut réparer un
 * bootstrap incomplet sans créer de doublon. Aucune atomicité parfaite n'est
 * prétendue.
 */
export async function bootstrapOwner(
  deps: BootstrapOwnerDeps,
  input: { email: string; password: string; name?: string },
): Promise<BootstrapOwnerResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);

  const audit = async (
    eventType: AuditEntry["eventType"],
    details: AuditEntry["details"],
    userId?: string,
  ): Promise<void> => {
    await deps.audit.append({
      id: newId("audit"),
      occurredAt: now(),
      eventType,
      actor: { kind: "system", id: "icos-bootstrap" },
      details, // jamais de mot de passe / hash / token
      ...(userId ? { taskId: undefined } : {}),
    });
  };

  // 1. Un owner actif existe déjà ? → refus (aucun second owner initial).
  const activeOwners = await deps.roles.listActiveOwnerIds();
  if (activeOwners.length > 0) {
    return { ok: true, status: "already_present" };
  }

  // 2. Un utilisateur correspondant existe-t-il déjà (bootstrap incomplet) ?
  const existing = await deps.auth.readHumanUserByEmail(input.email);
  let userId: string;
  let created = false;

  if (existing) {
    userId = existing.id;
  } else {
    const creation = await deps.auth.createHumanUser({
      email: input.email,
      password: input.password,
      name: input.name,
    });
    if (!creation.ok) {
      await audit("auth.bootstrap.failed", { reason: creation.reason });
      return {
        ok: false,
        reason: "user_create_failed",
        message: `création de l'utilisateur impossible (${creation.reason})`,
      };
    }
    userId = creation.userId;
    created = true;
    await audit("user.created", { email: input.email }, userId);
  }

  // 3. Attribution du rôle owner (compensation si échec après création).
  try {
    await deps.roles.grantRole(userId, "owner");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (created) {
      try {
        await deps.auth.deleteHumanUser(userId);
      } catch {
        await audit("auth.bootstrap.failed", { reason: "compensation_failed" });
        return {
          ok: false,
          reason: "compensation_failed",
          message: "échec d'attribution du rôle ET de la compensation",
        };
      }
    }
    await audit("auth.bootstrap.failed", { reason: "role_grant_failed" });
    return { ok: false, reason: "role_grant_failed", message };
  }

  await audit("role.changed", { role: "owner", change: "granted" }, userId);
  await audit("auth.bootstrap.succeeded", { email: input.email }, userId);
  return { ok: true, status: created ? "created" : "repaired", userId };
}

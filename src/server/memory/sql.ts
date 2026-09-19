import { randomUUID } from "node:crypto";

import { and, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { ZodType } from "zod";

import type { MemoryActor } from "@/core/memory";
import { RepositoryMappingError } from "@/server/database/errors";

/** Horloge et générateur d'identifiants injectables (tests déterministes). */
export interface MemoryDeps {
  now?: () => Date;
  newId?: (prefix: string) => string;
}
export const resolveDeps = (d: MemoryDeps = {}) => ({
  now: d.now ?? (() => new Date()),
  newId: d.newId ?? ((prefix: string) => `${prefix}-${randomUUID()}`),
});

/** Colonnes de l'enveloppe commune, pour les prédicats de visibilité/fraîcheur. */
export interface EnvelopeCols {
  tenantId: AnyPgColumn;
  visibility: AnyPgColumn;
  ownerSubject: AnyPgColumn;
  requiredPermission: AnyPgColumn;
  staleAfter: AnyPgColumn;
  expiresAt: AnyPgColumn;
}

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/** Prédicat SQL miroir de `canRead` (I11) : appliqué AVANT la limite. */
export function visibleSql(c: EnvelopeCols, reader: MemoryActor): SQL {
  const owners = [
    ...new Set([reader.kind === "human" ? reader.id : undefined, reader.onBehalfOfUserId]),
  ].filter((x): x is string => typeof x === "string");
  const perms = [...reader.permissions];
  const restricted = perms.length ? inArray(c.requiredPermission, perms) : sql`false`;
  const priv = owners.length ? inArray(c.ownerSubject, owners) : sql`false`;
  return sql`(${eq(c.tenantId, reader.tenantId)} and (${eq(c.visibility, "tenant")} or (${eq(c.visibility, "restricted")} and ${restricted}) or (${eq(c.visibility, "private")} and ${priv})))`;
}

export const notExpiredSql = (c: EnvelopeCols, now: Date): SQL =>
  or(isNull(c.expiresAt), gt(c.expiresAt, sql`${ts(now)}`)) as SQL;

/** 0 = fresh, 1 = stale (tri : fresh d'abord). */
export const staleRankSql = (c: EnvelopeCols, now: Date): SQL =>
  sql`case when ${c.staleAfter} is not null and ${c.staleAfter} <= ${ts(now)} then 1 else 0 end`;

/** Compte agrégé unique : matched / denied / expired / inactive (voir DESIGN §6). */
export function statsSql(c: EnvelopeCols, reader: MemoryActor, now: Date, activePredicate: SQL) {
  const vis = visibleSql(c, reader);
  const expired = sql`(${c.expiresAt} is not null and ${c.expiresAt} <= ${ts(now)})`;
  return {
    matched: sql<number>`count(*)::int`,
    denied: sql<number>`(count(*) filter (where not ${vis}))::int`,
    expired: sql<number>`(count(*) filter (where ${vis} and ${expired}))::int`,
    inactive: sql<number>`(count(*) filter (where ${vis} and not ${expired} and not (${activePredicate})))::int`,
  };
}

export { and, ts };

// ── Mapping ligne → contrat (revalidation Zod systématique) ─────────────────
const JSON_COLUMNS = new Set(["payload", "value"]);

/** Dates → ISO ; jsonb éventuellement renvoyé en chaîne selon le chemin driver. */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      v instanceof Date
        ? v.toISOString()
        : JSON_COLUMNS.has(k) && typeof v === "string"
          ? JSON.parse(v)
          : v,
    ]),
  );
}

export function mapRow<T>(schema: ZodType<T>, entity: string, row: Record<string, unknown>): T {
  const parsed = schema.safeParse(normalizeRow(row));
  if (!parsed.success)
    throw new RepositoryMappingError(
      entity,
      parsed.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  return parsed.data;
}

export const toDate = (s: string | null | undefined): Date | null => (s ? new Date(s) : null);
export const lockKey = (...parts: string[]) =>
  sql`select pg_advisory_xact_lock(hashtext(${parts.join("|")}))`;

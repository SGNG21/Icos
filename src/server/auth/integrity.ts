import type { Sql } from "postgres";

import type { Env } from "@/config/env";

/**
 * Contrôle d'intégrité de l'authentification humaine (Better Auth + `user_roles`).
 *
 * LECTURE SEULE, fail closed : ne recrée jamais un credential, ne modifie aucun
 * mot de passe, ne teste pas le mot de passe réel. Le hash n'est jamais lu :
 * seul un booléen « format exploitable » est calculé côté SQL. Le rapport ne
 * contient que des états et des codes de cause (jamais d'email, secret, URL,
 * hash, token ou cookie).
 */

export type CheckStatus = "PASS" | "FAIL";
export interface CheckResult {
  status: CheckStatus;
  cause?: string;
}

export const DB_CHECKS = [
  "AUTH_SCHEMA",
  "OWNER_USER",
  "OWNER_CREDENTIAL",
  "OWNER_ENABLED",
  "OWNER_ROLE",
  "RELATION_INTEGRITY",
  "DUPLICATE_USER_CHECK",
  "RESTORE_COMPLETENESS",
] as const;
export type DbCheckKey = (typeof DB_CHECKS)[number];

export interface OwnerRow {
  status: string;
  credentialAccounts: number;
  /** Comptes `credential` dont le hash a un format Better Auth exploitable. */
  usableCredentials: number;
  hasOwnerRole: boolean;
}

export interface AuthData {
  /** `null` : ICOS_OWNER_EMAIL non configuré. */
  owners: OwnerRow[] | null;
  totalUsers: number;
  duplicateEmailGroups: number;
  usersWithoutCredential: number;
  usersWithoutRole: number;
  orphanAccounts: number;
  orphanRoles: number;
  orphanSessions: number;
}

export interface AuthSnapshot {
  /** `table` ou `table.colonne` manquants ; `data` absent si le schéma est incomplet. */
  missingSchema: string[];
  data?: AuthData;
}

export interface AuthReport {
  checks: Record<DbCheckKey | "BETTER_AUTH_CONFIG", CheckResult>;
  ok: boolean;
  database?: string;
}

const PASS: CheckResult = { status: "PASS" };
const fail = (cause: string): CheckResult => ({ status: "FAIL", cause });
const verdict = (causes: string[]): CheckResult => (causes.length ? fail(causes.join(",")) : PASS);

const REQUIRED_SCHEMA: Record<string, string[]> = {
  user: ["id", "name", "email", "status"],
  account: ["id", "account_id", "provider_id", "user_id", "password"],
  session: ["id", "user_id", "token"],
  verification: ["id"],
  user_roles: ["user_id", "role"],
};

/** Évaluation PURE (sans I/O) d'un instantané. Tout ce qui est incertain échoue. */
export function evaluateAuthSnapshot(snap: AuthSnapshot): Record<DbCheckKey, CheckResult> {
  const schema = verdict(
    snap.missingSchema.length ? [`missing:${snap.missingSchema.join(",")}`] : [],
  );
  if (!snap.data) {
    const unavailable = fail("schema_unavailable");
    return {
      AUTH_SCHEMA: schema.status === "FAIL" ? schema : fail("schema_unavailable"),
      OWNER_USER: unavailable,
      OWNER_CREDENTIAL: unavailable,
      OWNER_ENABLED: unavailable,
      OWNER_ROLE: unavailable,
      RELATION_INTEGRITY: unavailable,
      DUPLICATE_USER_CHECK: unavailable,
      RESTORE_COMPLETENESS: unavailable,
    };
  }
  const d = snap.data;
  const owners = d.owners;
  const noOwner = (): CheckResult | undefined =>
    owners === null
      ? fail("owner_email_not_configured")
      : owners.length === 0
        ? fail("owner_user_missing")
        : undefined;
  const ownerCheck = (test: (o: OwnerRow) => string | undefined): CheckResult =>
    noOwner() ?? verdict(owners!.map(test).filter((c): c is string => c !== undefined));

  const orphans = [
    d.orphanAccounts > 0 && "orphan_accounts",
    d.orphanRoles > 0 && "orphan_roles",
    d.orphanSessions > 0 && "orphan_sessions",
  ].filter(Boolean) as string[];

  const duplicates = [
    d.duplicateEmailGroups > 0 && "duplicate_email",
    (owners?.length ?? 0) > 1 && "duplicate_owner_user",
    owners?.some((o) => o.credentialAccounts > 1) && "duplicate_credential",
  ].filter(Boolean) as string[];

  const restore =
    d.totalUsers === 0
      ? ["no_users"]
      : ([
          d.usersWithoutCredential > 0 && "users_without_credential",
          d.usersWithoutRole > 0 && "users_without_role",
        ].filter(Boolean) as string[]);

  return {
    AUTH_SCHEMA: schema,
    OWNER_USER: noOwner() ?? PASS,
    OWNER_CREDENTIAL: ownerCheck((o) =>
      o.credentialAccounts === 0
        ? "credential_missing"
        : o.usableCredentials === 0
          ? "credential_unusable"
          : undefined,
    ),
    // Fail closed : tout statut autre que « active » (y compris inconnu) échoue.
    OWNER_ENABLED: ownerCheck((o) => (o.status === "active" ? undefined : "owner_not_active")),
    OWNER_ROLE: ownerCheck((o) => (o.hasOwnerRole ? undefined : "owner_role_missing")),
    RELATION_INTEGRITY: verdict(orphans),
    DUPLICATE_USER_CHECK: verdict(duplicates),
    RESTORE_COMPLETENESS: verdict(restore),
  };
}

/** Cohérence de la configuration runtime Better Auth. Ne lit jamais la valeur du secret au-delà de sa longueur. */
export function checkAuthConfig(env: Env): CheckResult {
  const causes: string[] = [];
  if (env.PERSISTENCE !== "postgres") causes.push("persistence_not_postgres");
  if (env.DATABASE_URL === undefined) causes.push("database_url_missing");
  if (env.BETTER_AUTH_SECRET === undefined) causes.push("secret_missing");
  else if (env.BETTER_AUTH_SECRET.length < 32) causes.push("secret_too_short");
  if (env.BETTER_AUTH_URL === undefined) causes.push("base_url_missing");
  else if (env.NODE_ENV === "production" && new URL(env.BETTER_AUTH_URL).protocol !== "https:") {
    causes.push("base_url_not_https");
  }
  if (env.ICOS_OWNER_EMAIL === undefined || !env.ICOS_OWNER_EMAIL.includes("@")) {
    causes.push("owner_email_missing");
  }
  return verdict(causes);
}

export function buildAuthReport(
  dbChecks: Record<DbCheckKey, CheckResult>,
  config: CheckResult,
  database?: string,
): AuthReport {
  const checks = { ...dbChecks, BETTER_AUTH_CONFIG: config };
  return { checks, ok: Object.values(checks).every((c) => c.status === "PASS"), database };
}

const REPORT_ORDER = [
  "AUTH_SCHEMA",
  "OWNER_USER",
  "OWNER_CREDENTIAL",
  "OWNER_ENABLED",
  "OWNER_ROLE",
  "RELATION_INTEGRITY",
  "DUPLICATE_USER_CHECK",
  "BETTER_AUTH_CONFIG",
  "RESTORE_COMPLETENESS",
] as const;

export function formatAuthReport(report: AuthReport): string {
  const lines = REPORT_ORDER.map((key) => {
    const { status, cause } = report.checks[key];
    return cause ? `${key}=${status} cause=${cause}` : `${key}=${status}`;
  });
  if (report.database) lines.unshift(`DATABASE=${report.database}`);
  lines.push(`AUTH_INTEGRITY=${report.ok ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}

const count = (v: unknown): number => Number(v);

/**
 * Lit l'instantané dans une transaction READ ONLY (aucune écriture possible).
 * `ownerEmail` est passé en paramètre lié.
 */
export async function readAuthSnapshot(
  sql: Sql,
  ownerEmail: string | undefined,
): Promise<AuthSnapshot> {
  return sql.begin("read only", async (tx) => {
    const cols = await tx<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = current_schema() and table_name in ${tx(Object.keys(REQUIRED_SCHEMA))}`;
    const present = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    const tables = new Set(cols.map((c) => c.table_name));
    const missingSchema = Object.entries(REQUIRED_SCHEMA).flatMap(([table, columns]) =>
      tables.has(table)
        ? columns.filter((c) => !present.has(`${table}.${c}`)).map((c) => `${table}.${c}`)
        : [table],
    );
    if (missingSchema.length) return { missingSchema };

    const owners =
      ownerEmail === undefined
        ? null
        : (
            await tx<Record<string, unknown>[]>`
              select u.status,
                count(a.id) filter (where a.provider_id = 'credential') as credential_accounts,
                count(a.id) filter (where a.provider_id = 'credential'
                  and a.password ~ '^[0-9a-f]+:[0-9a-f]+$') as usable_credentials,
                exists (select 1 from user_roles r where r.user_id = u.id and r.role = 'owner') as has_owner_role
              from "user" u left join account a on a.user_id = u.id
              where lower(u.email) = lower(${ownerEmail})
              group by u.id, u.status`
          ).map((r) => ({
            status: String(r.status),
            credentialAccounts: count(r.credential_accounts),
            usableCredentials: count(r.usable_credentials),
            hasOwnerRole: r.has_owner_role === true,
          }));

    const [g] = await tx<Record<string, unknown>[]>`
      select
        (select count(*) from "user") as total_users,
        (select count(*) from (select 1 from "user" group by lower(email) having count(*) > 1) d) as duplicate_email_groups,
        (select count(*) from "user" u where not exists
          (select 1 from account a where a.user_id = u.id and a.provider_id = 'credential')) as users_without_credential,
        (select count(*) from "user" u where not exists
          (select 1 from user_roles r where r.user_id = u.id)) as users_without_role,
        (select count(*) from account a where not exists (select 1 from "user" u where u.id = a.user_id)) as orphan_accounts,
        (select count(*) from user_roles r where not exists (select 1 from "user" u where u.id = r.user_id)) as orphan_roles,
        (select count(*) from session s where not exists (select 1 from "user" u where u.id = s.user_id)) as orphan_sessions`;

    return {
      missingSchema,
      data: {
        owners,
        totalUsers: count(g.total_users),
        duplicateEmailGroups: count(g.duplicate_email_groups),
        usersWithoutCredential: count(g.users_without_credential),
        usersWithoutRole: count(g.users_without_role),
        orphanAccounts: count(g.orphan_accounts),
        orphanRoles: count(g.orphan_roles),
        orphanSessions: count(g.orphan_sessions),
      },
    };
  });
}

/** Orchestration : config + lecture + évaluation. Toute erreur de lecture → FAIL (cause fixe, message jamais exposé). */
export async function runAuthIntegrityCheck(sql: Sql, env: Env): Promise<AuthReport> {
  let dbChecks: Record<DbCheckKey, CheckResult>;
  try {
    dbChecks = evaluateAuthSnapshot(await readAuthSnapshot(sql, env.ICOS_OWNER_EMAIL));
  } catch {
    // Le message d'erreur peut contenir hôte/utilisateur : on n'expose qu'un code.
    const unreachable = fail("database_unreachable");
    dbChecks = Object.fromEntries(DB_CHECKS.map((k) => [k, unreachable])) as Record<
      DbCheckKey,
      CheckResult
    >;
  }
  return buildAuthReport(dbChecks, checkAuthConfig(env), databaseName(env.DATABASE_URL));
}

/** Nom de base non sensible (jamais l'URL) : révèle un éventuel décalage de cible DB. */
export function databaseName(url: string | undefined): string | undefined {
  try {
    return url ? decodeURIComponent(new URL(url).pathname.slice(1)) || undefined : undefined;
  } catch {
    return undefined;
  }
}
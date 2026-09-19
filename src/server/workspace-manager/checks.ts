import type { AddedLine, ChangedFile } from "./git";
import { matchesAny } from "./scope";
import type { IntegrationDecision, Workspace } from "./types";

const isTest = (f: string) =>
  /\.test\.tsx?$/.test(f) || f.startsWith("test/") || f.startsWith("tests/");

export interface Finding {
  file: string;
  rule: string;
}

// Les motifs sont écrits pour ne pas se reconnaître eux-mêmes dans le diff de ce fichier.
const SECRET_LINE_RULES: [string, RegExp, boolean][] = [
  // Le 3e champ marque les règles haute confiance, appliquées partout ; les heuristiques
  // (mot de passe factice fréquent dans les fixtures) ne s'appliquent pas aux tests/docs.
  ["clé privée", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, true],
  ["clé AWS", /\bAKIA[0-9A-Z]{16}\b/, true],
  ["jeton API", /\b(?:sk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{20,}/, true],
  ["URL avec mot de passe", /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/i, false],
  [
    "secret assigné",
    /(?:password|passwd|secret|api[_-]?key|token)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    false,
  ],
];
const SECRET_FILES = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/id_rsa*",
  "**/*.p12",
  "secrets/**",
];
const SECRET_FILE_ALLOWED = [".env.example", "**/.env.example", ".env.sample", "**/.env.sample"];

/** Ne renvoie jamais la valeur détectée : seulement fichier + règle. */
export function scanSecrets(
  changed: readonly ChangedFile[],
  added: readonly AddedLine[],
): Finding[] {
  const findings: Finding[] = [];
  for (const { status, path } of changed) {
    if (
      status !== "D" &&
      matchesAny(path, SECRET_FILES) &&
      !matchesAny(path, SECRET_FILE_ALLOWED)
    ) {
      findings.push({ file: path, rule: "fichier secret" });
    }
  }
  for (const { file, line } of added) {
    const fixtureLike = isTest(file) || file.endsWith(".md");
    for (const [rule, re, strong] of SECRET_LINE_RULES) {
      if ((strong || !fixtureLike) && re.test(line)) findings.push({ file, rule });
    }
  }
  return findings;
}

const GOVERNANCE = [
  "CLAUDE.md",
  "AGENTS.md",
  "SECURITY.md",
  ".claude/**",
  ".icos/**",
  ".github/**",
  "eslint.config.mjs",
  "tsconfig.json",
  "vitest*.config.ts",
  "src/server/database/test-database-guard.ts",
  "src/server/workspace-manager/**",
];
const WEAKENING: [string, RegExp][] = [
  ["test désactivé/isolé", /\.(?:skip|only)\(/],
  ["vérification de type désactivée", /@ts-(?:ignore|nocheck)/],
  ["lint désactivé", /eslint-(?:disable)/],
  ["hook contourné", /--no-(?:verify)/],
  ["opération git destructive", /reset --(?:hard)|push\b.*--(?:force)/],
];
const LIVE_DB = /icos_n23_(?:probe)/;

export interface SecurityFindings {
  governance: string[];
  weakening: Finding[];
}

export function scanSecurity(
  changed: readonly ChangedFile[],
  added: readonly AddedLine[],
): SecurityFindings {
  const weakening: Finding[] = [];
  for (const { file, line } of added) {
    for (const [rule, re] of WEAKENING) if (re.test(line)) weakening.push({ file, rule });
    if (!isTest(file) && LIVE_DB.test(line))
      weakening.push({ file, rule: "référence à la base live" });
  }
  return {
    governance: changed.map((c) => c.path).filter((p) => matchesAny(p, GOVERNANCE)),
    weakening,
  };
}

const MIGRATION_SQL = /^drizzle\/(\d{4})_[^/]+\.sql$/;
const MIGRATION_SNAPSHOT = /^drizzle\/meta\/(\d{4})_snapshot\.json$/;
const NON_ADDITIVE =
  /\b(?:drop\s+(?:table|column|schema|index|constraint|type)|truncate|delete\s+from|alter\s+table\s+\S+\s+(?:drop|rename)|rename\s+to)\b/i;

export interface MigrationCheck {
  added: string[];
  decision: Exclude<IntegrationDecision, "ACCEPT"> | null;
  reasons: string[];
}

const SEVERITY = { REJECT: 3, NEEDS_REBASE: 2, NEEDS_HUMAN_APPROVAL: 1 } as const;

export function checkMigrations(input: {
  changed: readonly ChangedFile[];
  added: readonly AddedLine[];
  reservation: Workspace["migrationReservation"];
  /** Fichiers `drizzle/*` de la cible et de la base du workspace. */
  targetFiles: readonly string[];
  baseFiles: readonly string[];
}): MigrationCheck {
  const result: MigrationCheck = { added: [], decision: null, reasons: [] };
  const flag = (decision: NonNullable<MigrationCheck["decision"]>, reason: string) => {
    result.reasons.push(reason);
    if (!result.decision || SEVERITY[decision] > SEVERITY[result.decision])
      result.decision = decision;
  };
  const number = (p: string) => Number((MIGRATION_SQL.exec(p) ?? MIGRATION_SNAPSHOT.exec(p))?.[1]);
  const newInTarget = input.targetFiles.filter((f) => !input.baseFiles.includes(f));

  for (const { status, path } of input.changed) {
    if (!MIGRATION_SQL.test(path) && !MIGRATION_SNAPSHOT.test(path)) continue;
    if (status !== "A") {
      flag(
        "REJECT",
        `migration existante modifiée ou supprimée : ${path} (jamais d'édition d'une migration appliquée)`,
      );
      continue;
    }
    if (!MIGRATION_SQL.test(path)) continue;
    result.added.push(path);
    const n = number(path);
    const r = input.reservation;
    if (!r || n < r.from || n > r.to) {
      flag(
        "REJECT",
        `migration non réservée : ${path} (réservation : ${r ? `${r.from}-${r.to}` : "aucune"})`,
      );
    }
    const taken = newInTarget.find(
      (f) => MIGRATION_SQL.test(`drizzle/${f}`) && Number(f.slice(0, 4)) === n,
    );
    if (taken)
      flag(
        "NEEDS_REBASE",
        `numéro de migration ${String(n).padStart(4, "0")} déjà pris par la cible (${taken}) : renumérotation nécessaire`,
      );
    if (input.added.some((l) => l.file === path && NON_ADDITIVE.test(l.line))) {
      flag("NEEDS_HUMAN_APPROVAL", `migration non additive : ${path}`);
    }
  }
  return result;
}

/** Le périmètre déclaré + ce que la réservation de migration donne de facto au worker. */
export function effectiveScope(ws: Workspace): Workspace["fileScope"] {
  const r = ws.migrationReservation;
  if (!r) return ws.fileScope;
  const owns = [...ws.fileScope.owns];
  for (let n = r.from; n <= r.to; n++) {
    const p = String(n).padStart(4, "0");
    owns.push(`drizzle/${p}_*.sql`, `drizzle/meta/${p}_snapshot.json`);
  }
  return { ...ws.fileScope, owns, shared: [...ws.fileScope.shared, "drizzle/meta/_journal.json"] };
}

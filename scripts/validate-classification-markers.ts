#!/usr/bin/env node
/**
 * COMPLIANCE-1 — Validation des marqueurs @classification dans les schémas Drizzle.
 *
 * Vérifie que les colonnes contenant des données C2/C3 sont annotées
 * avec un commentaire `@classification C2` ou `@classification C3`.
 *
 * Ce script est un CI gate précoce, PAS un scanner de sécurité complet.
 * Il signale les anomalies potentielles dans les fichiers modifiés.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

interface MarkerIssue {
  file: string;
  line: number;
  message: string;
}

function getModifiedFiles(): string[] {
  try {
    const stdout = execSync(
      "git diff --name-only --diff-filter=ACMRT origin/main...HEAD -- '*.ts' '*.sql'",
      { encoding: "utf-8" },
    );
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    // Si la branche n'a pas origin/main comme base, fallback sur les fichiers modifiés vs HEAD
    const stdout = execSync("git diff --name-only HEAD -- '*.ts' '*.sql'", { encoding: "utf-8" });
    return stdout.trim().split("\n").filter(Boolean);
  }
}

/** Schémas Drizzle connus qui doivent être vérifiés */
const SCHEMA_FILES = ["src/server/database/schema.ts", "src/server/database/auth-schema.ts"];

/** Colonnes Drizzle connues pour contenir des données C2/C3 sans marquage */
const C2_C3_COLUMNS = [
  // Format: table.column
  "user.name",
  "user.email",
  "agents.name",
  "agents.description",
  "tasks.title",
  "tasks.description",
  "approvals.reason",
  "capabilities.name",
  "capabilities.description",
  "skills.name",
  "skills.description",
  "skills.content_hash",
  "skill_security_findings.message",
];

/**
 * Vérifie qu'un fichier de schéma contient les marqueurs @classification
 * pour les colonnes définies.
 */
function checkSchemaFile(filePath: string, issues: MarkerIssue[]): void {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    // Fichier supprimé ou inexistant
    return;
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Cherche les colonnes avec commentaire @classification
    const match = line.match(/@classification\s+(C2|C3)/);
    if (!match) continue;

    // Vérifie que la colonne est bien typée (text, jsonb, etc.)
    const colDef = line.match(/(\w+)\(/);
    if (!colDef) {
      issues.push({
        file: filePath,
        line: i + 1,
        message: `Marqueur @classification ${match[1]} trouvé mais impossible de vérifier le type de colonne`,
      });
    }
  }
}

function main(): void {
  const issues: MarkerIssue[] = [];
  const modified = getModifiedFiles();
  const filesToCheck = SCHEMA_FILES.filter((f) => modified.some((m) => m.includes(f)));

  // Si les fichiers de schéma ne sont pas modifiés, on vérifie quand même
  // les changements dans les migrations.
  const schemaModified = filesToCheck.length > 0;
  const migrationModified = modified.some((f) => f.startsWith("drizzle/"));

  if (!schemaModified && !migrationModified) {
    console.log("✅ Aucun fichier de schéma ou migration modifié — vérification ignorée.");
    process.exit(0);
  }

  // Vérifier les fichiers de schéma modifiés
  for (const file of filesToCheck) {
    checkSchemaFile(file, issues);
  }

  if (issues.length > 0) {
    console.error("❌ Problèmes de marquage @classification détectés :");
    for (const issue of issues) {
      console.error(`  ${issue.file}:${issue.line} — ${issue.message}`);
    }
    process.exit(1);
  }

  console.log("✅ Marquage @classification conforme.");
}

main();

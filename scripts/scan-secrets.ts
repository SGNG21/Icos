#!/usr/bin/env node
/**
 * COMPLIANCE-1 — Secret scanning CI gate
 *
 * Ce script pattern-matche les fichiers modifiés pour détecter des secrets
 * potentiels (tokens, clés privées, mots de passe en clair).
 *
 * ATTENTION : ce n'est PAS un scanner de sécurité complet.
 * - Patterns intentionnellement limités pour éviter les faux positifs excessifs
 * - Ne remplace pas git-secrets, trufflehog, ou un SAST
 * - Early-warning CI gate uniquement
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

interface SecretMatch {
  file: string;
  line: number;
  pattern: string;
  preview: string;
}

const SECRET_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /sk-[A-Za-z0-9]{20,}/, name: "API key (sk- prefix)" },
  { pattern: /AKIA[0-9A-Z]{16}/, name: "AWS Access Key" },
  { pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, name: "Private key" },
  { pattern: /ghp_[A-Za-z0-9]{36,}/, name: "GitHub PAT" },
  { pattern: /gho_[A-Za-z0-9]{36,}/, name: "GitHub OAuth token" },
  { pattern: /ghu_[A-Za-z0-9]{36,}/, name: "GitHub user token" },
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{6,}['"]/i, name: "Password in config" },
  {
    pattern: /(?:secret|api[_-]?key|token)\s*[:=]\s*['"][A-Za-z0-9+/]{20,}['"]/i,
    name: "Secret/token in config",
  },
];

/** Fichiers exclus du scan */
const EXCLUDE_PATTERNS = [/\/node_modules\//, /\.git\//, /\/dist\//, /\/\.next\//];

/** Fichiers avec ce commentaire en header sont ignorés */
const SKIP_COMMENT = "@secret-scanner-ignore";

function getModifiedFiles(): string[] {
  try {
    const stdout = execSync("git diff --name-only --diff-filter=ACMRT origin/main...HEAD", {
      encoding: "utf-8",
    });
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    const stdout = execSync("git diff --name-only HEAD --", { encoding: "utf-8" });
    return stdout.trim().split("\n").filter(Boolean);
  }
}

function shouldExclude(filePath: string): boolean {
  return EXCLUDE_PATTERNS.some((p) => p.test(filePath));
}

function hasSkipComment(filePath: string): boolean {
  try {
    const firstLine = readFileSync(filePath, "utf-8").split("\n")[0];
    return firstLine.includes(SKIP_COMMENT);
  } catch {
    return false;
  }
}

function scanFile(filePath: string, matches: SecretMatch[]): void {
  if (shouldExclude(filePath) || hasSkipComment(filePath)) return;

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, name } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        const trimmed = line.substring(0, 60).replace(/['"]/g, "").trim();
        matches.push({
          file: filePath,
          line: i + 1,
          pattern: name,
          preview: trimmed.length > 50 ? trimmed.substring(0, 50) + "..." : trimmed,
        });
        // Un seul match par ligne pour éviter le spam
        break;
      }
    }
  }
}

function main(): void {
  const files = getModifiedFiles();
  const matches: SecretMatch[] = [];

  for (const file of files) {
    scanFile(file, matches);
  }

  if (matches.length > 0) {
    console.error("❌ Secrets potentiels détectés dans les fichiers modifiés :");
    console.error("");
    for (const match of matches) {
      console.error(`  ${match.file}:${match.line}`);
      console.error(`    Type  : ${match.pattern}`);
      console.error(`    Vue   : ${match.preview}`);
      console.error("");
    }
    console.error("⚠️  Ce scan n'est pas exhaustif. Vérifiez manuellement avant de commit.");
    console.error(
      "💡 Ajoutez // @secret-scanner-ignore en header du fichier si c'est un faux positif documenté.",
    );
    process.exit(1);
  }

  console.log("✅ Scan de secrets : aucun pattern détecté dans les fichiers modifiés.");
}

main();

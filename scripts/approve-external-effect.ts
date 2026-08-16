#!/usr/bin/env tsx
/**
 * NF-1 (Phase 2B) — CLI PROPRIÉTAIRE d'approbation d'effet externe.
 *
 * Ce script est exécuté PAR LE PROPRIÉTAIRE (jamais par un worker ni un
 * sous-processus de mission). Il :
 *   1. garantit la paire de clés Ed25519 de l'autorité dans
 *      `~/.icos/approval-authority/` (clé privée 0600, HORS workspace) ;
 *   2. signe un payload d'approbation lié à : périmètre exact, mission,
 *      dépôt canonique, branche EXACTE, nonce anti-rejeu, fenêtre
 *      d'expiration bornée (TTL max 24 h) ;
 *   3. écrit l'artefact signé au chemin de sortie.
 *
 * L'artefact peut vivre dans le workspace : son contenu est protégé par la
 * signature (un worker peut l'écraser, jamais le forger), et le nonce est
 * à usage unique.
 *
 * Usage :
 *   pnpm tsx scripts/approve-external-effect.ts \
 *     --mission <missionId> --branch <exact-branch> \
 *     [--scope git-push+pr-create] [--repository <canonical-path>] \
 *     [--ttl-minutes 60] [--out .icos/approvals/first-auto-external-effect.signed.json]
 */

import { realpath, writeFile, mkdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { EXTERNAL_EFFECT_SCOPE_PUSH_PR } from "@/server/security/external-effect-approval";
import {
  APPROVAL_MAX_TTL_MS,
  APPROVAL_SCHEMA_VERSION,
  defaultAuthorityDir,
  ensureAuthorityKeypair,
  generateApprovalNonce,
  signApprovalPayload,
} from "@/server/security/approval-authority";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const missionId = argValue("mission");
  const branch = argValue("branch");
  if (!missionId || !branch) {
    console.error(
      "Usage: approve-external-effect.ts --mission <id> --branch <exact-branch> " +
        "[--scope <scope>] [--repository <path>] [--ttl-minutes <n>] [--out <file>]",
    );
    process.exit(2);
  }

  const scope = argValue("scope") ?? EXTERNAL_EFFECT_SCOPE_PUSH_PR;
  const repository = await realpath(argValue("repository") ?? process.cwd());
  const ttlMinutes = Number(argValue("ttl-minutes") ?? "60");
  if (
    !Number.isFinite(ttlMinutes) ||
    ttlMinutes <= 0 ||
    ttlMinutes * 60_000 > APPROVAL_MAX_TTL_MS
  ) {
    console.error(`TTL invalide : ${ttlMinutes} min (max ${APPROVAL_MAX_TTL_MS / 60_000} min)`);
    process.exit(2);
  }
  const outPath = path.resolve(
    argValue("out") ??
      path.join(repository, ".icos", "approvals", "first-auto-external-effect.signed.json"),
  );

  const authorityDir = defaultAuthorityDir(os.homedir());
  const { created } = await ensureAuthorityKeypair(authorityDir);
  if (created) {
    console.log(`Autorité initialisée : nouvelle paire de clés Ed25519 dans ${authorityDir}`);
  }

  const now = new Date();
  const artifact = await signApprovalPayload(authorityDir, {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    scope,
    missionId,
    repository,
    branch,
    nonce: generateApprovalNonce(),
    approvedBy: `${os.userInfo().username}@owner`,
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
  });

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");

  console.log("Approbation signée écrite :", outPath);
  console.log(`  scope      : ${scope}`);
  console.log(`  mission    : ${missionId}`);
  console.log(`  repository : ${repository}`);
  console.log(`  branch     : ${branch} (exacte — aucun joker)`);
  console.log(`  expire     : ${artifact.payload.expiresAt} (TTL ${ttlMinutes} min)`);
  console.log("  nonce      : usage unique (anti-rejeu)");
}

main().catch((error) => {
  console.error("ÉCHEC:", error instanceof Error ? error.message : error);
  process.exit(1);
});

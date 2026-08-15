import { createHash, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

/**
 * NF-1 (Phase 2B hardening) — Autorité d'approbation NON FORGEABLE des
 * effets externes autonomes (git push, création de PR).
 *
 * PROBLÈME (PHASE2_SECURITY_REVIEW, NF-1 BLOCKER) : l'artefact F5.2 est un
 * JSON non signé à un chemin inscriptible par le worker / un sous-processus
 * du dépôt : n'importe quel processus avec les permissions du workspace
 * peut le forger. Fail-closed contre l'ABSENCE, pas contre la FORGE.
 *
 * FRONTIÈRE DE CONFIANCE (la plus petite correcte) :
 *  - L'autorité d'approbation est un répertoire HORS workspace
 *    (production : `~/.icos/approval-authority/`) contenant la clé privée
 *    Ed25519 du propriétaire (mode 0600). Les workers, sous-processus de
 *    mission et le code du dépôt n'ont JAMAIS accès à cette clé — ils ne
 *    voient que la clé publique.
 *  - Un artefact d'approbation n'est valide que s'il porte une signature
 *    Ed25519 vérifiable par la clé publique de l'autorité, sur la forme
 *    canonique (clés triées) du payload. Aucune clé embarquée dans
 *    l'artefact n'est acceptée : seule l'ancre de confiance compte.
 *  - Le payload lie l'approbation à : périmètre exact de l'opération,
 *    mission, dépôt/workspace, branche EXACTE (aucun joker — NF-6),
 *    expiration, et un nonce anti-rejeu à usage unique.
 *
 * INVARIANT (fail-closed) : approbation périmée, malformée, rejouée,
 * non concordante ou invérifiable → DENY. Il n'existe aucun chemin par
 * défaut vers l'autorisation.
 *
 * Fraîcheur (fold NF-6) : `approvedAt` ≤ now + tolérance d'horloge (120 s),
 * `expiresAt` > now, fenêtre `expiresAt − approvedAt` ≤ TTL max (24 h),
 * branche exacte uniquement (les motifs `prefix/*` sont interdits ici).
 */

export const APPROVAL_SCHEMA_VERSION = 1;
export const APPROVAL_MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
export const APPROVAL_CLOCK_SKEW_MS = 120_000; // 2 min

export const AUTHORITY_PUBLIC_KEY_FILE = "authority-public.pem";
export const AUTHORITY_PRIVATE_KEY_FILE = "authority-private.pem";
export const CONSUMED_NONCES_DIR = "consumed-nonces";

/** Répertoire d'autorité par défaut, HORS de tout workspace/dépôt. */
export function defaultAuthorityDir(homeDir: string): string {
  return path.join(homeDir, ".icos", "approval-authority");
}

// ─────────────────────────────────────
// Payload signé et artefact
// ─────────────────────────────────────

export const signedApprovalPayloadSchema = z.object({
  schemaVersion: z.literal(APPROVAL_SCHEMA_VERSION),
  /** Périmètre EXACT de l'opération approuvée (ex. git-push+pr-create). */
  scope: z.string().min(1),
  /** Mission à laquelle l'approbation est liée. */
  missionId: z.string().min(1),
  /** Tâche (optionnelle) à laquelle l'approbation est liée. */
  taskId: z.string().min(1).optional(),
  /** Chemin canonique du dépôt/workspace autorisé. */
  repository: z.string().min(1),
  /**
   * Branche cible EXACTE. NF-6 : aucun joker (`*`) — une approbation vaut
   * pour UNE branche, pas pour un espace de noms.
   */
  branch: z
    .string()
    .min(1)
    .refine((b) => !b.includes("*"), "joker interdit — branche exacte requise"),
  /** Nonce anti-rejeu à usage unique (hex, ≥ 16 octets d'entropie). */
  nonce: z.string().regex(/^[0-9a-f]{32,}$/, "nonce hex de 16 octets minimum requis"),
  /** Identité humaine de l'approbateur. */
  approvedBy: z.string().min(1),
  /** Horodatage ISO de l'approbation. */
  approvedAt: z.string().datetime(),
  /** Expiration ISO. */
  expiresAt: z.string().datetime(),
});

export type SignedApprovalPayload = z.infer<typeof signedApprovalPayloadSchema>;

export const signedApprovalArtifactSchema = z.object({
  algorithm: z.literal("ed25519"),
  payload: signedApprovalPayloadSchema,
  /** Signature Ed25519 (base64) de la forme canonique du payload. */
  signature: z.string().min(1),
});

export type SignedApprovalArtifact = z.infer<typeof signedApprovalArtifactSchema>;

// ─────────────────────────────────────
// Canonicalisation déterministe
// ─────────────────────────────────────

/**
 * JSON canonique : clés d'objet triées récursivement, aucun espace.
 * La signature porte sur CETTE forme — toute mutation du payload (même
 * une réordonnance sémantiquement neutre suivie d'une altération) invalide
 * la signature.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

// ─────────────────────────────────────
// Décision
// ─────────────────────────────────────

export type SignedApprovalDenialCode =
  | "missing"
  | "unavailable"
  | "malformed"
  | "missing_authority_key"
  | "bad_signature"
  | "scope_mismatch"
  | "mission_mismatch"
  | "task_mismatch"
  | "repository_mismatch"
  | "branch_mismatch"
  | "future_dated"
  | "expired"
  | "invalid_window"
  | "ttl_exceeded"
  | "replayed_nonce";

export type SignedApprovalDecision =
  | { granted: true; payload: SignedApprovalPayload }
  | { granted: false; code: SignedApprovalDenialCode; reason: string };

export interface ExpectedSignedEffect {
  scope: string;
  missionId: string;
  taskId?: string;
  repository: string;
  branch: string;
}

function deny(code: SignedApprovalDenialCode, reason: string): SignedApprovalDecision {
  return { granted: false, code, reason };
}

// ─────────────────────────────────────
// Autorité (vérification + anti-rejeu)
// ─────────────────────────────────────

export class ApprovalAuthority {
  /**
   * @param authorityDir répertoire d'ancre de confiance HORS workspace.
   *   Le vérificateur n'y lit QUE la clé publique et le registre de nonces
   *   consommés — jamais la clé privée.
   */
  constructor(private readonly authorityDir: string) {}

  private get publicKeyPath(): string {
    return path.join(this.authorityDir, AUTHORITY_PUBLIC_KEY_FILE);
  }

  private get noncesDir(): string {
    return path.join(this.authorityDir, CONSUMED_NONCES_DIR);
  }

  /**
   * Vérifie un artefact d'approbation SANS consommer le nonce.
   * Toute anomalie → DENY (fail-closed).
   */
  async verify(
    rawArtifact: unknown,
    expected: ExpectedSignedEffect,
    now: Date = new Date(),
  ): Promise<SignedApprovalDecision> {
    if (rawArtifact === null || rawArtifact === undefined) {
      return deny("missing", "Aucun artefact d'approbation fourni");
    }

    const parsed = signedApprovalArtifactSchema.safeParse(rawArtifact);
    if (!parsed.success) {
      return deny(
        "malformed",
        `Artefact d'approbation malformé : ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(racine)"} — ${issue.message}`)
          .join("; ")}`,
      );
    }
    const artifact = parsed.data;

    // 1. Ancre de confiance : clé publique de l'autorité, hors workspace.
    let publicKeyPem: string;
    try {
      publicKeyPem = await readFile(this.publicKeyPath, "utf-8");
    } catch {
      return deny(
        "missing_authority_key",
        `Clé publique de l'autorité introuvable : ${this.publicKeyPath} — ` +
          "aucune approbation vérifiable (refus fail-closed)",
      );
    }

    // 2. Signature Ed25519 sur la forme canonique du payload.
    let signatureValid = false;
    try {
      signatureValid = verify(
        null,
        Buffer.from(canonicalJsonStringify(artifact.payload), "utf-8"),
        publicKeyPem,
        Buffer.from(artifact.signature, "base64"),
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      return deny(
        "bad_signature",
        "Signature invalide — l'artefact n'émane pas de l'autorité d'approbation " +
          "(forge ou altération détectée)",
      );
    }

    const p = artifact.payload;

    // 3. Liaisons exactes : opération, mission, tâche, dépôt, branche.
    if (p.scope !== expected.scope) {
      return deny(
        "scope_mismatch",
        `Périmètre signé « ${p.scope} » ≠ requis « ${expected.scope} »`,
      );
    }
    if (p.missionId !== expected.missionId) {
      return deny(
        "mission_mismatch",
        `Mission signée « ${p.missionId} » ≠ mission courante « ${expected.missionId} »`,
      );
    }
    if (expected.taskId !== undefined && p.taskId !== expected.taskId) {
      return deny(
        "task_mismatch",
        `Tâche signée « ${p.taskId ?? "(absente)"} » ≠ tâche courante « ${expected.taskId} »`,
      );
    }
    if (p.repository !== expected.repository) {
      return deny(
        "repository_mismatch",
        `Dépôt signé « ${p.repository} » ≠ dépôt courant « ${expected.repository} »`,
      );
    }
    if (p.branch !== expected.branch) {
      // Correspondance EXACTE uniquement (NF-6 : pas de joker).
      return deny(
        "branch_mismatch",
        `Branche signée « ${p.branch} » ≠ branche cible « ${expected.branch} »`,
      );
    }

    // 4. Fraîcheur (NF-6) : pas d'antidatage futur, pas d'expiration
    //    passée, fenêtre bornée par le TTL maximal.
    const nowMs = now.getTime();
    const approvedAtMs = Date.parse(p.approvedAt);
    const expiresAtMs = Date.parse(p.expiresAt);
    if (!Number.isFinite(approvedAtMs) || !Number.isFinite(expiresAtMs)) {
      return deny("malformed", "Horodatages d'approbation non analysables");
    }
    if (approvedAtMs > nowMs + APPROVAL_CLOCK_SKEW_MS) {
      return deny(
        "future_dated",
        `approvedAt (${p.approvedAt}) est dans le futur — artefact suspect`,
      );
    }
    if (expiresAtMs <= approvedAtMs) {
      return deny("invalid_window", `Fenêtre invalide : expiresAt ≤ approvedAt`);
    }
    if (expiresAtMs - approvedAtMs > APPROVAL_MAX_TTL_MS) {
      return deny(
        "ttl_exceeded",
        `Fenêtre d'approbation ${expiresAtMs - approvedAtMs} ms > TTL max ${APPROVAL_MAX_TTL_MS} ms`,
      );
    }
    if (expiresAtMs <= nowMs) {
      return deny("expired", `Approbation expirée (expiresAt=${p.expiresAt})`);
    }

    return { granted: true, payload: p };
  }

  /**
   * Vérifie PUIS consomme le nonce (usage unique). Un nonce déjà consommé
   * → DENY `replayed_nonce`. La consommation est atomique (création de
   * fichier en mode exclusif `wx`) : deux consommations concurrentes du
   * même nonce ne peuvent pas réussir toutes les deux.
   */
  async verifyAndConsume(
    rawArtifact: unknown,
    expected: ExpectedSignedEffect,
    now: Date = new Date(),
  ): Promise<SignedApprovalDecision> {
    const decision = await this.verify(rawArtifact, expected, now);
    if (!decision.granted) return decision;

    // Nom de fichier dérivé par hachage — le nonce est une donnée non
    // fiable, jamais utilisée directement comme composant de chemin.
    const nonceDigest = createHash("sha256").update(decision.payload.nonce).digest("hex");
    const nonceRecord = path.join(this.noncesDir, `${nonceDigest}.json`);
    try {
      await mkdir(this.noncesDir, { recursive: true });
      await writeFile(
        nonceRecord,
        JSON.stringify({ consumedAt: now.toISOString(), scope: decision.payload.scope }),
        { flag: "wx" },
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        return deny("replayed_nonce", "Nonce déjà consommé — rejeu refusé");
      }
      return deny(
        "unavailable",
        `Registre anti-rejeu indisponible (${code ?? "erreur inconnue"}) — refus fail-closed`,
      );
    }

    return decision;
  }

  /**
   * Charge un artefact depuis le disque, vérifie et consomme le nonce.
   * Fail-closed : absent → missing ; illisible → unavailable ;
   * non-JSON → malformed.
   */
  async loadVerifyAndConsume(
    filePath: string,
    expected: ExpectedSignedEffect,
    now: Date = new Date(),
  ): Promise<SignedApprovalDecision> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return deny("missing", `Artefact d'approbation signé absent : ${filePath}`);
      }
      return deny("unavailable", `Artefact illisible (${code ?? "erreur inconnue"}) : ${filePath}`);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      return deny("malformed", `Artefact d'approbation non-JSON : ${filePath}`);
    }

    return this.verifyAndConsume(raw, expected, now);
  }
}

// ─────────────────────────────────────
// Côté AUTORITÉ (propriétaire) — génération de clés et signature.
// Ces fonctions ne sont JAMAIS appelées par un worker : elles exigent la
// clé privée, qui n'existe que dans le répertoire d'autorité hors
// workspace (0600).
// ─────────────────────────────────────

/**
 * Génère la paire de clés Ed25519 de l'autorité si absente.
 * Clé privée en mode 0600. Refuse d'écraser une clé privée existante.
 */
export async function ensureAuthorityKeypair(
  authorityDir: string,
): Promise<{ publicKeyPath: string; privateKeyPath: string; created: boolean }> {
  const publicKeyPath = path.join(authorityDir, AUTHORITY_PUBLIC_KEY_FILE);
  const privateKeyPath = path.join(authorityDir, AUTHORITY_PRIVATE_KEY_FILE);

  await mkdir(authorityDir, { recursive: true, mode: 0o700 });

  try {
    await readFile(privateKeyPath, "utf-8");
    return { publicKeyPath, privateKeyPath, created: false };
  } catch {
    // Absente → générer.
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string, {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }) as string, {
    mode: 0o644,
  });
  return { publicKeyPath, privateKeyPath, created: true };
}

/** Génère un nonce anti-rejeu (16 octets, hex). */
export function generateApprovalNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Signe un payload d'approbation avec la clé privée de l'autorité.
 * (Fonction propriétaire — le worker ne possède pas la clé privée.)
 */
export async function signApprovalPayload(
  authorityDir: string,
  payload: SignedApprovalPayload,
): Promise<SignedApprovalArtifact> {
  const validated = signedApprovalPayloadSchema.parse(payload);
  const privateKeyPem = await readFile(
    path.join(authorityDir, AUTHORITY_PRIVATE_KEY_FILE),
    "utf-8",
  );
  const signature = sign(
    null,
    Buffer.from(canonicalJsonStringify(validated), "utf-8"),
    privateKeyPem,
  ).toString("base64");

  return { algorithm: "ed25519", payload: validated, signature };
}

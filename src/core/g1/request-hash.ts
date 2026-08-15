import { createHash } from "node:crypto";

/**
 * Éléments canoniques pour le calcul du requestHash.
 */
export interface RequestHashInput {
  tenantId: string;
  principalId: string;
  toolId: string;
  toolDefinitionHash: string;
  capability: string;
  operation: string;
  resource: string;
  /** Arguments canoniques (JSON trié). */
  arguments?: Record<string, unknown>;
  /** Marqueur d'effet externe. */
  hasExternalEffect?: boolean;
}

/**
 * Trie récursivement les clés d'un objet JSON pour un hachage déterministe.
 */
function sortKeysForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysForHash);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysForHash((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Calcule le requestHash d'une invocation canonique.
 *
 * Utilise SHA-256 sur les champs triés par nom pour garantir la
 * déterministe. Toute divergence dans le requestHash entre deux
 * étapes du cycle de vie doit entraîner FAIL CLOSED.
 */
export function computeRequestHash(input: RequestHashInput): string {
  const canonical = sortKeysForHash({
    tenantId: input.tenantId,
    principalId: input.principalId,
    toolId: input.toolId,
    toolDefinitionHash: input.toolDefinitionHash,
    capability: input.capability,
    operation: input.operation,
    resource: input.resource,
    arguments: input.arguments ?? {},
    hasExternalEffect: input.hasExternalEffect ?? false,
  }) as Record<string, unknown>;

  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Vérifie que deux requestHash correspondent.
 * En cas de divergence → FAIL CLOSED.
 */
export function verifyRequestHash(expected: string, actual: string): boolean {
  if (expected.length !== 64 || actual.length !== 64) {
    return false;
  }
  // Utilise une comparaison à temps constant pour éviter
  // les attaques timing (même si le hash est déjà public dans ce contexte).
  if (expected.length !== actual.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Input pour le calcul de l'IdempotencyKey.
 *
 * Dérivée des attributs d'identité métier uniquement.
 * requestHash est exclu — un changement de payload (arguments)
 * avec la même identité métier doit produire la MÊME clé,
 * ce qui permet de détecter le conflit via handleExistingIdempotency.
 *
 * INVARIANT : AttemptNumber ≠ IdempotencyKey.
 * Un retry technique conserve la même identité métier d'idempotence.
 */
export interface IdempotencyKeyInput {
  tenantId: string;
  principalId: string;
  missionId: string;
  runId: string;
}

/**
 * Dérive une IdempotencyKey déterministe depuis l'identité métier
 * de l'invocation (tenant, principal, mission, run).
 *
 * requestHash est VOLONTAIREMENT exclu de cette dérivation pour que
 * la même identité métier avec un payload différent produise la MÊME
 * clé. La divergence de requestHash est alors détectée par
 * handleExistingIdempotency → IDEMPOTENCY_CONFLICT.
 */
export function deriveIdempotencyKey(input: IdempotencyKeyInput): string {
  const canonical = {
    tenantId: input.tenantId,
    principalId: input.principalId,
    missionId: input.missionId,
    runId: input.runId,
  };

  const json = JSON.stringify(canonical, Object.keys(canonical).sort());
  return `ik-${createHash("sha256").update(json).digest("hex")}`;
}

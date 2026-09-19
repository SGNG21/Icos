import type { FreshnessState, HumanActor, MemoryActor, MemorySourceType } from "./contracts";

// ── Erreurs (messages sans valeur sensible) ──────────────────────────────────
export class MemoryTenantRequiredError extends Error {
  readonly code = "memory_tenant_required" as const;
  constructor() {
    super("Contexte tenant requis pour toute opération mémoire");
    this.name = "MemoryTenantRequiredError";
  }
}
export class MemoryPolicyError extends Error {
  readonly code = "memory_policy_violation" as const;
  constructor(reason: string) {
    super(`Politique mémoire violée : ${reason}`);
    this.name = "MemoryPolicyError";
  }
}
export class MemoryNotFoundError extends Error {
  readonly code = "memory_not_found" as const;
  constructor(entity: string) {
    super(`Entrée mémoire introuvable : ${entity}`);
    this.name = "MemoryNotFoundError";
  }
}
export class MemorySecretRejectedError extends Error {
  readonly code = "memory_secret_rejected" as const;
  constructor(where: string) {
    super(`Contenu rejeté : motif de secret détecté (${where})`);
    this.name = "MemorySecretRejectedError";
  }
}

// ── Garde-fous d'acteur ──────────────────────────────────────────────────────
export function assertTenant(actor: MemoryActor): void {
  if (!actor || typeof actor.tenantId !== "string" || actor.tenantId.trim() === "") {
    throw new MemoryTenantRequiredError();
  }
}

/** Seuls les humains écrivent la mémoire utilisateur/business (workers : `propose` uniquement). */
export function assertHuman(actor: MemoryActor): asserts actor is HumanActor {
  assertTenant(actor);
  if (actor.kind !== "human") {
    throw new MemoryPolicyError("écriture réservée à un acteur humain");
  }
}

/**
 * Anti-falsification de provenance : le type de source citée doit être cohérent avec
 * la nature de l'écrivain. Un agent ne peut pas se faire passer pour le système, ni
 * le système pour un humain ou un agent.
 */
export function assertSourceAllowed(actor: MemoryActor, sourceType: MemorySourceType): void {
  const ok =
    actor.kind === "agent"
      ? sourceType === "agent_report"
      : actor.kind === "human"
        ? sourceType !== "agent_report"
        : sourceType !== "human_input" && sourceType !== "agent_report";
  if (!ok)
    throw new MemoryPolicyError(`source '${sourceType}' interdite pour un acteur '${actor.kind}'`);
}

// ── Fraîcheur ────────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000;

export function freshnessOf(
  w: { staleAfter: string | null; expiresAt: string | null },
  now: Date,
): FreshnessState {
  if (w.expiresAt !== null && new Date(w.expiresAt).getTime() <= now.getTime()) return "expired";
  if (w.staleAfter !== null && new Date(w.staleAfter).getTime() <= now.getTime()) return "stale";
  return "fresh";
}

const WINDOWS_DAYS = {
  mission: { stale: null, expire: null },
  procedural: { stale: 30, expire: 180 },
  business: { stale: 180, expire: null },
} as const;

/** Fenêtres par défaut, calculées depuis `lastVerifiedAt` (bumpé à chaque re-observation). */
export function defaultFreshness(
  memory: keyof typeof WINDOWS_DAYS,
  lastVerifiedAt: string,
): { staleAfter: string | null; expiresAt: string | null } {
  const base = new Date(lastVerifiedAt).getTime();
  const w = WINDOWS_DAYS[memory];
  const at = (days: number | null) =>
    days === null ? null : new Date(base + days * DAY_MS).toISOString();
  return { staleAfter: at(w.stale), expiresAt: at(w.expire) };
}

// ── Confiance ────────────────────────────────────────────────────────────────
/** Taux de succès lissé (Laplace) : jamais 0 ni 1 avec peu d'observations. */
export function proceduralConfidence(successCount: number, failureCount: number): number {
  if (successCount < 0 || failureCount < 0) throw new RangeError("compteurs négatifs");
  return (successCount + 1) / (successCount + failureCount + 2);
}

const AGENT_REPORT_MAX_CONFIDENCE = 0.7;

export function assertConfidencePolicy(c: {
  sourceType: MemorySourceType;
  basis: "observed" | "derived" | "declared" | "validated";
  value: number;
}): void {
  if (c.sourceType === "agent_report") {
    if (c.basis !== "declared") {
      throw new MemoryPolicyError("un rapport d'agent ne peut être que 'declared'");
    }
    if (c.value > AGENT_REPORT_MAX_CONFIDENCE) {
      throw new MemoryPolicyError(
        `confiance d'un rapport d'agent plafonnée à ${AGENT_REPORT_MAX_CONFIDENCE}`,
      );
    }
  }
  if (
    c.basis === "validated" &&
    c.sourceType !== "human_input" &&
    c.sourceType !== "review_decision"
  ) {
    throw new MemoryPolicyError("'validated' exige une source humaine ou une décision de revue");
  }
}

// ── Visibilité (miroir TS du prédicat SQL) ───────────────────────────────────
export function canRead(
  e: {
    tenantId: string;
    visibility: "tenant" | "restricted" | "private";
    ownerSubject: string | null;
    requiredPermission: string | null;
  },
  reader: MemoryActor,
): boolean {
  if (e.tenantId !== reader.tenantId) return false;
  switch (e.visibility) {
    case "tenant":
      return true;
    case "restricted":
      return e.requiredPermission !== null && reader.permissions.includes(e.requiredPermission);
    case "private":
      return (
        e.ownerSubject !== null &&
        ((reader.kind === "human" && reader.id === e.ownerSubject) ||
          reader.onBehalfOfUserId === e.ownerSubject)
      );
  }
}

// ── Détection de secrets ─────────────────────────────────────────────────────
const SECRET_KEY =
  /^(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credentials?)$/i;
const SECRET_VALUE: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[\w-]{5,}\.eyJ[\w-]{5,}\.[\w-]{5,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

export function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return SECRET_VALUE.some((re) => re.test(value));
  if (Array.isArray(value)) return value.some(containsSecret);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => SECRET_KEY.test(k) || containsSecret(v));
  }
  return false;
}

export function assertNoSecrets(value: unknown, where = "contenu"): void {
  if (containsSecret(value)) throw new MemorySecretRejectedError(where);
}

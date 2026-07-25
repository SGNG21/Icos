import type { ActivationState, TrustState } from "@/core/contracts/skill";

// ─────────────────────────────────────
// TrustState transitions
// ─────────────────────────────────────

const allowedTrustTransitions: Record<TrustState, readonly TrustState[]> = {
  untrusted: ["quarantined"],
  quarantined: ["reviewed", "rejected"],
  reviewed: ["approved", "rejected"],
  approved: ["rejected"],
  rejected: [],
};

/**
 * Vérifie si la transition TrustState `from → to` est autorisée.
 * `rejected` est terminal : aucune transition sortante.
 */
export function isTrustTransitionAllowed(from: TrustState, to: TrustState): boolean {
  return (allowedTrustTransitions[from] ?? []).includes(to);
}

// ─────────────────────────────────────
// ActivationState transitions
// ─────────────────────────────────────

const allowedActivationTransitions: Record<ActivationState, readonly ActivationState[]> = {
  inactive: ["active", "revoked"],
  active: ["suspended", "inactive", "revoked"],
  suspended: ["active", "revoked"],
  revoked: [],
};

/**
 * Vérifie si la transition ActivationState `from → to` est autorisée.
 * `revoked` est terminal : aucune transition sortante.
 */
export function isActivationTransitionAllowed(
  from: ActivationState,
  to: ActivationState,
): boolean {
  return (allowedActivationTransitions[from] ?? []).includes(to);
}

// ─────────────────────────────────────
// Cross-invariants
// ─────────────────────────────────────

/**
 * CROSS-I-1 : activationState = active ⇒ trustState = approved.
 * Vérifie qu'un état (trust, activation) est valide.
 */
export function isStateValid(trustState: TrustState, activationState: ActivationState): boolean {
  // Si activé, le trust doit être approved.
  if (activationState === "active" && trustState !== "approved") {
    return false;
  }
  // Si rejeté, l'activation doit être revoked.
  if (trustState === "rejected" && activationState !== "revoked") {
    return false;
  }
  return true;
}

/**
 * Calcule l'ActivationState cible lorsqu'un TrustState passe à `rejected`.
 * Règle : rejected ⇒ activationState = revoked (CROSS-I-2).
 * Pour tout trustState courant, retourne 'revoked'.
 */
export function resolveActivationOnReject(): ActivationState {
  return "revoked";
}

// ─────────────────────────────────────
// Content mutability
// ─────────────────────────────────────

import { CONTENT_IMMUTABLE_TRUST_STATES, CONTENT_MUTABLE_TRUST_STATES } from "@/core/contracts/skill";

/**
 * Vrai si le contenu du skill peut être modifié dans cet état de trust.
 */
export function isContentMutable(trustState: TrustState): boolean {
  return (CONTENT_MUTABLE_TRUST_STATES as readonly TrustState[]).includes(trustState);
}

/**
 * Vrai si le contenu du skill est immuable dans cet état de trust.
 */
export function isContentImmutable(trustState: TrustState): boolean {
  return (CONTENT_IMMUTABLE_TRUST_STATES as readonly TrustState[]).includes(trustState);
}

// ─────────────────────────────────────
// Stale attestation
// ─────────────────────────────────────

/**
 * Vérifie si une attestation (scan/eval) est valable pour une promotion.
 * Condition : evaluatedContentHash === currentContentHash.
 */
export function isAttestationValid(
  evaluatedContentHash: string,
  currentContentHash: string,
): boolean {
  return evaluatedContentHash === currentContentHash;
}

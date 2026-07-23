import type { Capability, CapabilityStatus } from "@/core/contracts/capability";

/**
 * Transitions autorisées du cycle de vie d'une capacité.
 * `retired` est terminal : aucun retour possible.
 */
const allowedTransitions: Record<CapabilityStatus, readonly CapabilityStatus[]> = {
  proposed: ["active"],
  active: ["deprecated", "retired"],
  deprecated: ["active", "retired"],
  retired: [],
};

/** Vrai si la transition `from → to` est autorisée. */
export function isTransitionAllowed(from: CapabilityStatus, to: CapabilityStatus): boolean {
  return (allowedTransitions[from] ?? []).includes(to);
}

type ResolveResult =
  | { usable: true; capability: Capability }
  | { usable: false; reason: "unknown" | "not_active" };

/**
 * Résolution pure d'usabilité : répond uniquement à la question
 * « cette capacité est-elle actuellement utilisable ».
 *
 * - inconnue (null) → `{ usable: false, reason: "unknown" }`
 * - non active → `{ usable: false, reason: "not_active" }`
 * - active → `{ usable: true, capability }`
 *
 * Ne déclenche aucune exécution. L'Orchestrateur (hors C1) consommera
 * cette primitive plus tard.
 */
export async function resolveActiveCapability(
  key: string,
  lookup: (key: string) => Promise<Capability | null>,
): Promise<ResolveResult> {
  const capability = await lookup(key);

  if (capability === null) {
    return { usable: false, reason: "unknown" };
  }

  if (capability.status !== "active") {
    return { usable: false, reason: "not_active" };
  }

  return { usable: true, capability };
}

import {
  missionContextSchema,
  type MissionContext,
} from "@/core/context/contract";

import type { SaveConflictReason } from "./ports";

/**
 * Validation PURE et partagée du couple `(context, expectedVersion)`, commune
 * aux adaptateurs in-memory et PostgreSQL pour garantir une sémantique
 * strictement identique (parité testée).
 *
 * Ne consulte PAS l'état persisté : ne couvre que ce qui est décidable à partir
 * des seules entrées (schéma strict + cohérence de version du payload). La
 * comparaison au latest réel (`stale_version`) et la course d'unicité
 * (`version_conflict`) restent à la charge de chaque adaptateur.
 */
export type ValidateSaveResult =
  | { ok: true; context: MissionContext }
  | { ok: false; reason: Extract<SaveConflictReason, "invalid_context" | "version_mismatch"> };

export function validateSaveInput(
  context: MissionContext,
  expectedVersion: number | null,
): ValidateSaveResult {
  // 1. Schéma strict : rejette tout champ superflu (dont un champ ressemblant à
  //    une autorité), tout dépassement de bornes, toute valeur non sérialisable.
  //    Fail-closed : on ne dépouille jamais, on refuse.
  const parsed = missionContextSchema.safeParse(context);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_context" };
  }

  // 2. Cohérence de version du payload : le contexte doit porter EXACTEMENT
  //    `(expectedVersion ?? -1) + 1`. Interdit trous et régressions.
  const requiredVersion = (expectedVersion ?? -1) + 1;
  if (parsed.data.version !== requiredVersion) {
    return { ok: false, reason: "version_mismatch" };
  }

  return { ok: true, context: parsed.data };
}

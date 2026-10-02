import { UNMETERED, type UnmeteredReason, type UsageOutcome } from "./contracts";

/**
 * Lecture du bloc `usage` d'une réponse OpenAI-compatible (OmniRoute en renvoie un sur
 * chaque complétion ; ICOS le jetait).
 *
 * Tout ce qui n'est pas un décompte entier, positif et cohérent rend UNMETERED avec un motif.
 * On ne devine pas, on ne complète pas, on ne remplace pas par 0.
 */

/**
 * Au-delà, un « décompte » n'est plus un décompte : aucun fournisseur ne facture 10^9 tokens
 * sur un seul appel. Borne de plausibilité, pas une limite de produit.
 */
export const MAX_PLAUSIBLE_TOKENS_PER_CALL = 1_000_000_000;

const unmetered = (reason: UnmeteredReason): UsageOutcome => ({ kind: UNMETERED, reason });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `undefined` = champ absent, `null` = champ présent mais invalide. */
function tokenCount(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function readUsage(body: unknown): UsageOutcome {
  if (!isPlainObject(body)) return unmetered("NON_JSON_BODY");

  const raw = body.usage;
  if (!isPlainObject(raw)) return unmetered("USAGE_ABSENT");

  const prompt = tokenCount(raw.prompt_tokens);
  const completion = tokenCount(raw.completion_tokens);
  const total = tokenCount(raw.total_tokens);

  if (prompt === undefined || completion === undefined) return unmetered("USAGE_INCOMPLETE");
  if (prompt === null || completion === null || total === null) return unmetered("USAGE_INVALID");

  const sum = prompt + completion;
  /**
   * Un total supérieur à la somme est légitime (tokens de raisonnement, tokens cachés
   * facturés séparément) : on garde celui du fournisseur, c'est lui qui facture.
   * Un total inférieur est incohérent : on refuse de mesurer.
   */
  if (total !== undefined && total < sum) return unmetered("USAGE_INCONSISTENT");
  const totalTokens = total ?? sum;

  if (
    prompt > MAX_PLAUSIBLE_TOKENS_PER_CALL ||
    completion > MAX_PLAUSIBLE_TOKENS_PER_CALL ||
    totalTokens > MAX_PLAUSIBLE_TOKENS_PER_CALL
  ) {
    return unmetered("USAGE_IMPLAUSIBLE");
  }

  return {
    kind: "METERED",
    usage: { promptTokens: prompt, completionTokens: completion, totalTokens },
  };
}

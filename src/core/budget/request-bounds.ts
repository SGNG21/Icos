/**
 * BORNER UNE REQUÊTE DE COMPLÉTION AVANT DE L'ÉMETTRE (verrou C1). Pur : ni fetch, ni base.
 *
 * ── CE QUI ÉTAIT CASSÉ ──────────────────────────────────────────────────────────────────
 * Le contrôle pré-vol n'examinait que la fenêtre HISTORIQUE. Une fenêtre vide passe donc
 * `decide()`, et le planificateur n'envoyait AUCUNE limite de sortie : sous un plafond de
 * 1 000 tokens, le tout premier appel partait sans borne et pouvait à lui seul le franchir,
 * largement, avant que quoi que ce soit ne soit mesuré. Le prix et la consommation n'étaient
 * découverts qu'APRÈS la réponse du fournisseur, c'est-à-dire après avoir payé.
 *
 * ── CE QUE CE FICHIER ÉTABLIT ───────────────────────────────────────────────────────────
 * Une MAJORATION de ce que l'appel peut consommer, connue AVANT l'émission, donc réservable.
 * Deux termes :
 *
 *   sortie  — `max_tokens` écrit DANS le corps. Absent, il est injecté ; présent, il est
 *             RABAISSÉ au plafond et jamais relevé (réduction seule). Une valeur présente mais
 *             absurde n'est pas corrigée en silence : la requête devient non bornable, donc
 *             refusée.
 *
 *   entrée  — la TAILLE EN OCTETS du corps. Ce n'est pas une estimation : dans tout tokenizer
 *             BPE sur de l'UTF-8, un token consomme AU MOINS un octet, donc
 *             `tokens(prompt) <= octets(prompt) <= octets(corps)`. C'est donc une vraie borne
 *             supérieure, pas un `longueur / 4` qui peut SOUS-estimer — et sous-estimer ici
 *             rouvrirait le dépassement que la réservation existe pour fermer.
 *
 * Sur-réserver coûte de la DISPONIBILITÉ (un refus), jamais un dépassement silencieux. C'est
 * le sens du choix : on préfère refuser un appel qui serait passé plutôt que laisser passer un
 * appel qu'on n'a pas su borner.
 *
 * ponytail: la borne en octets sur-réserve l'entrée d'un facteur ~3 à 4 sur du texte latin. Si
 * cela produit des refus mesurables, remplacer `promptCeilingTokens` par un vrai tokenizer
 * (`tiktoken`/`gpt-tokenizer`) — mais JAMAIS par une heuristique qui peut sous-estimer.
 */

/**
 * Sortie maximale quand l'appelant n'en déclare aucune. Ce n'est pas « la bonne valeur » :
 * c'est le plafond au-delà duquel ICOS refuse de laisser un appelant muet dépenser. Le
 * plafond du goal reste ce qui décide réellement — celui-ci borne seulement l'INCONNU.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

/**
 * Marge pour les tokens que le gabarit de conversation du fournisseur ajoute lui-même
 * (balises de rôle, amorces) et qui ne sont dans aucun octet du corps. Majorée largement :
 * une marge trop grande refuse un appel, une marge trop petite le laisse déborder.
 */
export const CHAT_TEMPLATE_HEADROOM_TOKENS = 256;

export type BoundedRequest =
  | {
      readonly kind: "BOUNDED";
      /** Le corps à émettre RÉELLEMENT, avec sa limite de sortie écrite dedans. */
      readonly body: string;
      readonly maxOutputTokens: number;
      readonly promptCeilingTokens: number;
      /** Ce qu'il faut réserver pour que l'appel ne puisse pas dépasser : entrée + sortie. */
      readonly reservedTokens: number;
    }
  | { readonly kind: "UNBOUNDABLE"; readonly detail: string };

/** Entier strictement positif, ou rien. Une valeur douteuse n'est jamais « corrigée ». */
function declaredLimit(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}

/**
 * Rend le corps BORNÉ, ou dit pourquoi il ne peut pas l'être. Fermé par défaut : tout ce qui
 * n'est pas un corps JSON lisible est non bornable, donc refusé en amont — on ne laisse pas
 * partir un appel dont on ne sait pas écrire la limite.
 */
export function boundCompletionBody(body: unknown, ceiling: number): BoundedRequest {
  if (!(Number.isSafeInteger(ceiling) && ceiling > 0)) {
    return { kind: "UNBOUNDABLE", detail: `plafond de sortie inexploitable : ${String(ceiling)}` };
  }
  if (typeof body !== "string") {
    /* `Request`, flux, FormData : on ne peut pas y écrire de limite sans le consommer. */
    return { kind: "UNBOUNDABLE", detail: "corps de requête non lisible comme chaîne JSON" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "UNBOUNDABLE", detail: "corps de requête illisible comme JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "UNBOUNDABLE", detail: "corps de requête qui n'est pas un objet JSON" };
  }

  const payload = parsed as Record<string, unknown>;
  const declared = [
    declaredLimit(payload.max_tokens),
    declaredLimit(payload.max_completion_tokens),
  ];
  if (declared.includes(null)) {
    return {
      kind: "UNBOUNDABLE",
      detail: "limite de sortie déclarée mais inexploitable : on ne la corrige pas en silence",
    };
  }

  /* RÉDUCTION SEULE : une limite déclarée peut baisser, jamais monter. */
  const asked = declared.filter((v): v is number => typeof v === "number");
  const maxOutputTokens = asked.length === 0 ? ceiling : Math.min(...asked, ceiling);

  payload.max_tokens = maxOutputTokens;
  /* Ne jamais INTRODUIRE la seconde orthographe : la rabaisser seulement si elle existait. */
  if (payload.max_completion_tokens !== undefined) payload.max_completion_tokens = maxOutputTokens;

  const bounded = JSON.stringify(payload);
  const promptCeilingTokens = Buffer.byteLength(bounded, "utf8") + CHAT_TEMPLATE_HEADROOM_TOKENS;
  const reservedTokens = promptCeilingTokens + maxOutputTokens;
  if (!Number.isSafeInteger(reservedTokens)) {
    return { kind: "UNBOUNDABLE", detail: "majoration de consommation non représentable" };
  }

  return { kind: "BOUNDED", body: bounded, maxOutputTokens, promptCeilingTokens, reservedTokens };
}

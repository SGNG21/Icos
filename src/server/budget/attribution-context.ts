import { AsyncLocalStorage } from "node:async_hooks";

import type { Attribution } from "@/core/budget/contracts";

/**
 * IMPUTATION AMBIANTE — le seul contexte d'exécution de `src`, et il ne sert qu'à ça.
 *
 * Le problème qu'il résout : les adaptateurs OmniRoute sont construits UNE fois, au montage
 * du conteneur, alors qu'un budget appartient à un goal connu seulement au moment de l'appel.
 * Un `meteredFetch` construit avec une imputation figée mesurerait donc tous les appels sous
 * la même imputation — c'est-à-dire sous aucune.
 *
 * Les deux autres solutions ont été écartées :
 *   - passer une imputation en paramètre à travers planificateur, runner, superviseur et
 *     adaptateur : cinq signatures modifiées pour une donnée qu'aucune de ces couches ne
 *     possède ni n'utilise ;
 *   - une variable de module : un seul emplacement partagé par toutes les missions
 *     simultanées, donc une imputation fausse dès la deuxième.
 *
 * RÈGLE : hors de toute portée, la lecture rend `null` — une ABSENCE, jamais une imputation
 * fabriquée. C'est ce `null` que le résolveur de plafond refuse, et c'est voulu : un appel
 * dont on ne sait pas à qui il est imputé ne peut pas être prouvé sous un budget.
 */

const storage = new AsyncLocalStorage<Attribution>();

/**
 * Exécute `fn` en imputant à `attribution` tout appel mesuré qui en descend, y compris à
 * travers les `await` et les promesses créées dedans. Les portées s'imbriquent : la plus
 * interne gagne, et la portée extérieure est rétablie à la sortie.
 */
export function runWithAttribution<T>(attribution: Attribution, fn: () => T): T {
  return storage.run(attribution, fn);
}

/** L'imputation courante, ou `null` hors de toute portée. Rien n'est deviné ici. */
export function currentAttribution(): Attribution | null {
  return storage.getStore() ?? null;
}

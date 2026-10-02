import { currentAttribution } from "./attribution-context";
import { createGoalBudgetCapResolver } from "./goal-budget-cap-resolver";
import { InMemorySpendLedger } from "./in-memory-spend-ledger";
import { meteredFetch } from "./metered-fetch";
import type { BudgetCapResolver, SpendLedgerPort } from "./ports";
import { PostgresSpendLedger, type SqlExec } from "./postgres-spend-ledger";

/**
 * COMPOSITION du compteur de dépense : ce fichier choisit le journal et LE PLAFOND PAR
 * COUTURE. Il n'invente aucune règle — `decide`, `accumulate`, `priceUsage` et le résolveur
 * de budget de goal restent les seules autorités.
 *
 * ── LA POLITIQUE PAR COUTURE (c'est une décision, pas une mécanique) ────────────────────
 * Un budget gouverne le TRAVAIL DE MISSION. Les frais opérationnels n'en relèvent pas, et
 * les deux ne peuvent donc pas partager un plafond :
 *
 *   `mission`  — complétions émises pour le compte d'un goal (planification d'une mission).
 *                Plafond = {@link createGoalBudgetCapResolver}, donc `goals.budget`.
 *                L'imputation est lue dans la PORTÉE AMBIANTE à chaque appel (voir plus bas).
 *
 *   `overhead` — sondes de santé des workers et découverte de modèles (`/v1/models`).
 *                Plafond = {@link UNCAPPED_OVERHEAD}, SANS plafond, CHOISI PAR SON NOM.
 *                Pourquoi ce n'est pas de la dépense de mission : ces appels partent d'un
 *                minuteur, sans goal, pour établir quelle flotte existe. Les plafonner sous
 *                le budget d'un goal ferait d'un budget épuisé une PANNE DE FLOTTE (plus
 *                aucune sonde, donc plus aucun worker sain, donc plus aucun dispatch) — le
 *                budget d'un propriétaire détruirait la santé du système. Et comme le
 *                résolveur de goal REFUSE délibérément le trafic non imputé, y faire passer
 *                une sonde ne la plafonnerait pas : ça l'arrêterait, toujours.
 *                Ces appels sont donc MESURÉS (ils sont visibles dans le journal) et
 *                enregistrés SANS imputation : ils ne doivent pas consommer la fenêtre d'un
 *                goal qui n'en est pas responsable.
 *
 * Aucune couture n'est « sans plafond » par absence, par `??` ou par défaut : `BudgetCap`
 * est une union discriminée pour que `UNCAPPED` soit écrit quelque part, une fois, avec sa
 * raison.
 */

/**
 * CLÉ TENANT de `spend_ledger`, déclarée ici parce que le conteneur n'a AUCUN contexte
 * tenant : il est monté une fois pour le processus, pas par requête, et `goals` ne porte pas
 * de `tenant_id` (voir `goal-budget-cap-resolver.ts`). La dépense de mission est donc
 * aujourd'hui une dépense de holding, écrite et relue sous cette seule clé — ce qui rend la
 * fenêtre cohérente, puisque lecture et écriture utilisent la même.
 *
 * PLAFOND ASSUMÉ : si ICOS devient multi-tenant côté goals, cette constante doit devenir le
 * tenant DU GOAL imputé, sinon deux tenants partageraient une fenêtre. C'est un seul endroit
 * à changer, et rien d'autre ne connaît cette valeur.
 */
export const SPEND_LEDGER_TENANT_ID = "icos-holding";

/**
 * SANS PLAFOND, PAR CHOIX EXPLICITE, pour les frais opérationnels seulement. La raison est
 * dans l'en-tête de ce fichier. Ce n'est pas un défaut : c'est la seule valeur `UNCAPPED`
 * du dépôt, et elle est nommée.
 */
export const UNCAPPED_OVERHEAD: BudgetCapResolver = async () => ({ kind: "UNCAPPED" });

/**
 * Pas de base de données = aucun `goals.budget` lisible = aucun plafond établi. `CAPPED`
 * sans limite, donc `decide` refuse en `NO_ENFORCEABLE_CAP`. L'absence de base ne devient
 * JAMAIS « pas de budget » : elle devient « budget invérifiable », donc refus.
 */
const NO_GOAL_SOURCE: BudgetCapResolver = async () => ({ kind: "CAPPED" });

/**
 * Lit l'imputation dans la portée ambiante À CHAQUE APPEL, au lieu de celle figée à la
 * construction. `meteredFetch` reçoit son imputation dans ses dépendances, donc une seule
 * fois, au montage du conteneur — c'est-à-dire avant que le moindre goal existe. Ce
 * décorateur est l'endroit exact où cette contrainte se résout, et c'est pour ça qu'aucune
 * signature d'adaptateur n'a eu à changer.
 *
 * Il IGNORE volontairement l'imputation que l'appelant lui passe : il n'y en a qu'une de
 * vraie, celle de la portée en cours. Hors de toute portée elle vaut `null`, et le journal
 * refuse — l'absence n'est pas blanchie en « non plafonné ».
 */
export function ambientlyAttributed(ledger: SpendLedgerPort): SpendLedgerPort {
  return {
    checkBudget: () => ledger.checkBudget(currentAttribution()),
    record: (entry) => ledger.record({ ...entry, attribution: currentAttribution() }),
    windowFor: () => ledger.windowFor(currentAttribution()),
  };
}

export interface SpendLedgerSelection {
  readonly db?: SqlExec | undefined;
  readonly tenantId?: string;
  readonly caps: BudgetCapResolver;
}

/**
 * Le journal DURABLE quand le conteneur a une base, celui en mémoire sinon.
 *
 * Ce que signifie le journal en mémoire : la dépense est OUBLIÉE au redémarrage, donc une
 * boucle de crash repart d'une fenêtre vide. Il n'est choisi que là où le conteneur utilise
 * déjà des services en mémoire (aucune base, donc aucun `goals.budget` persisté à appliquer
 * de toute façon), et jamais comme repli silencieux d'une base indisponible : une base
 * présente mais illisible fait refuser le journal durable, elle ne le remplace pas.
 */
export function createSpendLedger(selection: SpendLedgerSelection): SpendLedgerPort {
  if (!selection.db) return new InMemorySpendLedger({ caps: selection.caps });
  return new PostgresSpendLedger({
    db: selection.db,
    tenantId: selection.tenantId ?? SPEND_LEDGER_TENANT_ID,
    caps: selection.caps,
  });
}

export interface ComposeSpendOptions extends Omit<SpendLedgerSelection, "caps"> {
  /**
   * LE SEUL plafond réellement applicable aujourd'hui : la table de prix est vide, donc tout
   * appel est UNPRICED et aucun plafond monétaire ne peut être déclaré satisfait. Absent =
   * aucun plafond de tokens, et un goal sans budget monétaire n'a alors rien d'applicable,
   * donc ses appels sont refusés. Voir `goal-budget-cap-resolver.ts`.
   */
  readonly maxTotalTokensPerGoal?: number;
  /** Le `fetch` réellement émetteur. Injectable pour les tests, jamais muet en production. */
  readonly inner?: typeof fetch;
}

export interface SpendMeters {
  /** Travail de mission : plafonné par `goals.budget` du goal de la portée ambiante. */
  readonly mission: typeof fetch;
  /** Frais opérationnels : sans plafond par choix nommé, et enregistrés sans imputation. */
  readonly overhead: typeof fetch;
}

export function composeSpendMeters(options: ComposeSpendOptions = {}): SpendMeters {
  const inner = options.inner ?? ((input, init) => globalThis.fetch(input, init));
  const selection = { db: options.db, ...(options.tenantId ? { tenantId: options.tenantId } : {}) };

  const goalCaps = options.db
    ? createGoalBudgetCapResolver({
        db: options.db,
        ...(options.maxTotalTokensPerGoal === undefined
          ? {}
          : { maxTotalTokensPerGoal: options.maxTotalTokensPerGoal }),
      })
    : NO_GOAL_SOURCE;

  return {
    mission: meteredFetch(inner, {
      ledger: ambientlyAttributed(createSpendLedger({ ...selection, caps: goalCaps })),
    }),
    /* Aucune imputation transmise : ces lignes tombent dans la fenêtre non imputée. */
    overhead: meteredFetch(inner, {
      ledger: createSpendLedger({ ...selection, caps: UNCAPPED_OVERHEAD }),
    }),
  };
}

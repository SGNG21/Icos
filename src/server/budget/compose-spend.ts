import { currentAttribution } from "./attribution-context";
import { createGoalBudgetCapResolver } from "./goal-budget-cap-resolver";
import { InMemorySpendLedger } from "./in-memory-spend-ledger";
import { meteredFetch } from "./metered-fetch";
import type { BudgetCapResolver, SpendLedgerPort, SpendReservationPort } from "./ports";
import { PostgresSpendLedger, type SqlExec } from "./postgres-spend-ledger";
import { PostgresSpendReservations, type TxCapable } from "./postgres-spend-reservations";

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
 * PLAFOND PAR DÉFAUT DU BUDGET DE CONVERSATION, en tokens, PAR CONVERSATION.
 *
 * Pourquoi un défaut et pas un refus. Les frais opérationnels sont `UNCAPPED` parce que les
 * plafonner transformerait un budget épuisé en panne de flotte ; une conversation, elle,
 * doit être BORNÉE — c'est la décision du propriétaire — mais la borner par l'absence d'une
 * variable d'environnement ferait qu'ICOS refuserait de parler sur un déploiement par
 * défaut. Un défaut généreux reste une borne ; l'absence de borne n'en est pas une.
 *
 * 200 000 tokens : plusieurs heures de dialogue nourri sur une même conversation, et très
 * en-dessous de ce qu'une boucle emballée consommerait avant d'être remarquée.
 */
export const DEFAULT_CONVERSATION_MAX_TOTAL_TOKENS = 200_000;

/**
 * LE PLAFOND DE CONVERSATION. Une seule dimension, les TOKENS : la table de prix est vide,
 * donc un plafond monétaire ne serait satisfiable par aucun appel (voir `decide`).
 *
 * Il est PAR CONVERSATION et non global, pour la même raison que le budget d'exécution est
 * par goal : un plafond global ferait qu'une conversation bavarde fermerait la bouche d'ICOS
 * pour toutes les autres.
 */
export function conversationCaps(maxTotalTokens: number): BudgetCapResolver {
  return async (attribution) =>
    attribution?.conversationId
      ? { kind: "CAPPED", maxTotalTokens }
      : /* Hors conversation identifiée, rien à plafonner et rien à autoriser. */
        { kind: "CAPPED" };
}

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

/**
 * Même raison que {@link ambientlyAttributed}, pour les RÉSERVATIONS : le conteneur est monté
 * une fois pour le processus, bien avant qu'un goal existe, donc l'imputation d'une réservation
 * ne peut venir que de la portée en cours. Hors de toute portée elle vaut `null`, et le
 * résolveur de plafond refuse — l'absence n'est pas blanchie en « non plafonné ».
 *
 * `settle`, `renew` et `release` passent inchangés : ils s'authentifient sur la LIGNE de la
 * réservation, pas sur une imputation, ce qui est exactement le verrou C2.
 */
export function ambientlyReserved(port: SpendReservationPort): SpendReservationPort {
  return {
    reserve: (_attribution, requestedTokens) => port.reserve(currentAttribution(), requestedTokens),
    settle: (reservation, entry) => port.settle(reservation, entry),
    renew: (reservation) => port.renew(reservation),
    release: (reservation) => port.release(reservation),
  };
}

export interface SpendLedgerSelection {
  readonly db?: (SqlExec & TxCapable) | undefined;
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
  /** Plafond de tokens d'UNE conversation. Défaut : {@link DEFAULT_CONVERSATION_MAX_TOTAL_TOKENS}. */
  readonly maxTotalTokensPerConversation?: number;
  /** Le `fetch` réellement émetteur. Injectable pour les tests, jamais muet en production. */
  readonly inner?: typeof fetch;
  /** Durée du bail des réservations de mission. Défaut : celui du magasin. */
  readonly leaseMs?: number;
  /** Sortie maximale imposée à un appelant qui n'en déclare aucune (verrou C1). */
  readonly maxOutputTokens?: number;
}

export interface SpendMeters {
  /** Travail de mission : plafonné par `goals.budget` du goal de la portée ambiante. */
  readonly mission: typeof fetch;
  /** Frais opérationnels : sans plafond par choix nommé, et enregistrés sans imputation. */
  readonly overhead: typeof fetch;
  /**
   * CONVERSATION : parler à ICOS, comprendre une intention, retrouver du contexte, répondre.
   * Plafonné PAR CONVERSATION, et strictement séparé du budget d'exécution d'un goal : ce
   * trafic ne peut ni le consommer ni le contourner, parce que sa fenêtre est une autre clé
   * d'imputation (`conversation=…` au lieu de `goal=…`).
   */
  readonly conversation: typeof fetch;
}

/** LE plafond du travail de mission, en un seul endroit : `goals.budget` + plafond de tokens. */
function goalCapsFor(db: SqlExec, maxTotalTokensPerGoal: number | undefined): BudgetCapResolver {
  return createGoalBudgetCapResolver({
    db,
    ...(maxTotalTokensPerGoal === undefined ? {} : { maxTotalTokensPerGoal }),
  });
}

export interface ComposeSpendReservationsOptions {
  /** Doit savoir ouvrir une TRANSACTION : l'atomicité est en PostgreSQL, pas en mémoire. */
  readonly db: SqlExec & TxCapable;
  readonly tenantId?: string;
  readonly maxTotalTokensPerGoal?: number;
  readonly leaseMs?: number;
}

/**
 * Le magasin de RÉSERVATIONS du travail de mission, sous EXACTEMENT le même plafond que le
 * compteur `mission` ci-dessus — une seule politique, pas deux.
 *
 * À quoi il sert, et pourquoi il n'est pas branché ici. Réserver demande un montant de tokens
 * que seul le DISPATCHEUR connaît (ce qu'il accepte au maximum de payer pour une tâche) ;
 * `meteredFetch` ne l'a pas, et il n'y a pas de montant honnête à deviner à sa place. Le point
 * de branchement est donc la couture de dispatch, qui appartient à d'autres lots. Ce fichier
 * fournit l'objet prêt à l'emploi, avec sa politique de plafond déjà résolue.
 *
 * Pas de variante en mémoire : la propriété que ce port existe pour garantir est une propriété
 * de PostgreSQL. Une implémentation en mémoire en serait une imitation plus faible, et la
 * brancher par défaut rouvrirait exactement le trou qu'on ferme.
 */
export function composeSpendReservations(
  options: ComposeSpendReservationsOptions,
): SpendReservationPort {
  return new PostgresSpendReservations({
    db: options.db,
    tenantId: options.tenantId ?? SPEND_LEDGER_TENANT_ID,
    caps: goalCapsFor(options.db, options.maxTotalTokensPerGoal),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
  });
}

export function composeSpendMeters(options: ComposeSpendOptions = {}): SpendMeters {
  const inner = options.inner ?? ((input, init) => globalThis.fetch(input, init));
  const selection = { db: options.db, ...(options.tenantId ? { tenantId: options.tenantId } : {}) };

  const goalCaps = options.db
    ? goalCapsFor(options.db, options.maxTotalTokensPerGoal)
    : NO_GOAL_SOURCE;

  /*
   * RÉSERVATION AVANT DISPATCH SUR LA COUTURE DE MISSION (verrou C1).
   *
   * Sans base il n'y a aucune réservation possible, ET aucun `goals.budget` lisible : la
   * couture de mission tombe sur `NO_GOAL_SOURCE`, qui REFUSE tout appel imputé. Le mode sans
   * réservation n'est donc jamais un mode permissif ici — c'est un mode où rien ne passe.
   *
   * Avec une base, la réservation est OBLIGATOIRE : le contrôle pré-vol seul laissait partir
   * le premier appel d'un goal (fenêtre vide) sans aucune borne de sortie.
   */
  const conversationTokens =
    options.maxTotalTokensPerConversation ?? DEFAULT_CONVERSATION_MAX_TOTAL_TOKENS;

  const reservations = options.db
    ? composeSpendReservations({
        db: options.db,
        ...(options.tenantId ? { tenantId: options.tenantId } : {}),
        ...(options.maxTotalTokensPerGoal === undefined
          ? {}
          : { maxTotalTokensPerGoal: options.maxTotalTokensPerGoal }),
        ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      })
    : undefined;

  const conversationReservations = options.db
    ? new PostgresSpendReservations({
        db: options.db,
        tenantId: options.tenantId ?? SPEND_LEDGER_TENANT_ID,
        caps: conversationCaps(conversationTokens),
        ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      })
    : undefined;

  return {
    mission: meteredFetch(inner, {
      ledger: ambientlyAttributed(createSpendLedger({ ...selection, caps: goalCaps })),
      ...(reservations ? { reservations: ambientlyReserved(reservations) } : {}),
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
    }),
    /*
     * Aucune imputation transmise : ces lignes tombent dans la fenêtre non imputée. Aucune
     * réservation non plus — cette couture est `UNCAPPED` par choix nommé, donc il n'y a
     * rien à engager, et un aller-retour en base par sonde de santé serait du coût pur.
     */
    overhead: meteredFetch(inner, {
      ledger: createSpendLedger({ ...selection, caps: UNCAPPED_OVERHEAD }),
    }),
    /*
     * CONVERSATION. Même mécanique que la mission — imputation ambiante, réservation avant
     * dispatch, sortie bornée — mais une AUTRE clé et un AUTRE plafond. L'isolation n'est
     * pas une règle qu'on applique : c'est la conséquence de `attributionKey`, qui range
     * `conversation=…` et `goal=…` dans deux fenêtres qui ne se rencontrent jamais.
     */
    conversation: meteredFetch(inner, {
      ledger: ambientlyAttributed(
        createSpendLedger({ ...selection, caps: conversationCaps(conversationTokens) }),
      ),
      ...(conversationReservations
        ? { reservations: ambientlyReserved(conversationReservations) }
        : {}),
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
    }),
  };
}

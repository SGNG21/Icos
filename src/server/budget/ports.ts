import type {
  Attribution,
  BudgetCap,
  DenyReason,
  SpendDecision,
  UsageOutcome,
} from "@/core/budget/contracts";
import type { Settlement, SpendWindow } from "@/core/budget/spend";

/**
 * Port du compteur de dépense (verrou d'autonomie B1).
 *
 * `goals.budget` est persisté mais n'a jamais été appliqué. Ce port est le point
 * d'application : une implémentation en mémoire existe pour les tests et le développement,
 * une implémentation PostgreSQL durable est le travail d'un autre lot. Ce fichier ne définit
 * que le contrat — il n'y a ici ni SQL, ni migration, ni Drizzle.
 */

export interface SpendEntry {
  /** Modèle réellement facturé, tel que rapporté par le fournisseur quand il le rapporte. */
  readonly modelId: string;
  /** METERED ou UNMETERED. Jamais un 0 de substitution. */
  readonly usage: UsageOutcome;
  /** `null` = appel non attribué. On l'enregistre tel quel, on n'en invente pas une. */
  readonly attribution: Attribution | null;
  /** Horodatage ISO de l'observation. */
  readonly at: string;
}

export interface SpendLedgerPort {
  /**
   * Contrôle PRÉ-vol : appelé AVANT d'émettre l'appel. Un DENY doit empêcher l'appel.
   * Fermé par défaut : une dépense invérifiable est un refus, pas une autorisation.
   */
  checkBudget(attribution: Attribution | null): Promise<SpendDecision>;

  /** Enregistre une observation, mesurée ou non. */
  record(entry: SpendEntry): Promise<void>;

  /**
   * Fenêtre accumulée pour cette imputation, pour rapport. Un appel UNPRICED n'est pas
   * gratuit : il apparaît dans `unpricedCalls` et dans les tokens, jamais dans `amount`.
   */
  windowFor(attribution: Attribution | null): Promise<SpendWindow>;
}

/**
 * D'où vient le plafond d'une imputation (`goals.budget` pour un goal). Une fonction suffit :
 * créer un port à une seule méthode pour cela n'apporterait rien.
 */
export type BudgetCapResolver = (attribution: Attribution | null) => Promise<BudgetCap>;

/** Un engagement de tokens accordé AVANT dispatch. `ownerToken` est le jeton de clôture. */
export interface SpendReservation {
  readonly id: string;
  /** Jeton de fencing : seul son porteur peut solder cette réservation. */
  readonly ownerToken: string;
  readonly reservedTokens: number;
}

/**
 * Ce qu'un appelant sait d'une dépense au moment de solder : le modèle, la consommation
 * mesurée, l'instant. PAS l'imputation (verrou C2).
 *
 * `SpendEntry` porte une `attribution` fournie par l'appelant. Au solde, c'est une
 * REDIRECTION : rien n'empêchait de réserver sur le goal A puis d'imputer la dépense au
 * goal B, et le plafond de A n'aurait jamais bougé. L'imputation d'un solde est donc
 * désormais celle de la RÉSERVATION, relue en base sous le même verrou, et le type la rend
 * INEXPRIMABLE côté appelant — pas seulement « ignorée par l'implémentation actuelle ».
 */
export type SettleEntry = Omit<SpendEntry, "attribution">;

export type ReserveOutcome =
  | { readonly kind: "RESERVED"; readonly reservation: SpendReservation }
  | { readonly kind: "DENY"; readonly reason: DenyReason; readonly detail: string };

/** Ce que le solde a réellement fait, y compris quand la réservation avait déjà expiré. */
export interface SettlementOutcome extends Settlement {
  /**
   * `false` = la réservation n'était plus OPEN (bail expiré, ou déjà soldée). La dépense
   * RÉELLE est enregistrée au journal dans tous les cas : la vérité d'une dépense ne dépend
   * pas de l'état de sa réservation.
   */
  readonly closed: boolean;
  /**
   * L'imputation RÉELLEMENT écrite au journal, relue depuis la ligne de réservation sous le
   * verrou. `null` = l'ID de réservation est inconnu : la dépense est alors enregistrée NON
   * IMPUTÉE, parce qu'on ne peut ni l'inventer ni la taire. C'est ce champ qui rend observable
   * qu'aucune redirection n'a eu lieu.
   */
  readonly attributedTo: Attribution | null;
  /** `true` = aucune ligne ne porte cet ID dans ce tenant. Un mauvais JETON ne met pas ceci
   * à `true` : la dépense reste imputée à son goal, elle n'est simplement pas close. */
  readonly unauthenticated: boolean;
}

/**
 * RÉSERVATION PUIS SOLDE (verrou P0-D). Ce port n'est PAS un second journal : la dépense
 * réelle reste celle de {@link SpendLedgerPort}, et seules les réservations VIVANTES sont
 * comptées ici. Il existe parce qu'un contrôle pré-vol ne borne qu'« un appel par appelant
 * simultané », donc rien du tout quand on multiplie les workers.
 */
export interface SpendReservationPort {
  /**
   * Engage `requestedTokens` sur le budget de l'imputation, ATOMIQUEMENT. Une réservation qui
   * ferait franchir le plafond est REFUSÉE en entier — jamais rognée en silence.
   */
  reserve(attribution: Attribution | null, requestedTokens: number): Promise<ReserveOutcome>;

  /**
   * Solde la réservation sur la consommation RÉELLE : écrit l'observation au journal, rend le
   * reliquat non consommé et dit le dépassement éventuel. L'imputation est celle de la
   * réservation, JAMAIS une imputation fournie ici — voir {@link SettleEntry}.
   */
  settle(reservation: SpendReservation, entry: SettleEntry): Promise<SettlementOutcome>;

  /**
   * PROLONGE le bail d'une réservation VIVANTE (verrou C3). Un appel de complétion qui dure
   * plus longtemps que `leaseMs` verrait sinon son propre engagement cesser d'être compté
   * alors qu'il dépense encore : le plafond autoriserait alors une seconde fois le même
   * budget. Le battement de cœur est tenu par l'appelant, qui est le seul à savoir que son
   * appel est encore vivant.
   *
   * Un bail DÉJÀ ÉCHU n'est jamais ressuscité : le budget qu'il tenait a pu être réattribué
   * entre-temps, et le rallonger ferait exister deux fois la même allocation. Rendre `false`
   * dit à l'appelant qu'il n'est plus propriétaire de son engagement.
   */
  renew(reservation: SpendReservation): Promise<boolean>;

  /**
   * REND un engagement sans aucune dépense (verrou C3) : erreur réseau, réponse non 2xx,
   * annulation. Sans lui le budget resterait engagé jusqu'à l'échéance du bail, donc une
   * rafale d'erreurs gèlerait le goal pour dix minutes. N'écrit RIEN au journal : il n'y a
   * pas eu de dépense à enregistrer.
   */
  release(reservation: SpendReservation): Promise<boolean>;
}

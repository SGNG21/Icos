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
   * reliquat non consommé et dit le dépassement éventuel.
   */
  settle(reservation: SpendReservation, entry: SpendEntry): Promise<SettlementOutcome>;
}

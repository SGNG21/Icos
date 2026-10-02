import type { Attribution, BudgetCap, SpendDecision, UsageOutcome } from "@/core/budget/contracts";
import type { SpendWindow } from "@/core/budget/spend";

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

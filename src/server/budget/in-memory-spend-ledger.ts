import {
  attributionKey,
  UNMETERED,
  type Attribution,
  type SpendDecision,
} from "@/core/budget/contracts";
import { ICOS_PRICE_TABLE, priceUsage, type PriceTable } from "@/core/budget/price-table";
import { accumulate, decide, emptyWindow, type SpendWindow } from "@/core/budget/spend";

import type { BudgetCapResolver, SpendEntry, SpendLedgerPort } from "./ports";

/**
 * Compteur de dépense en mémoire. Non durable : il perd tout au redémarrage du processus.
 * C'est l'implémentation de test et de développement ; la durabilité PostgreSQL est un
 * autre lot. Il ne touche aucune base.
 */

export interface InMemorySpendLedgerOptions {
  readonly caps: BudgetCapResolver;
  readonly priceTable?: PriceTable;
}

export class InMemorySpendLedger implements SpendLedgerPort {
  private readonly windows = new Map<string, SpendWindow>();
  private readonly log: SpendEntry[] = [];
  private readonly priceTable: PriceTable;

  constructor(private readonly options: InMemorySpendLedgerOptions) {
    this.priceTable = options.priceTable ?? ICOS_PRICE_TABLE;
  }

  async checkBudget(attribution: Attribution | null): Promise<SpendDecision> {
    const window = this.windows.get(attributionKey(attribution)) ?? emptyWindow();
    try {
      return decide(window, await this.options.caps(attribution));
    } catch (cause) {
      /* Plafond introuvable = plafond inconnu = refus. Jamais une autorisation par défaut. */
      return {
        kind: "DENY",
        reason: "NO_ENFORCEABLE_CAP",
        detail: `plafond non résolu : ${cause instanceof Error ? cause.message : "cause inconnue"}`,
      };
    }
  }

  async record(entry: SpendEntry): Promise<void> {
    const key = attributionKey(entry.attribution);
    const cost =
      entry.usage.kind === UNMETERED
        ? undefined
        : priceUsage(this.priceTable, entry.modelId, entry.usage.usage);
    this.windows.set(
      key,
      accumulate(this.windows.get(key) ?? emptyWindow(), {
        modelId: entry.modelId,
        usage: entry.usage,
        ...(cost === undefined ? {} : { cost }),
      }),
    );
    this.log.push(entry);
  }

  async windowFor(attribution: Attribution | null): Promise<SpendWindow> {
    return this.windows.get(attributionKey(attribution)) ?? emptyWindow();
  }

  /** Inspection pour les tests. Hors port. */
  entries(): readonly SpendEntry[] {
    return [...this.log];
  }
}

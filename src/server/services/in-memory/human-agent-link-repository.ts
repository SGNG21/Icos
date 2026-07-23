import type { HumanAgentLink } from "@/core/identity";
import type { HumanAgentLinkRepository } from "@/server/repositories/ports";

/**
 * Repository mémoire des rattachements humains-agents : toujours vide.
 * La gestion des liens réels est exclusivement PostgreSQL ; cette
 * implémentation sert uniquement à satisfaire le port dans le container
 * mémoire, où `OperationalAccessService` reçoit un set vide.
 */
export class InMemoryHumanAgentLinkRepository implements HumanAgentLinkRepository {
  async listForHuman(_humanUserId: string): Promise<HumanAgentLink[]> {
    return [];
  }

  async listAgentIdsForHuman(_humanUserId: string): Promise<ReadonlySet<string>> {
    return new Set();
  }
}

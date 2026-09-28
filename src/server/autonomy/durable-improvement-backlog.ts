import type { DurableMemory } from "@/core/context/durable-memory";
import type {
  ImprovementBacklog,
  ImprovementCandidate,
} from "@/core/autonomy/improvement-backlog";
import { sortCandidatesForSelection } from "@/core/autonomy/improvement-backlog";

/**
 * A DURABLE improvement backlog, stored as context items (M11, defect 25 link 3).
 *
 * Only `InMemoryImprovementBacklog` existed, which is fine for a unit test and useless for
 * self-development: a restart would lose every candidate, so ICOS could not remember what it
 * had decided to improve or that it was already improving it. "Durable provenance from
 * candidate through plan" starts here.
 *
 * WHY CONTEXT ITEMS AND NOT A NEW TABLE
 * `DurableMemory` already provides a durable, queryable, mission-scoped store with a
 * PostgreSQL implementation. A candidate is a small record with a stable id and no relational
 * obligations, so a dedicated table and migration would buy nothing but another schema to
 * keep in step. If candidates later need relational queries, that is the moment for a table.
 *
 * ponytail: a linear scan over one `type`, which is right for a backlog holding tens of
 * candidates and wrong at thousands. A dedicated table with indexes is the upgrade path.
 */

/** The single scope and type this backlog occupies in durable memory. */
export const IMPROVEMENT_CANDIDATE_TYPE = "improvement-candidate";
/** Context items require a missionId; a backlog belongs to no single mission. */
export const BACKLOG_PARTITION = "self-development-backlog";

export class DurableImprovementBacklog implements ImprovementBacklog {
  constructor(private readonly memory: DurableMemory) {}

  async add(candidate: ImprovementCandidate): Promise<void> {
    await this.write(candidate);
  }

  async update(candidate: ImprovementCandidate): Promise<void> {
    /*
     * Same id, so a save REPLACES rather than appends. Update and add are deliberately the
     * same operation: a backlog whose update could silently create a second copy of a
     * candidate would break the one guarantee the chain owner depends on — that an
     * improvement has exactly one record.
     */
    await this.write(candidate);
  }

  async get(id: string): Promise<ImprovementCandidate | null> {
    const all = await this.readAll();
    return all.find((candidate) => candidate.id === id) ?? null;
  }

  async list(query: Parameters<ImprovementBacklog["list"]>[0] = {}): Promise<ImprovementCandidate[]> {
    let results = await this.readAll();

    if (query.status) results = results.filter((c) => c.status === query.status);
    if (query.category) results = results.filter((c) => c.category === query.category);
    if (query.targetComponent) {
      results = results.filter((c) => c.targetComponent === query.targetComponent);
    }
    if (query.priority) results = results.filter((c) => c.priority === query.priority);

    /* The backlog's own deterministic ordering — never a second one invented here. */
    results = sortCandidatesForSelection(results);
    return query.limit ? results.slice(0, query.limit) : results;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;
    /*
     * Tombstoned rather than deleted: `DurableMemory` has no delete, and an improvement that
     * was considered and dropped is evidence worth keeping. It is filtered out of every read.
     */
    await this.memory.saveContextItem({
      id: this.itemId(id),
      scope: "global",
      type: `${IMPROVEMENT_CANDIDATE_TYPE}-removed`,
      summary: existing.id,
      missionId: BACKLOG_PARTITION,
      createdAt: new Date().toISOString(),
    });
  }

  private async write(candidate: ImprovementCandidate): Promise<void> {
    await this.memory.saveContextItem({
      id: this.itemId(candidate.id),
      scope: "global",
      type: IMPROVEMENT_CANDIDATE_TYPE,
      /* The whole record. Small, self-contained, and readable in the store. */
      summary: JSON.stringify(candidate),
      missionId: BACKLOG_PARTITION,
      tags: [candidate.status, candidate.category, candidate.priority],
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    });
  }

  private async readAll(): Promise<ImprovementCandidate[]> {
    const items = await this.memory.queryContextItems({
      missionId: BACKLOG_PARTITION,
      scope: "global",
      includeHistory: true,
    });

    const removed = new Set(
      items
        .filter((i) => i.type === `${IMPROVEMENT_CANDIDATE_TYPE}-removed`)
        .map((i) => i.summary),
    );

    const byId = new Map<string, ImprovementCandidate>();
    for (const item of items) {
      if (item.type !== IMPROVEMENT_CANDIDATE_TYPE) continue;
      let parsed: ImprovementCandidate;
      try {
        parsed = JSON.parse(item.summary) as ImprovementCandidate;
      } catch {
        /* A corrupt record must not take the whole backlog down with it. */
        continue;
      }
      if (removed.has(parsed.id)) continue;
      /* Last write wins, which is what `update` means. */
      byId.set(parsed.id, parsed);
    }
    return [...byId.values()];
  }

  private itemId(candidateId: string): string {
    return `${IMPROVEMENT_CANDIDATE_TYPE}-${candidateId}`;
  }
}

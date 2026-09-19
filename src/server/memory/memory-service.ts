import {
  assertNoSecrets,
  assertTenant,
  businessQuerySchema,
  missionQuerySchema,
  proceduralQuerySchema,
  type BusinessMemoryEntry,
  type BusinessQueryRaw,
  type MemoryActor,
  type MemoryType,
  type MissionMemoryEntry,
  type MissionQueryRaw,
  type ProceduralEntry,
  type ProceduralQueryRaw,
  type RetrievalResult,
} from "@/core/memory";
import type {
  BusinessMemoryStore,
  FindResult,
  MissionMemoryStore,
  ProceduralMemoryStore,
  RetrievalLogStore,
} from "./ports";
import { resolveDeps, type MemoryDeps } from "./sql";

interface Stores {
  mission: MissionMemoryStore;
  procedural: ProceduralMemoryStore;
  business: BusinessMemoryStore;
  log: RetrievalLogStore;
}

/**
 * Point d'entrée de lecture de la mémoire (I9) : chaque retrieval est tracé AVANT d'être
 * retourné. Si la trace ne peut pas être écrite, l'appel échoue (fail closed) — on ne
 * renvoie jamais de mémoire non tracée. Les trois mémoires restent séparées : trois
 * méthodes, trois types de résultat, jamais de classement commun.
 */
export class MemoryService {
  private readonly deps;
  constructor(
    private readonly stores: Stores,
    deps?: MemoryDeps,
  ) {
    this.deps = resolveDeps(deps);
  }

  async retrieveMission(
    reader: MemoryActor,
    raw: MissionQueryRaw,
  ): Promise<RetrievalResult<MissionMemoryEntry>> {
    assertTenant(reader);
    const q = missionQuerySchema.parse(raw);
    return await this.traced("mission", reader, q, undefined, q.missionId, () =>
      this.stores.mission.find(reader, q),
    );
  }

  async retrieveProcedural(
    reader: MemoryActor,
    raw: ProceduralQueryRaw,
  ): Promise<RetrievalResult<ProceduralEntry>> {
    assertTenant(reader);
    const q = proceduralQuerySchema.parse(raw);
    return await this.traced("procedural", reader, q, q.purpose, undefined, () =>
      this.stores.procedural.find(reader, q),
    );
  }

  async retrieveBusiness(
    reader: MemoryActor,
    raw: BusinessQueryRaw,
  ): Promise<RetrievalResult<BusinessMemoryEntry>> {
    assertTenant(reader);
    const q = businessQuerySchema.parse(raw);
    return await this.traced("business", reader, q, q.purpose, undefined, () =>
      this.stores.business.find(reader, q),
    );
  }

  private async traced<
    E extends { id: string; confidence: number; sourceType: string; sourceId: string },
  >(
    memoryType: MemoryType,
    reader: MemoryActor,
    query: object,
    purpose: string | undefined,
    missionId: string | undefined,
    run: () => Promise<FindResult<E>>,
  ): Promise<RetrievalResult<E>> {
    assertNoSecrets({ query, purpose }, "retrieval");
    const { entries, stats } = await run();
    const retrievalId = this.deps.newId("mret");
    await this.stores.log.append({
      id: retrievalId,
      tenantId: reader.tenantId,
      memoryType,
      requesterType: reader.kind,
      requesterId: reader.id,
      onBehalfOfUserId: reader.onBehalfOfUserId ?? null,
      purpose: purpose ?? null,
      missionId: missionId ?? null,
      query: query as Record<string, unknown>,
      result: entries.map((r) => ({
        entryId: r.entry.id,
        rank: r.rank,
        freshness: r.freshness,
        confidence: r.entry.confidence,
        sourceType: r.entry.sourceType,
        sourceId: r.entry.sourceId,
      })),
      stats,
      retrievedAt: this.deps.now().toISOString(),
    });
    return { retrievalId, memoryType, entries, stats };
  }
}

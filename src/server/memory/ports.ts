import type {
  BusinessMemoryEntry,
  BusinessMemoryInputRaw,
  BusinessQuery,
  HumanActor,
  MemoryActor,
  MemoryType,
  MissionMemoryEntry,
  MissionMemoryInputRaw,
  MissionQuery,
  ProceduralEntry,
  ProceduralEvidence,
  ProceduralObservationRaw,
  ProceduralQuery,
  RemediationInputRaw,
  RetrievedEntry,
  RetrievalStats,
  ValidationEvidence,
} from "@/core/memory";

/**
 * Ports de la mémoire opérationnelle (Phase 7B). Implémentations PostgreSQL
 * uniquement : PostgreSQL est la seule source de vérité (aucune mémoire critique en RAM).
 *
 * Toute méthode exige un `MemoryActor` porteur du `tenantId` : pas de tenant, pas d'opération.
 */

export interface FindResult<E> {
  readonly entries: readonly RetrievedEntry<E>[];
  readonly stats: RetrievalStats;
}

export interface MissionMemoryStore {
  /** Append-only, idempotent sur (tenant, kind, source) : un rejeu retourne l'existant. */
  append(
    actor: MemoryActor,
    input: MissionMemoryInputRaw,
  ): Promise<{ entry: MissionMemoryEntry; created: boolean }>;
  find(reader: MemoryActor, query: MissionQuery): Promise<FindResult<MissionMemoryEntry>>;
  getById(reader: MemoryActor, id: string): Promise<MissionMemoryEntry | null>;
}

export interface ProceduralMemoryStore {
  /** Système uniquement, depuis une source objective ; idempotent par (entrée, source). */
  observe(actor: MemoryActor, input: ProceduralObservationRaw): Promise<ProceduralEntry>;
  validate(actor: HumanActor, id: string, evidence: ValidationEvidence): Promise<ProceduralEntry>;
  recordValidatedRemediation(
    actor: HumanActor,
    input: RemediationInputRaw,
  ): Promise<ProceduralEntry>;
  deprecate(actor: MemoryActor, id: string): Promise<ProceduralEntry>;
  find(reader: MemoryActor, query: ProceduralQuery): Promise<FindResult<ProceduralEntry>>;
  listEvidence(reader: MemoryActor, entryId: string): Promise<ProceduralEvidence[]>;
}

export interface BusinessMemoryStore {
  /** Humain : écrit directement une version active. */
  record(actor: HumanActor, input: BusinessMemoryInputRaw): Promise<BusinessMemoryEntry>;
  /** Seul chemin d'écriture d'un worker : entrée `proposed`, jamais retrouvable avant approbation. */
  propose(actor: MemoryActor, input: BusinessMemoryInputRaw): Promise<BusinessMemoryEntry>;
  approve(actor: HumanActor, id: string): Promise<BusinessMemoryEntry>;
  reject(actor: HumanActor, id: string): Promise<BusinessMemoryEntry>;
  retract(actor: HumanActor, id: string): Promise<BusinessMemoryEntry>;
  listProposals(actor: HumanActor): Promise<BusinessMemoryEntry[]>;
  find(reader: MemoryActor, query: BusinessQuery): Promise<FindResult<BusinessMemoryEntry>>;
}

export interface RetrievalLogRow {
  readonly id: string;
  readonly tenantId: string;
  readonly memoryType: MemoryType;
  readonly requesterType: MemoryActor["kind"];
  readonly requesterId: string;
  readonly onBehalfOfUserId: string | null;
  readonly purpose: string | null;
  readonly missionId: string | null;
  readonly query: Record<string, unknown>;
  readonly result: readonly {
    entryId: string;
    rank: number;
    freshness: string;
    confidence: number;
    sourceType: string;
    sourceId: string;
  }[];
  readonly stats: RetrievalStats;
  readonly retrievedAt: string;
}

export interface RetrievalLogStore {
  append(row: RetrievalLogRow): Promise<void>;
  listByRequester(
    tenantId: string,
    requesterId: string,
    limit?: number,
  ): Promise<RetrievalLogRow[]>;
}

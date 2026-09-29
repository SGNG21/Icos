import { and, asc, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import type {
  CognitiveMemoryType,
  CognitiveScope,
  Entity,
  EntityKind,
  Epistemic,
  MemoryCandidate,
  MemoryRecord,
  Relation,
  RelationType,
  Sensitivity,
  WritebackOutcome,
} from "@/core/cognitive/contracts";
import { classifyCandidate, decideAgainstExisting } from "@/core/cognitive/writeback-rules";
import { MemoryPolicyError } from "@/core/memory";
import type { Database } from "@/server/database/client";

import { systemClock, type Clock } from "./conversation-store";
import { memoryEntities, memoryRecords, memoryRelations } from "./schema";

type RecordRow = typeof memoryRecords.$inferSelect;
type EntityRow = typeof memoryEntities.$inferSelect;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const SESSION_TTL_MS = 86_400_000;

const toRecord = (r: RecordRow): MemoryRecord => ({
  id: r.id,
  tenantId: r.tenantId,
  type: r.type as MemoryRecord["type"],
  subjectKey: r.subjectKey,
  entityId: r.entityId,
  content: r.content,
  epistemic: r.epistemic as Epistemic,
  statementKind: r.statementKind as MemoryRecord["statementKind"],
  status: r.status as MemoryRecord["status"],
  confidence: r.confidence,
  originTrust: r.originTrust as MemoryRecord["originTrust"],
  provenance: r.provenance as MemoryRecord["provenance"],
  clientId: r.clientId,
  projectId: r.projectId,
  ownerUserId: r.ownerUserId,
  conversationId: r.conversationId,
  missionId: r.missionId,
  tags: r.tags,
  sensitivity: r.sensitivity as Sensitivity,
  retention: r.retention as MemoryRecord["retention"],
  validFrom: r.validFrom.toISOString(),
  validUntil: iso(r.validUntil),
  expiresAt: iso(r.expiresAt),
  supersedesId: r.supersedesId,
  contradictsId: r.contradictsId,
  recordedBy: r.recordedBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const toEntity = (r: EntityRow): Entity => ({
  id: r.id,
  tenantId: r.tenantId,
  kind: r.kind as EntityKind,
  key: r.key,
  name: r.name,
  clientId: r.clientId,
  projectId: r.projectId,
  aliases: r.aliases,
  sensitivity: r.sensitivity as Sensitivity,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Isolation predicate, applied in SQL BEFORE any limit (decision 0056): same tenant, and
 * a row bound to a client/project/user is only visible inside that client/project/user.
 * An unscoped conversation (clientId null) sees only unscoped rows.
 */
function scopeSql(
  c: { tenantId: AnyPgColumn; clientId: AnyPgColumn; projectId: AnyPgColumn },
  s: CognitiveScope,
  owner?: AnyPgColumn,
): SQL {
  return and(
    eq(c.tenantId, s.tenantId),
    s.clientId === null ? isNull(c.clientId) : or(isNull(c.clientId), eq(c.clientId, s.clientId)),
    s.projectId === null
      ? isNull(c.projectId)
      : or(isNull(c.projectId), eq(c.projectId, s.projectId)),
    owner ? or(isNull(owner), eq(owner, s.userId)) : undefined,
  ) as SQL;
}

const recordScope = (s: CognitiveScope) =>
  scopeSql(
    {
      tenantId: memoryRecords.tenantId,
      clientId: memoryRecords.clientId,
      projectId: memoryRecords.projectId,
    },
    s,
    memoryRecords.ownerUserId,
  );
const entityScope = (s: CognitiveScope) =>
  scopeSql(
    {
      tenantId: memoryEntities.tenantId,
      clientId: memoryEntities.clientId,
      projectId: memoryEntities.projectId,
    },
    s,
  );

export interface EntityInput {
  readonly kind: EntityKind;
  readonly key: string;
  readonly name: string;
  readonly clientId?: string | null;
  readonly projectId?: string | null;
  readonly aliases?: readonly string[];
  readonly sensitivity?: Sensitivity;
}

/**
 * Cognitive memory + entity graph store (decision 0056). One normalized table for the
 * eight memory types; PostgreSQL relations for the graph (no graph database).
 * All writes go through `write` (governed writeback) — there is no raw insert path.
 */
export class PostgresCognitiveMemoryStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  // ── Entity graph ───────────────────────────────────────────────────────────
  async upsertEntity(tenantId: string, input: EntityInput): Promise<Entity> {
    const now = this.clock.now();
    await this.db
      .insert(memoryEntities)
      .values({
        id: this.clock.newId("ent"),
        tenantId,
        kind: input.kind,
        key: input.key,
        name: input.name,
        clientId: input.clientId ?? null,
        projectId: input.projectId ?? null,
        aliases: [...(input.aliases ?? [])],
        sensitivity: input.sensitivity ?? "normal",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const [row] = await this.db
      .select()
      .from(memoryEntities)
      .where(
        and(
          eq(memoryEntities.tenantId, tenantId),
          eq(memoryEntities.kind, input.kind),
          eq(memoryEntities.key, input.key),
        ),
      );
    // Same key, different client: never merge two clients' entities.
    if ((row.clientId ?? null) !== (input.clientId ?? null)) {
      throw new MemoryPolicyError("entité existante dans un autre périmètre client");
    }
    return toEntity(row);
  }

  async relate(
    tenantId: string,
    from: Entity,
    to: Entity,
    type: RelationType,
    provenance: { epistemic: Epistemic; confidence: number; sourceId: string },
  ): Promise<void> {
    if (from.tenantId !== tenantId || to.tenantId !== tenantId)
      throw new MemoryPolicyError("relation inter-tenant");
    if (from.clientId && to.clientId && from.clientId !== to.clientId) {
      throw new MemoryPolicyError("relation inter-clients interdite");
    }
    await this.db
      .insert(memoryRelations)
      .values({
        id: this.clock.newId("rel"),
        tenantId,
        fromEntityId: from.id,
        toEntityId: to.id,
        type,
        epistemic: provenance.epistemic,
        confidence: provenance.confidence,
        sourceId: provenance.sourceId,
        validFrom: this.clock.now(),
        createdAt: this.clock.now(),
      })
      .onConflictDoNothing();
  }

  async entitiesInScope(scope: CognitiveScope, limit = 200): Promise<Entity[]> {
    const rows = await this.db
      .select()
      .from(memoryEntities)
      .where(entityScope(scope))
      .orderBy(asc(memoryEntities.key))
      .limit(limit);
    return rows.map(toEntity);
  }

  async findEntity(scope: CognitiveScope, key: string): Promise<Entity | null> {
    const [row] = await this.db
      .select()
      .from(memoryEntities)
      .where(and(entityScope(scope), eq(memoryEntities.key, key)))
      .orderBy(asc(memoryEntities.kind))
      .limit(1);
    return row ? toEntity(row) : null;
  }

  /** Current 1-hop relations touching `entityIds`, both endpoints visible in scope. */
  async relationsOf(scope: CognitiveScope, entityIds: readonly string[]): Promise<Relation[]> {
    if (!entityIds.length) return [];
    const visible = (await this.entitiesInScope(scope, 1000)).map((e) => e.id);
    if (!visible.length) return [];
    const rows = await this.db
      .select()
      .from(memoryRelations)
      .where(
        and(
          eq(memoryRelations.tenantId, scope.tenantId),
          isNull(memoryRelations.validUntil),
          or(
            inArray(memoryRelations.fromEntityId, [...entityIds]),
            inArray(memoryRelations.toEntityId, [...entityIds]),
          ),
          inArray(memoryRelations.fromEntityId, visible),
          inArray(memoryRelations.toEntityId, visible),
        ),
      )
      .orderBy(asc(memoryRelations.id));
    return rows.map((r) => ({
      id: r.id,
      fromEntityId: r.fromEntityId,
      toEntityId: r.toEntityId,
      type: r.type as RelationType,
      epistemic: r.epistemic as Epistemic,
      confidence: r.confidence,
      validFrom: r.validFrom.toISOString(),
      validUntil: iso(r.validUntil),
    }));
  }

  // ── Governed writeback ─────────────────────────────────────────────────────
  /**
   * candidate → classify → provenance → confidence → dedupe → contradiction → decision,
   * in one transaction under an advisory lock on the subject, so two concurrent writers
   * of the same subject cannot both become "active".
   */
  async write(scope: CognitiveScope, c: MemoryCandidate): Promise<WritebackOutcome> {
    const cls = classifyCandidate(c);
    if (!cls.ok) return { kind: "rejected", reason: cls.reason };

    let clientId = scope.clientId;
    const projectId = scope.projectId;
    let entityId: string | null = null;
    if (c.entityKey) {
      const entity = await this.findEntity(scope, c.entityKey);
      if (!entity) return { kind: "rejected", reason: "entity_out_of_scope" };
      entityId = entity.id;
      clientId = clientId ?? entity.clientId; // a client's entity pulls the memory into that client
    }
    const ownerUserId = c.personal ? scope.userId : null;
    const now = this.clock.now();

    return await this.db.transaction(async (tx) => {
      const lock = [
        scope.tenantId,
        c.type,
        c.subjectKey,
        clientId ?? "",
        projectId ?? "",
        ownerUserId ?? "",
      ].join("|");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lock}))`);
      const existing = await tx
        .select()
        .from(memoryRecords)
        .where(
          and(
            eq(memoryRecords.tenantId, scope.tenantId),
            eq(memoryRecords.type, c.type),
            eq(memoryRecords.subjectKey, c.subjectKey),
            sql`coalesce(${memoryRecords.clientId}, '') = ${clientId ?? ""}`,
            sql`coalesce(${memoryRecords.projectId}, '') = ${projectId ?? ""}`,
            sql`coalesce(${memoryRecords.ownerUserId}, '') = ${ownerUserId ?? ""}`,
            inArray(memoryRecords.status, ["active", "candidate"]),
          ),
        )
        .orderBy(desc(memoryRecords.createdAt), asc(memoryRecords.id));
      const decision = decideAgainstExisting(c, cls.status, existing.map(toRecord));
      if (decision.kind === "duplicate")
        return { kind: "duplicate", existingId: decision.existingId };

      if (decision.kind === "supersede") {
        await tx
          .update(memoryRecords)
          .set({ status: "superseded", validUntil: now, updatedAt: now })
          .where(
            and(eq(memoryRecords.id, decision.previousId), eq(memoryRecords.status, "active")),
          );
      }
      const status = decision.kind === "conflict" ? "candidate" : cls.status;
      const [row] = await tx
        .insert(memoryRecords)
        .values({
          id: this.clock.newId("mem"),
          tenantId: scope.tenantId,
          type: c.type,
          subjectKey: c.subjectKey,
          entityId,
          content: c.content,
          epistemic: c.epistemic,
          statementKind: cls.statementKind,
          status,
          confidence: cls.confidence,
          originTrust: c.originTrust,
          provenance: c.provenance,
          clientId,
          projectId,
          ownerUserId,
          conversationId: c.provenance.conversationId,
          missionId: c.missionId ?? null,
          tags: [...(c.tags ?? [])],
          sensitivity: c.sensitivity ?? "normal",
          retention: c.retention ?? (c.type === "working" ? "session" : "standard"),
          validFrom: now,
          expiresAt:
            (c.retention ?? (c.type === "working" ? "session" : "standard")) === "session"
              ? new Date(now.getTime() + SESSION_TTL_MS)
              : null,
          supersedesId: decision.kind === "supersede" ? decision.previousId : null,
          contradictsId: decision.kind === "conflict" ? decision.conflictsWith : null,
          recordedBy: c.provenance.sourceId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const record = toRecord(row);
      switch (decision.kind) {
        case "supersede":
          return { kind: "superseded", record, previousId: decision.previousId };
        case "conflict":
          return { kind: "conflict_pending", record, conflictsWith: decision.conflictsWith };
        default:
          return status === "active" ? { kind: "accepted", record } : { kind: "candidate", record };
      }
    });
  }

  /** Records a context stage may use: active, in scope, not expired. */
  async activeInScope(
    scope: CognitiveScope,
    types: readonly CognitiveMemoryType[],
    limit = 200,
  ): Promise<MemoryRecord[]> {
    const now = this.clock.now();
    const rows = await this.db
      .select()
      .from(memoryRecords)
      .where(
        and(
          recordScope(scope),
          eq(memoryRecords.status, "active"),
          inArray(memoryRecords.type, [...types]),
          or(isNull(memoryRecords.expiresAt), gt(memoryRecords.expiresAt, now)),
          or(isNull(memoryRecords.validUntil), gt(memoryRecords.validUntil, now)),
        ),
      )
      .orderBy(desc(memoryRecords.validFrom), asc(memoryRecords.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  async get(scope: CognitiveScope, id: string): Promise<MemoryRecord | null> {
    const [row] = await this.db
      .select()
      .from(memoryRecords)
      .where(and(recordScope(scope), eq(memoryRecords.id, id)));
    return row ? toRecord(row) : null;
  }

  /** Provenance chain: the record and every record it superseded, newest first. */
  async history(scope: CognitiveScope, id: string): Promise<MemoryRecord[]> {
    const chain: MemoryRecord[] = [];
    let next: string | null = id;
    while (next && chain.length < 50) {
      const r = await this.get(scope, next);
      if (!r) break;
      chain.push(r);
      next = r.supersedesId;
    }
    return chain;
  }

  /** Retraction keeps the claim (auditable) but takes it out of every future context. */
  async retract(scope: CognitiveScope, id: string): Promise<boolean> {
    const now = this.clock.now();
    const rows = await this.db
      .update(memoryRecords)
      .set({ status: "retracted", validUntil: now, updatedAt: now })
      .where(
        and(
          recordScope(scope),
          eq(memoryRecords.id, id),
          inArray(memoryRecords.status, ["active", "candidate"]),
        ),
      )
      .returning({ id: memoryRecords.id });
    return rows.length > 0;
  }

  /** Deletion = tombstone: content erased, provenance kept (right to erasure + audit). */
  async forget(scope: CognitiveScope, id: string): Promise<boolean> {
    const now = this.clock.now();
    const rows = await this.db
      .update(memoryRecords)
      .set({ status: "deleted", content: "[deleted]", validUntil: now, updatedAt: now })
      .where(
        and(
          recordScope(scope),
          eq(memoryRecords.id, id),
          sql`${memoryRecords.status} <> 'deleted'`,
        ),
      )
      .returning({ id: memoryRecords.id });
    return rows.length > 0;
  }
}

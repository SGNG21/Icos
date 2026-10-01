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
import type { DirectoryEntry } from "@/core/cognitive/client-resolution";
import {
  classifyCandidate,
  decideAgainstExisting,
  SINGLE_VALUED_TYPES,
} from "@/core/cognitive/writeback-rules";
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
  reviewedBy: r.reviewedBy,
  reviewedAt: iso(r.reviewedAt),
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

  /**
   * CLIENT / PROJECT DIRECTORY (decision 0062) — the ONE read that deliberately does not
   * apply the client scope predicate, because a reference must be resolvable BEFORE a scope
   * exists: « Où en est LDS ? » asked from an unscoped conversation has to find LDS.
   *
   * What it returns is strictly the directory: kind, key, name, aliases, owning client. It
   * carries no client knowledge — no memory row, no objective, no blocker, no relation — so
   * it cannot leak one client's facts into another's context. The tenant predicate and the
   * sensitivity ceiling still apply: a `restricted` client is never resolvable, and a
   * `sensitive` one only for operator+.
   */
  async clientDirectory(tenantId: string, maxSensitivity: Sensitivity): Promise<DirectoryEntry[]> {
    const allowed: Sensitivity[] =
      maxSensitivity === "restricted"
        ? ["normal", "sensitive", "restricted"]
        : maxSensitivity === "sensitive"
          ? ["normal", "sensitive"]
          : ["normal"];
    const rows = await this.db
      .select({
        kind: memoryEntities.kind,
        key: memoryEntities.key,
        name: memoryEntities.name,
        aliases: memoryEntities.aliases,
        clientId: memoryEntities.clientId,
        sensitivity: memoryEntities.sensitivity,
      })
      .from(memoryEntities)
      .where(
        and(
          eq(memoryEntities.tenantId, tenantId),
          inArray(memoryEntities.kind, ["client", "project"]),
          inArray(memoryEntities.sensitivity, allowed),
        ),
      )
      .orderBy(asc(memoryEntities.kind), asc(memoryEntities.key));
    return rows.map((r) => ({
      kind: r.kind as DirectoryEntry["kind"],
      key: r.key,
      name: r.name,
      aliases: r.aliases,
      clientId: r.clientId,
      sensitivity: r.sensitivity as Sensitivity,
    }));
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

  /** Candidates awaiting human review (model inferences, untrusted text, conflicts). */
  async candidates(scope: CognitiveScope, limit = 100): Promise<MemoryRecord[]> {
    const rows = await this.db
      .select()
      .from(memoryRecords)
      .where(and(recordScope(scope), eq(memoryRecords.status, "candidate")))
      .orderBy(asc(memoryRecords.createdAt), asc(memoryRecords.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  /**
   * Human review: candidate → active (accept) | rejected. The ONLY way a MODEL_INFERRED or
   * untrusted-origin record becomes usable. Its epistemic status is never rewritten: an
   * accepted inference stays MODEL_INFERRED/"inference", now with `reviewedBy`, so it stays
   * distinguishable from USER_ASSERTED / TOOL_CONFIRMED / SYSTEM_OBSERVED facts. Accepting
   * a record that contradicts the current truth supersedes that truth (a human decided).
   */
  async review(
    scope: CognitiveScope,
    id: string,
    decision: "accept" | "reject",
  ): Promise<MemoryRecord | null> {
    const candidate = await this.get(scope, id);
    if (!candidate || candidate.status !== "candidate") return null;
    const now = this.clock.now();
    return await this.db.transaction(async (tx) => {
      const lock = [
        candidate.tenantId,
        candidate.type,
        candidate.subjectKey,
        candidate.clientId ?? "",
        candidate.projectId ?? "",
        candidate.ownerUserId ?? "",
      ].join("|");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lock}))`);
      if (decision === "reject") {
        const [row] = await tx
          .update(memoryRecords)
          .set({ status: "rejected", reviewedBy: scope.userId, reviewedAt: now, updatedAt: now })
          .where(and(eq(memoryRecords.id, id), eq(memoryRecords.status, "candidate")))
          .returning();
        return row ? toRecord(row) : null;
      }
      let supersedesId: string | null = candidate.supersedesId;
      if (SINGLE_VALUED_TYPES.has(candidate.type)) {
        const [active] = await tx
          .update(memoryRecords)
          .set({ status: "superseded", validUntil: now, updatedAt: now })
          .where(
            and(
              eq(memoryRecords.tenantId, candidate.tenantId),
              eq(memoryRecords.type, candidate.type),
              eq(memoryRecords.subjectKey, candidate.subjectKey),
              sql`coalesce(${memoryRecords.clientId}, '') = ${candidate.clientId ?? ""}`,
              sql`coalesce(${memoryRecords.projectId}, '') = ${candidate.projectId ?? ""}`,
              sql`coalesce(${memoryRecords.ownerUserId}, '') = ${candidate.ownerUserId ?? ""}`,
              eq(memoryRecords.status, "active"),
            ),
          )
          .returning({ id: memoryRecords.id });
        if (active) supersedesId = active.id;
      }
      const [row] = await tx
        .update(memoryRecords)
        .set({
          status: "active",
          reviewedBy: scope.userId,
          reviewedAt: now,
          supersedesId,
          updatedAt: now,
        })
        .where(and(eq(memoryRecords.id, id), eq(memoryRecords.status, "candidate")))
        .returning();
      return row ? toRecord(row) : null;
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

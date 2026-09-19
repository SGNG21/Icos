import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";

import {
  assertHuman,
  assertNoSecrets,
  assertSourceAllowed,
  assertTenant,
  defaultFreshness,
  freshnessOf,
  MemoryNotFoundError,
  MemoryPolicyError,
  proceduralConfidence,
  proceduralEntrySchema,
  proceduralObservationSchema,
  remediationInputSchema,
  TENANT_SCOPE_KEY,
  validationEvidenceSchema,
  type HumanActor,
  type MemoryActor,
  type MemorySourceType,
  type ProceduralEntry,
  type ProceduralEvidence,
  type ProceduralObservationRaw,
  type ProceduralQuery,
  type RemediationInputRaw,
  type ValidationEvidence,
} from "@/core/memory";
import type { Database } from "@/server/database/client";
import {
  proceduralMemoryEntries as t,
  proceduralMemoryEvidence as ev,
} from "@/server/database/memory-schema";
import type { FindResult, ProceduralMemoryStore } from "./ports";
import {
  mapRow,
  normalizeRow,
  notExpiredSql,
  resolveDeps,
  staleRankSql,
  statsSql,
  toDate,
  visibleSql,
  type MemoryDeps,
} from "./sql";

/** Sources sur lesquelles le système peut dériver un savoir procédural (objectives, pas déclaratives). */
const OBJECTIVE_SOURCES: readonly MemorySourceType[] = [
  "execution_result",
  "review_decision",
  "audit_entry",
  "checkpoint",
  "mission",
];
const entity = "procedural_memory_entry";

/**
 * Mémoire procédurale : savoir-faire agrégé, dérivé par le SYSTÈME de preuves objectives.
 * Les compteurs et la confiance sont recalculés depuis `procedural_memory_evidence`
 * (append-only, unique par (entrée, source)) : un rejeu ne peut donc rien gonfler.
 */
export class PostgresProceduralMemoryStore implements ProceduralMemoryStore {
  private readonly deps;
  constructor(
    private readonly db: Database,
    deps?: MemoryDeps,
  ) {
    this.deps = resolveDeps(deps);
  }

  async observe(actor: MemoryActor, raw: ProceduralObservationRaw): Promise<ProceduralEntry> {
    assertTenant(actor);
    if (actor.kind !== "system")
      throw new MemoryPolicyError("la mémoire procédurale est dérivée par le système uniquement");
    const o = proceduralObservationSchema.parse(raw);
    assertSourceAllowed(actor, o.provenance.sourceType);
    if (!OBJECTIVE_SOURCES.includes(o.provenance.sourceType)) {
      throw new MemoryPolicyError(
        `source '${o.provenance.sourceType}' non objective pour une observation procédurale`,
      );
    }
    assertNoSecrets(
      { signature: o.signature, title: o.title, summary: o.summary, payload: o.payload },
      "procedural",
    );

    const now = this.deps.now();
    const scopeKey = o.scope === "tenant" ? TENANT_SCOPE_KEY : (o.scopeKey as string);
    const windows = defaultFreshness("procedural", now.toISOString());
    const success = o.outcome === "success" ? 1 : 0;
    const identity = and(
      eq(t.tenantId, actor.tenantId),
      eq(t.kind, o.kind),
      eq(t.scope, o.scope),
      eq(t.scopeKey, scopeKey),
      eq(t.signature, o.signature),
    );

    return this.db.transaction(async (tx) => {
      await tx
        .insert(t)
        .values({
          id: this.deps.newId("pmem"),
          tenantId: actor.tenantId,
          sourceType: o.provenance.sourceType,
          sourceId: o.provenance.sourceId,
          recordedByType: actor.kind,
          recordedBy: actor.id,
          occurredAt: new Date(o.occurredAt),
          recordedAt: now,
          lastVerifiedAt: now,
          staleAfter: toDate(windows.staleAfter),
          expiresAt: toDate(windows.expiresAt),
          confidence: proceduralConfidence(success, 1 - success),
          confidenceBasis: "derived",
          visibility: o.visibility.visibility,
          ownerSubject: o.visibility.ownerSubject,
          requiredPermission: o.visibility.requiredPermission,
          kind: o.kind,
          scope: o.scope,
          scopeKey,
          signature: o.signature,
          title: o.title,
          summary: o.summary,
          payload: o.payload,
          status: "candidate",
          occurrenceCount: 1,
          successCount: success,
          failureCount: 1 - success,
          firstObservedAt: new Date(o.occurredAt),
          lastObservedAt: new Date(o.occurredAt),
        })
        .onConflictDoNothing({ target: [t.tenantId, t.kind, t.scope, t.scopeKey, t.signature] });

      // Verrou de ligne : sérialise les observations concurrentes d'une même signature.
      const [entry] = await tx.select().from(t).where(identity).for("update");
      const added = await tx
        .insert(ev)
        .values({
          id: this.deps.newId("pev"),
          entryId: entry.id,
          tenantId: actor.tenantId,
          sourceType: o.provenance.sourceType,
          sourceId: o.provenance.sourceId,
          missionId: o.missionId ?? null,
          outcome: o.outcome,
          observedAt: new Date(o.occurredAt),
          recordedAt: now,
        })
        .onConflictDoNothing({ target: [ev.entryId, ev.sourceType, ev.sourceId] })
        .returning({ id: ev.id });
      if (added.length === 0) return mapRow(proceduralEntrySchema, entity, entry); // rejeu : aucun effet

      const counts = await tx
        .select({ outcome: ev.outcome, n: sql<number>`count(*)::int` })
        .from(ev)
        .where(eq(ev.entryId, entry.id))
        .groupBy(ev.outcome);
      const ok = counts.find((c) => c.outcome === "success")?.n ?? 0;
      const ko = counts.find((c) => c.outcome === "failure")?.n ?? 0;
      const observedAt = new Date(o.occurredAt);
      const [updated] = await tx
        .update(t)
        .set({
          occurrenceCount: ok + ko,
          successCount: ok,
          failureCount: ko,
          confidence: proceduralConfidence(ok, ko),
          firstObservedAt: entry.firstObservedAt < observedAt ? entry.firstObservedAt : observedAt,
          lastObservedAt: entry.lastObservedAt > observedAt ? entry.lastObservedAt : observedAt,
          lastVerifiedAt: now,
          staleAfter: toDate(windows.staleAfter),
          expiresAt: toDate(windows.expiresAt),
        })
        .where(eq(t.id, entry.id))
        .returning();
      return mapRow(proceduralEntrySchema, entity, updated);
    });
  }

  async validate(
    actor: HumanActor,
    id: string,
    evidence: ValidationEvidence,
  ): Promise<ProceduralEntry> {
    assertHuman(actor);
    const parsed = validationEvidenceSchema.safeParse(evidence);
    if (!parsed.success)
      throw new MemoryPolicyError("validation : preuve humaine ou décision de revue requise");
    const now = this.deps.now();
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(t)
        .where(and(eq(t.id, id), eq(t.tenantId, actor.tenantId)))
        .for("update");
      if (!row) throw new MemoryNotFoundError("procedural");
      if (row.status === "deprecated")
        throw new MemoryPolicyError("une entrée dépréciée ne peut pas être validée");
      const [updated] = await tx
        .update(t)
        .set({
          status: "validated",
          validatedBy: actor.id,
          validatedAt: now,
          validatedSourceType: parsed.data.sourceType,
          validatedSourceId: parsed.data.sourceId,
          confidenceBasis: "validated",
        })
        .where(eq(t.id, id))
        .returning();
      return mapRow(proceduralEntrySchema, entity, updated);
    });
  }

  async recordValidatedRemediation(
    actor: HumanActor,
    raw: RemediationInputRaw,
  ): Promise<ProceduralEntry> {
    assertHuman(actor);
    const r = remediationInputSchema.parse(raw);
    assertSourceAllowed(actor, r.evidence.sourceType);
    assertNoSecrets(
      { signature: r.signature, title: r.title, summary: r.summary, payload: r.payload },
      "remediation",
    );
    const now = this.deps.now();
    const scopeKey = r.scope === "tenant" ? TENANT_SCOPE_KEY : (r.scopeKey as string);
    const windows = defaultFreshness("procedural", now.toISOString());
    const identity = and(
      eq(t.tenantId, actor.tenantId),
      eq(t.kind, "validated_remediation"),
      eq(t.scope, r.scope),
      eq(t.scopeKey, scopeKey),
      eq(t.signature, r.signature),
    );

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(t)
        .values({
          id: this.deps.newId("pmem"),
          tenantId: actor.tenantId,
          sourceType: r.evidence.sourceType,
          sourceId: r.evidence.sourceId,
          recordedByType: actor.kind,
          recordedBy: actor.id,
          occurredAt: new Date(r.occurredAt),
          recordedAt: now,
          lastVerifiedAt: now,
          staleAfter: toDate(windows.staleAfter),
          expiresAt: toDate(windows.expiresAt),
          confidence: 1,
          confidenceBasis: "validated",
          visibility: r.visibility.visibility,
          ownerSubject: r.visibility.ownerSubject,
          requiredPermission: r.visibility.requiredPermission,
          kind: "validated_remediation",
          scope: r.scope,
          scopeKey,
          signature: r.signature,
          title: r.title,
          summary: r.summary,
          payload: r.payload,
          status: "validated",
          occurrenceCount: 1,
          successCount: 1,
          failureCount: 0,
          firstObservedAt: new Date(r.occurredAt),
          lastObservedAt: new Date(r.occurredAt),
          validatedBy: actor.id,
          validatedAt: now,
          validatedSourceType: r.evidence.sourceType,
          validatedSourceId: r.evidence.sourceId,
        })
        .onConflictDoNothing({ target: [t.tenantId, t.kind, t.scope, t.scopeKey, t.signature] })
        .returning();
      if (inserted[0]) {
        await tx.insert(ev).values({
          id: this.deps.newId("pev"),
          entryId: inserted[0].id,
          tenantId: actor.tenantId,
          sourceType: r.evidence.sourceType,
          sourceId: r.evidence.sourceId,
          missionId: r.missionId ?? null,
          outcome: "success",
          observedAt: new Date(r.occurredAt),
          recordedAt: now,
        });
        return mapRow(proceduralEntrySchema, entity, inserted[0]);
      }
      const [existing] = await tx.select().from(t).where(identity); // rejeu idempotent
      return mapRow(proceduralEntrySchema, entity, existing);
    });
  }

  async deprecate(actor: MemoryActor, id: string): Promise<ProceduralEntry> {
    assertTenant(actor);
    if (actor.kind === "agent")
      throw new MemoryPolicyError("un agent ne peut pas déprécier la mémoire procédurale");
    const [row] = await this.db
      .update(t)
      .set({ status: "deprecated" })
      .where(and(eq(t.id, id), eq(t.tenantId, actor.tenantId)))
      .returning();
    if (!row) throw new MemoryNotFoundError("procedural");
    return mapRow(proceduralEntrySchema, entity, row);
  }

  async find(reader: MemoryActor, q: ProceduralQuery): Promise<FindResult<ProceduralEntry>> {
    assertTenant(reader);
    const now = this.deps.now();
    // Portée applicable : tenant-wide + capability/worker demandés.
    const applicable = [
      q.capability || q.workerKind ? eq(t.scope, "tenant") : undefined,
      q.capability ? and(eq(t.scope, "capability"), eq(t.scopeKey, q.capability)) : undefined,
      q.workerKind ? and(eq(t.scope, "worker_kind"), eq(t.scopeKey, q.workerKind)) : undefined,
    ].filter((x) => x !== undefined);
    const scope = and(
      eq(t.tenantId, reader.tenantId),
      q.kinds ? inArray(t.kind, q.kinds) : undefined,
      q.signature ? eq(t.signature, q.signature) : undefined,
      applicable.length ? or(...applicable) : undefined,
    );
    const active = and(
      inArray(t.status, q.statuses),
      gte(t.confidence, q.minConfidence),
    ) as ReturnType<typeof sql>;

    const [stats] = await this.db
      .select(statsSql(t, reader, now, active))
      .from(t)
      .where(scope);
    const rows = await this.db
      .select()
      .from(t)
      .where(and(scope, visibleSql(t, reader), notExpiredSql(t, now), active))
      .orderBy(
        asc(staleRankSql(t, now)),
        asc(sql`case when ${t.status} = 'validated' then 0 else 1 end`),
        desc(t.confidence),
        desc(t.lastObservedAt),
        asc(t.id),
      )
      .limit(q.limit);
    const entries = rows.map((r, i) => {
      const entry = mapRow(proceduralEntrySchema, entity, r);
      return { entry, freshness: freshnessOf(entry, now), rank: i + 1 };
    });
    return { entries, stats: { ...stats, returned: entries.length } };
  }

  async listEvidence(reader: MemoryActor, entryId: string): Promise<ProceduralEvidence[]> {
    assertTenant(reader);
    const rows = await this.db
      .select({ ev })
      .from(ev)
      .innerJoin(t, eq(t.id, ev.entryId))
      .where(and(eq(ev.entryId, entryId), visibleSql(t, reader)))
      .orderBy(asc(ev.observedAt), asc(ev.id));
    return rows.map(({ ev: r }) => {
      const n = normalizeRow(r);
      return {
        id: r.id,
        entryId: r.entryId,
        sourceType: r.sourceType as MemorySourceType,
        sourceId: r.sourceId,
        missionId: r.missionId,
        outcome: r.outcome as "success" | "failure",
        observedAt: n.observedAt as string,
        recordedAt: n.recordedAt as string,
      };
    });
  }
}

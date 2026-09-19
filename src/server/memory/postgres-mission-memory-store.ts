import { asc, eq, inArray, sql } from "drizzle-orm";

import {
  assertConfidencePolicy,
  assertNoSecrets,
  assertSourceAllowed,
  assertTenant,
  defaultFreshness,
  freshnessOf,
  MemoryPolicyError,
  missionMemoryEntrySchema,
  missionMemoryInputSchema,
  type MemoryActor,
  type MissionMemoryEntry,
  type MissionMemoryInputRaw,
  type MissionQuery,
} from "@/core/memory";
import type { Database } from "@/server/database/client";
import { missionMemoryEntries as t } from "@/server/database/memory-schema";
import type { FindResult, MissionMemoryStore } from "./ports";
import {
  and,
  mapRow,
  toDate,
  notExpiredSql,
  resolveDeps,
  statsSql,
  visibleSql,
  type MemoryDeps,
} from "./sql";

/**
 * Mémoire de mission : preuve append-only (trigger `IC002`). Une correction est une
 * nouvelle entrée `supersedesId` ; rien n'est jamais modifié ni supprimé.
 */
export class PostgresMissionMemoryStore implements MissionMemoryStore {
  private readonly deps;
  constructor(
    private readonly db: Database,
    deps?: MemoryDeps,
  ) {
    this.deps = resolveDeps(deps);
  }

  async append(actor: MemoryActor, raw: MissionMemoryInputRaw) {
    assertTenant(actor);
    const input = missionMemoryInputSchema.parse(raw);
    assertSourceAllowed(actor, input.provenance.sourceType);
    assertConfidencePolicy({
      sourceType: input.provenance.sourceType,
      basis: input.confidence.basis,
      value: input.confidence.value,
    });
    assertNoSecrets(
      { title: input.title, summary: input.summary, payload: input.payload },
      "mission",
    );

    const now = this.deps.now();
    const lastVerifiedAt = input.freshness?.lastVerifiedAt ?? now.toISOString();
    const windows = defaultFreshness("mission", lastVerifiedAt);
    const row = {
      id: this.deps.newId("mmem"),
      tenantId: actor.tenantId,
      sourceType: input.provenance.sourceType,
      sourceId: input.provenance.sourceId,
      recordedByType: actor.kind,
      recordedBy: actor.id,
      occurredAt: new Date(input.occurredAt),
      recordedAt: now,
      lastVerifiedAt: new Date(lastVerifiedAt),
      staleAfter: toDate(
        input.freshness?.staleAfter !== undefined ? input.freshness.staleAfter : windows.staleAfter,
      ),
      expiresAt: toDate(
        input.freshness?.expiresAt !== undefined ? input.freshness.expiresAt : windows.expiresAt,
      ),
      confidence: input.confidence.value,
      confidenceBasis: input.confidence.basis,
      visibility: input.visibility.visibility,
      ownerSubject: input.visibility.ownerSubject,
      requiredPermission: input.visibility.requiredPermission,
      missionId: input.missionId,
      missionTaskId: input.missionTaskId ?? null,
      scope: input.scope,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      payload: input.payload,
      supersedesId: input.supersedesId ?? null,
    };

    return this.db.transaction(async (tx) => {
      if (row.supersedesId) {
        const [prev] = await tx
          .select({ id: t.id })
          .from(t)
          .where(
            and(
              eq(t.id, row.supersedesId),
              eq(t.tenantId, actor.tenantId),
              eq(t.missionId, row.missionId),
            ),
          );
        if (!prev)
          throw new MemoryPolicyError(
            "supersedesId doit référencer une entrée de la même mission et du même tenant",
          );
      }
      const inserted = await tx
        .insert(t)
        .values(row)
        .onConflictDoNothing({ target: [t.tenantId, t.kind, t.sourceType, t.sourceId] })
        .returning();
      if (inserted[0])
        return {
          entry: mapRow(missionMemoryEntrySchema, "mission_memory_entry", inserted[0]),
          created: true,
        };
      const [existing] = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.tenantId, actor.tenantId),
            eq(t.kind, row.kind),
            eq(t.sourceType, row.sourceType),
            eq(t.sourceId, row.sourceId),
          ),
        );
      return {
        entry: mapRow(missionMemoryEntrySchema, "mission_memory_entry", existing),
        created: false,
      };
    });
  }

  async find(reader: MemoryActor, q: MissionQuery): Promise<FindResult<MissionMemoryEntry>> {
    assertTenant(reader);
    const now = this.deps.now();
    const scope = and(
      eq(t.tenantId, reader.tenantId),
      eq(t.missionId, q.missionId),
      q.missionTaskId ? eq(t.missionTaskId, q.missionTaskId) : undefined,
      q.kinds ? inArray(t.kind, q.kinds) : undefined,
    );
    const notSuperseded = sql`not exists (select 1 from mission_memory_entries s where s.supersedes_id = ${t.id})`;
    const active = q.includeSuperseded ? sql`true` : notSuperseded;

    const [stats] = await this.db
      .select(statsSql(t, reader, now, active))
      .from(t)
      .where(scope);
    const rows = await this.db
      .select()
      .from(t)
      .where(and(scope, visibleSql(t, reader), notExpiredSql(t, now), active))
      .orderBy(asc(t.occurredAt), asc(t.id))
      .limit(q.limit);
    const entries = rows.map((r, i) => {
      const entry = mapRow(missionMemoryEntrySchema, "mission_memory_entry", r);
      return { entry, freshness: freshnessOf(entry, now), rank: i + 1 };
    });
    return { entries, stats: { ...stats, returned: entries.length } };
  }

  async getById(reader: MemoryActor, id: string): Promise<MissionMemoryEntry | null> {
    assertTenant(reader);
    const [row] = await this.db
      .select()
      .from(t)
      .where(and(eq(t.id, id), visibleSql(t, reader)));
    return row ? mapRow(missionMemoryEntrySchema, "mission_memory_entry", row) : null;
  }
}

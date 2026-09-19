import { and, asc, eq, inArray, max, sql } from "drizzle-orm";

import {
  assertConfidencePolicy,
  assertHuman,
  assertNoSecrets,
  assertSourceAllowed,
  assertTenant,
  businessMemoryEntrySchema,
  businessMemoryInputSchema,
  defaultFreshness,
  freshnessOf,
  MemoryNotFoundError,
  MemoryPolicyError,
  TENANT_SCOPE_KEY,
  type BusinessMemoryEntry,
  type BusinessMemoryInputRaw,
  type BusinessQuery,
  type HumanActor,
  type MemoryActor,
} from "@/core/memory";
import type { Database } from "@/server/database/client";
import { businessMemoryEntries as t } from "@/server/database/memory-schema";
import type { BusinessMemoryStore, FindResult } from "./ports";
import {
  lockKey,
  mapRow,
  notExpiredSql,
  resolveDeps,
  statsSql,
  toDate,
  visibleSql,
  type MemoryDeps,
} from "./sql";

const entity = "business_memory_entry";
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Mémoire utilisateur/business : déclarations humaines, séparées des logs runtime.
 * I6 : seuls les humains `record/approve/reject/retract` ; un worker ne peut que `propose`
 * (entrée invisible tant qu'un humain ne l'a pas approuvée). Les valeurs sont immuables
 * (trigger `IC003`) : modifier = nouvelle version, l'ancienne passe `superseded`.
 */
export class PostgresBusinessMemoryStore implements BusinessMemoryStore {
  private readonly deps;
  constructor(
    private readonly db: Database,
    deps?: MemoryDeps,
  ) {
    this.deps = resolveDeps(deps);
  }

  private prepare(actor: MemoryActor, raw: BusinessMemoryInputRaw) {
    assertTenant(actor);
    const i = businessMemoryInputSchema.parse(raw);
    assertSourceAllowed(actor, i.provenance.sourceType);
    assertConfidencePolicy({
      sourceType: i.provenance.sourceType,
      basis: i.confidence.basis,
      value: i.confidence.value,
    });
    assertNoSecrets({ summary: i.summary, value: i.value, subjectKey: i.subjectKey }, "business");
    const now = this.deps.now();
    const scopeKey = i.scope === "tenant" ? TENANT_SCOPE_KEY : (i.scopeKey as string);
    // Défaut : la mémoire d'un utilisateur est privée à cet utilisateur.
    const vis =
      i.visibility ??
      (i.scope === "user"
        ? { visibility: "private" as const, ownerSubject: scopeKey, requiredPermission: null }
        : { visibility: "tenant" as const, ownerSubject: null, requiredPermission: null });
    if (vis.visibility === "private" && !vis.ownerSubject)
      throw new MemoryPolicyError("visibilité privée sans propriétaire");
    const lastVerifiedAt = i.freshness?.lastVerifiedAt ?? now.toISOString();
    const windows = defaultFreshness("business", lastVerifiedAt);
    return {
      now,
      scopeKey,
      row: {
        id: this.deps.newId("bmem"),
        tenantId: actor.tenantId,
        sourceType: i.provenance.sourceType,
        sourceId: i.provenance.sourceId,
        recordedByType: actor.kind,
        recordedBy: actor.id,
        occurredAt: new Date(i.occurredAt),
        recordedAt: now,
        lastVerifiedAt: new Date(lastVerifiedAt),
        staleAfter: toDate(
          i.freshness?.staleAfter !== undefined ? i.freshness.staleAfter : windows.staleAfter,
        ),
        expiresAt: toDate(
          i.freshness?.expiresAt !== undefined ? i.freshness.expiresAt : windows.expiresAt,
        ),
        confidence: i.confidence.value,
        confidenceBasis: i.confidence.basis,
        visibility: vis.visibility,
        ownerSubject: vis.ownerSubject,
        requiredPermission: vis.requiredPermission,
        kind: i.kind,
        scope: i.scope,
        scopeKey,
        subjectKey: i.subjectKey,
        summary: i.summary,
        value: i.value,
      },
    };
  }

  /** Sérialise les activations d'un même sujet, retire l'ancienne version active, calcule la version. */
  private async supersedeActive(
    tx: Tx,
    e: { tenantId: string; scope: string; scopeKey: string; subjectKey: string },
  ) {
    await tx.execute(lockKey(e.tenantId, e.scope, e.scopeKey, e.subjectKey));
    const same = and(
      eq(t.tenantId, e.tenantId),
      eq(t.scope, e.scope),
      eq(t.scopeKey, e.scopeKey),
      eq(t.subjectKey, e.subjectKey),
    );
    const [prev] = await tx
      .select({ id: t.id })
      .from(t)
      .where(and(same, eq(t.status, "active")))
      .for("update");
    const [{ v }] = await tx
      .select({ v: max(t.version) })
      .from(t)
      .where(same);
    if (prev) await tx.update(t).set({ status: "superseded" }).where(eq(t.id, prev.id));
    return { supersedesId: prev?.id ?? null, version: (v ?? 0) + 1 };
  }

  async record(actor: HumanActor, raw: BusinessMemoryInputRaw): Promise<BusinessMemoryEntry> {
    assertHuman(actor);
    const { now, row } = this.prepare(actor, raw);
    return this.db.transaction(async (tx) => {
      const { supersedesId, version } = await this.supersedeActive(tx, row);
      const [created] = await tx
        .insert(t)
        .values({
          ...row,
          status: "active",
          version,
          supersedesId,
          decidedBy: actor.id,
          decidedAt: now,
        })
        .returning();
      return mapRow(businessMemoryEntrySchema, entity, created);
    });
  }

  async propose(actor: MemoryActor, raw: BusinessMemoryInputRaw): Promise<BusinessMemoryEntry> {
    const { row } = this.prepare(actor, raw);
    const [created] = await this.db
      .insert(t)
      .values({
        ...row,
        status: "proposed",
        version: null,
        decidedBy: null,
        decidedAt: null,
        supersedesId: null,
      })
      .returning();
    return mapRow(businessMemoryEntrySchema, entity, created);
  }

  async approve(actor: HumanActor, id: string): Promise<BusinessMemoryEntry> {
    assertHuman(actor);
    const now = this.deps.now();
    return this.db.transaction(async (tx) => {
      const [p] = await tx
        .select()
        .from(t)
        .where(and(eq(t.id, id), eq(t.tenantId, actor.tenantId)))
        .for("update");
      if (!p) throw new MemoryNotFoundError("business");
      if (p.status !== "proposed")
        throw new MemoryPolicyError(`approbation impossible depuis le statut '${p.status}'`);
      const { supersedesId, version } = await this.supersedeActive(tx, p);
      const [updated] = await tx
        .update(t)
        .set({
          status: "active",
          version,
          supersedesId,
          decidedBy: actor.id,
          decidedAt: now,
          lastVerifiedAt: now,
        })
        .where(eq(t.id, id))
        .returning();
      return mapRow(businessMemoryEntrySchema, entity, updated);
    });
  }

  private async decide(
    actor: HumanActor,
    id: string,
    from: "proposed" | "active",
    to: "rejected" | "retracted",
  ) {
    const now = this.deps.now();
    return this.db.transaction(async (tx) => {
      const [p] = await tx
        .select()
        .from(t)
        .where(and(eq(t.id, id), eq(t.tenantId, actor.tenantId)))
        .for("update");
      if (!p) throw new MemoryNotFoundError("business");
      if (p.status !== from)
        throw new MemoryPolicyError(`'${to}' impossible depuis le statut '${p.status}'`);
      // decided_* = dernière décision humaine ; l'historique est porté par la chaîne de versions.
      const [updated] = await tx
        .update(t)
        .set({ status: to, decidedBy: actor.id, decidedAt: now })
        .where(eq(t.id, id))
        .returning();
      return mapRow(businessMemoryEntrySchema, entity, updated);
    });
  }

  async reject(actor: HumanActor, id: string) {
    assertHuman(actor);
    return this.decide(actor, id, "proposed", "rejected");
  }

  async retract(actor: HumanActor, id: string) {
    assertHuman(actor);
    return this.decide(actor, id, "active", "retracted");
  }

  async listProposals(actor: HumanActor): Promise<BusinessMemoryEntry[]> {
    assertHuman(actor);
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.tenantId, actor.tenantId), eq(t.status, "proposed")))
      .orderBy(asc(t.occurredAt), asc(t.id));
    return rows.map((r) => mapRow(businessMemoryEntrySchema, entity, r));
  }

  async find(reader: MemoryActor, q: BusinessQuery): Promise<FindResult<BusinessMemoryEntry>> {
    assertTenant(reader);
    const now = this.deps.now();
    // Les propositions et rejets ne sont pas de la mémoire : ni retrouvés ni comptés.
    const scope = and(
      eq(t.tenantId, reader.tenantId),
      inArray(t.status, ["active", "superseded", "retracted"]),
      q.scope ? eq(t.scope, q.scope) : undefined,
      q.scopeKey ? eq(t.scopeKey, q.scopeKey) : undefined,
      q.subjectKeyPrefix ? sql`starts_with(${t.subjectKey}, ${q.subjectKeyPrefix})` : undefined,
      q.kinds ? inArray(t.kind, q.kinds) : undefined,
    );
    const active = eq(t.status, "active") as ReturnType<typeof sql>;
    const [stats] = await this.db
      .select(statsSql(t, reader, now, active))
      .from(t)
      .where(scope);
    const rows = await this.db
      .select()
      .from(t)
      .where(and(scope, visibleSql(t, reader), notExpiredSql(t, now), active))
      .orderBy(asc(t.scopeKey), asc(t.subjectKey), asc(t.id))
      .limit(q.limit);
    const entries = rows.map((r, i) => {
      const entry = mapRow(businessMemoryEntrySchema, entity, r);
      return { entry, freshness: freshnessOf(entry, now), rank: i + 1 };
    });
    return { entries, stats: { ...stats, returned: entries.length } };
  }
}

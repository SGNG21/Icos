import { and, count, eq, gte, sql } from "drizzle-orm";

import { memoryEntities, memoryRecords, memoryRelations } from "@/server/cognitive/schema";
import type { Database } from "@/server/database/client";
import { memoryRetrievalLog } from "@/server/database/memory-schema";
import { scheduledJobs, spendLedger } from "@/server/database/schema";

import type { MemoryFacts, SchedulerFacts, SpendFacts } from "./live-overview";

/**
 * AGRÉGATS DURABLES PARTAGÉS (scheduler, ledger de dépense, mémoire). Une seule
 * implémentation pour `loadTruthProjection` et `readLiveOverview` : la même table,
 * la même requête, la même lecture — pas deux projections qui divergent.
 *
 * - Lecture seule, bornée, filtrée sur `tenant_id` là où la colonne existe ;
 * - cache de processus court (`FACTS_TTL_MS`) : plusieurs onglets ou plusieurs panneaux
 *   d'une même page n'exécutent qu'un agrégat par fenêtre, et un vol en cours est partagé ;
 * - le ledger est lu par `cost_kind` et devise (décisions 0067/0078) : un `FREE_TIER` n'est
 *   pas un `COST` de montant 0, un `UNPRICED` n'est pas gratuit, un `UNMETERED` n'a pas de
 *   tokens, et deux devises ne s'additionnent pas.
 */

export const FACTS_TTL_MS = 10_000;
export const FACTS_DEADLINE_MS = 5_000;

const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();

interface CacheEntry<T> {
  at: number;
  value?: T;
  inFlight?: Promise<T>;
}

const CACHE_KEY = "__icosLiveFactsCache__";
type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: Map<string, CacheEntry<unknown>> };

function cacheMap(): Map<string, CacheEntry<unknown>> {
  const g = globalThis as GlobalWithCache;
  g[CACHE_KEY] ??= new Map();
  return g[CACHE_KEY];
}

export function resetLiveFactsCacheForTests(): void {
  delete (globalThis as GlobalWithCache)[CACHE_KEY];
}

/** Une lecture par clé et par TTL ; une lecture en vol est partagée ; un échec n'est pas mis en cache. */
async function cached<T>(key: string, now: () => number, run: () => Promise<T>): Promise<T> {
  const map = cacheMap();
  const entry = map.get(key) as CacheEntry<T> | undefined;
  if (entry?.value !== undefined && now() - entry.at < FACTS_TTL_MS) return entry.value;
  if (entry?.inFlight) return entry.inFlight;
  const inFlight = withDeadline(run(), FACTS_DEADLINE_MS);
  map.set(key, { at: entry?.at ?? 0, value: entry?.value, inFlight });
  try {
    const value = await inFlight;
    map.set(key, { at: now(), value });
    return value;
  } catch (error) {
    map.delete(key);
    throw error;
  }
}

/** Une requête qui ne répond pas dans le délai est un échec de lecture, pas une attente. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("LIVE_FACTS_DEADLINE")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface FactsOptions {
  now?: () => number;
  /** Désactive le cache (tests d'intégration). */
  noCache?: boolean;
}

function run<T>(key: string, options: FactsOptions, fn: () => Promise<T>): Promise<T> {
  const now = options.now ?? Date.now;
  return options.noCache ? withDeadline(fn(), FACTS_DEADLINE_MS) : cached(key, now, fn);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function readSchedulerFacts(
  db: Database,
  options: FactsOptions = {},
): Promise<SchedulerFacts> {
  return run("scheduler", options, async () => {
    const active = await db
      .select({ kind: scheduledJobs.kind, n: count() })
      .from(scheduledJobs)
      .where(sql`${scheduledJobs.state} in ('scheduled', 'running')`)
      .groupBy(scheduledJobs.kind);
    const [agg] = await db
      .select({
        leased: sql<number>`count(*) filter (where ${scheduledJobs.leaseUntil} > now())`,
        dead: sql<number>`count(*) filter (where ${scheduledJobs.state} = 'dead')`,
        dead24h: sql<number>`count(*) filter (where ${scheduledJobs.state} = 'dead' and ${scheduledJobs.updatedAt} > now() - interval '24 hours')`,
        last: sql<Date | null>`max(${scheduledJobs.updatedAt})`,
      })
      .from(scheduledJobs);
    return {
      activeByKind: Object.fromEntries(active.map((r) => [r.kind, Number(r.n)])),
      leased: Number(agg?.leased ?? 0),
      dead: Number(agg?.dead ?? 0),
      dead24h: Number(agg?.dead24h ?? 0),
      lastUpdatedAt: iso(agg?.last ?? null),
    };
  });
}

export function readSpendFacts(
  db: Database,
  tenantId: string,
  since: Date,
  options: FactsOptions = {},
): Promise<SpendFacts> {
  return run(`spend:${tenantId}`, options, async () => {
    const rows = await db
      .select({
        costKind: spendLedger.costKind,
        currency: spendLedger.currency,
        calls: count(),
        unmetered: sql<number>`count(*) filter (where ${spendLedger.usageKind} <> 'METERED')`,
        tokens: sql<number | null>`sum(${spendLedger.totalTokens})`,
        /* Le schéma (0055) impose tokens NOT NULL aux appels METERED : un total NULL est un appel UNMETERED. */
        tokensUnknown: sql<number>`count(*) filter (where ${spendLedger.totalTokens} is null)`,
        amount: sql<number | null>`sum(${spendLedger.amount})`,
        last: sql<Date | null>`max(${spendLedger.observedAt})`,
      })
      .from(spendLedger)
      .where(and(eq(spendLedger.tenantId, tenantId), gte(spendLedger.observedAt, since)))
      .groupBy(spendLedger.costKind, spendLedger.currency);

    const facts: SpendFacts = {
      calls24h: 0,
      metered24h: 0,
      unmetered24h: 0,
      priced24h: 0,
      freeTier24h: 0,
      unpriced24h: 0,
      tokens24h: 0,
      tokensUnknown24h: 0,
      amount24h: null,
      currency: null,
      currencies: 0,
      lastObservedAt: null,
      ledgerTenantId: tenantId,
    };
    const currencies = new Set<string>();
    let costAmount = 0;
    let last: string | null = null;
    for (const r of rows) {
      const calls = Number(r.calls);
      const unmetered = Number(r.unmetered);
      facts.calls24h += calls;
      facts.unmetered24h += unmetered;
      facts.metered24h += calls - unmetered;
      facts.tokens24h += Number(r.tokens ?? 0);
      facts.tokensUnknown24h += Number(r.tokensUnknown);
      const metered = calls - unmetered;
      if (r.costKind === "COST") {
        facts.priced24h += metered;
        if (r.currency) currencies.add(r.currency);
        costAmount += Number(r.amount ?? 0);
      } else if (r.costKind === "FREE_TIER") {
        facts.freeTier24h += metered;
        if (r.currency) currencies.add(r.currency);
      } else {
        /* UNPRICED, ou cost_kind inconnu : un prix qu'on ne sait pas prouver. */
        facts.unpriced24h += metered;
      }
      const l = iso(r.last);
      if (l && (!last || l > last)) last = l;
    }
    facts.currencies = currencies.size;
    facts.currency = currencies.size === 1 ? [...currencies][0] : null;
    facts.amount24h =
      facts.unpriced24h === 0 && currencies.size <= 1 && facts.priced24h > 0 ? costAmount : null;
    facts.lastObservedAt = last;
    return facts;
  });
}

export function readMemoryFacts(
  db: Database,
  tenantId: string,
  since: Date,
  options: FactsOptions = {},
): Promise<MemoryFacts> {
  return run(`memory:${tenantId}`, options, async () => {
    const [m] = await db
      .select({
        records: count(),
        active: sql<number>`count(*) filter (where ${memoryRecords.status} = 'active')`,
        last: sql<Date | null>`max(${memoryRecords.updatedAt})`,
      })
      .from(memoryRecords)
      .where(eq(memoryRecords.tenantId, tenantId));
    const [r] = await db
      .select({ n: count() })
      .from(memoryRetrievalLog)
      .where(
        and(eq(memoryRetrievalLog.tenantId, tenantId), gte(memoryRetrievalLog.retrievedAt, since)),
      );
    const [e] = await db
      .select({ n: count() })
      .from(memoryEntities)
      .where(eq(memoryEntities.tenantId, tenantId));
    const [rel] = await db
      .select({ n: count() })
      .from(memoryRelations)
      .where(eq(memoryRelations.tenantId, tenantId));
    return {
      records: Number(m?.records ?? 0),
      active: Number(m?.active ?? 0),
      retrievals24h: Number(r?.n ?? 0),
      entities: Number(e?.n ?? 0),
      relations: Number(rel?.n ?? 0),
      lastWriteAt: iso(m?.last ?? null),
    };
  });
}

export const sinceDay = (now: Date): Date => new Date(now.getTime() - DAY_MS);

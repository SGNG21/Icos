import { count, gte, sql } from "drizzle-orm";

import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { AuthenticatedSession } from "@/core/identity";
import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import type { ServiceHealth } from "@/core/telemetry";
import { resolveOperationalScope, isMissionInScope } from "@/server/administration/mission-scope";
import { memoryEntities, memoryRecords, memoryRelations } from "@/server/cognitive/schema";
import type { Container } from "@/server/container";
import { memoryRetrievalLog } from "@/server/database/memory-schema";
import { scheduledJobs, spendLedger } from "@/server/database/schema";
import { getHostTelemetrySampler } from "@/server/telemetry/host-sampler";
import { getServiceProbes } from "@/server/telemetry/service-probes";

import {
  buildLiveOverview,
  type LiveOverview,
  type LiveOverviewInputs,
  type MemoryFacts,
  type SchedulerFacts,
  type SpendFacts,
  type VpsFacts,
} from "./live-overview";
import type { MissionWithTasks } from "./snapshot";
import { missing, real, type Truth } from "./truth";

/**
 * LECTURES SERVEUR DE LA VUE LIVE. Même discipline que `load.ts` : chaque source
 * est lue isolément, en lecture seule, bornée, sous la portée opérationnelle de
 * l'appelant ; un échec devient une `Truth` manquante, jamais une valeur par défaut.
 *
 * Les sources tenant-wide (scheduler, registre, ledger, mémoire, hôte) ne sont
 * lisibles qu'en portée globale (owner/admin), comme dans `loadTruthProjection`.
 * Aucune requête SQL n'est paramétrée par le client ; aucune écriture.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SCOPE_REASON = "visible to owner/admin scope only";

async function read<T>(label: string, fn: () => Promise<T>): Promise<Truth<T>> {
  try {
    return real(await fn());
  } catch {
    return missing("unknown", `${label} could not be read from ICOS.`);
  }
}

const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();

export interface LiveReadOptions {
  now?: Date;
  /**
   * Faits déjà lus par `loadSources()` (même requête, même portée) : évite une seconde
   * lecture des missions (N+1) et du registre quand une page les a déjà chargés.
   */
  preloaded?: Pick<LiveOverviewInputs, "missions" | "attempts" | "workers" | "activeAssignments">;
  /** Injectable pour les tests ; par défaut l'échantillonneur et les sondes du processus. */
  vps?: () => Promise<VpsFacts>;
  services?: () => Promise<ServiceHealth[]>;
}

async function defaultVps(): Promise<VpsFacts> {
  const snapshot = await getHostTelemetrySampler().snapshot();
  const c = snapshot.current;
  const root = c.disks[0]?.capacity;
  return {
    hostname: snapshot.hostname.available ? snapshot.hostname.value : null,
    sampledAt: c.at,
    overall: snapshot.overall,
    cores: c.cpu.cores,
    cpuUsage: c.cpu.usage.available ? c.cpu.usage.value : null,
    load1: c.cpu.load.available ? c.cpu.load.value.one : null,
    memoryRatio: c.memory.available ? c.memory.value.ratio : null,
    diskRatio: root?.available ? root.value.ratio : null,
    vram: "NO_TELEMETRY",
  };
}

/** Lit la vue live pour une session déjà authentifiée (`cockpit.read` vérifié en amont). */
export async function readLiveOverview(
  container: Container,
  session: AuthenticatedSession,
  options: LiveReadOptions = {},
): Promise<LiveOverview> {
  const now = options.now ?? new Date();
  const scope = await resolveOperationalScope(container, session);
  const global = scope.kind === "global";
  const outOfScope = <T>() => missing<T>("not_available", `This source is ${SCOPE_REASON}.`);
  const db = container.db;
  const noDb = <T>() => missing<T>("not_connected", "This process has no durable database.");
  const since = new Date(now.getTime() - DAY_MS);

  /*
   * Mono-tenant canonique (shim `CURRENT_SINGLE_TENANT_ID`) : le tenant vient de la
   * composition, jamais d'un paramètre, d'un en-tête ou d'un cookie du client.
   */
  const tenantId = CURRENT_SINGLE_TENANT_ID;

  const pre = options.preloaded;
  const [missions, workers, activeAssignments, scheduler, spend, memory, services, vps] =
    await Promise.all([
      pre
        ? Promise.resolve(pre.missions)
        : read("Missions", async () => {
            const out: MissionWithTasks[] = [];
            for (const mission of await container.mission.list()) {
              const tasks = await container.mission.listTasks(mission.id);
              if (await isMissionInScope(container, mission.id, scope, tasks))
                out.push({ mission, tasks });
            }
            return out;
          }),
      pre
        ? Promise.resolve(pre.workers)
        : global
          ? read("Worker registry", () => container.workerRegistryStore.list())
          : outOfScope<WorkerRegistryEntry[]>(),
      pre
        ? Promise.resolve(pre.activeAssignments)
        : global
          ? read("Dispatch ledger", () => container.dispatchAttempts.listActiveWorkerAssignments())
          : outOfScope<string[]>(),
      !global
        ? outOfScope<SchedulerFacts>()
        : !db
          ? noDb<SchedulerFacts>()
          : read("Durable scheduler", async () => {
              const active = await db
                .select({ kind: scheduledJobs.kind, n: count() })
                .from(scheduledJobs)
                .where(sql`${scheduledJobs.state} in ('scheduled', 'running')`)
                .groupBy(scheduledJobs.kind);
              const [agg] = await db
                .select({
                  leased: sql<number>`count(*) filter (where ${scheduledJobs.leaseUntil} > now())`,
                  dead: sql<number>`count(*) filter (where ${scheduledJobs.state} = 'dead')`,
                  last: sql<Date | null>`max(${scheduledJobs.updatedAt})`,
                })
                .from(scheduledJobs);
              return {
                activeByKind: Object.fromEntries(active.map((r) => [r.kind, Number(r.n)])),
                leased: Number(agg?.leased ?? 0),
                dead: Number(agg?.dead ?? 0),
                lastUpdatedAt: iso(agg?.last ?? null),
              };
            }),
      !global
        ? outOfScope<SpendFacts>()
        : !db
          ? noDb<SpendFacts>()
          : read("Spend ledger", async () => {
              const [row] = await db
                .select({
                  calls: count(),
                  tokens: sql<number>`coalesce(sum(${spendLedger.totalTokens}), 0)`,
                  unpriced: sql<number>`count(*) filter (where ${spendLedger.amount} is null)`,
                  amount: sql<number | null>`sum(${spendLedger.amount})`,
                  currency: sql<string | null>`min(${spendLedger.currency})`,
                  last: sql<Date | null>`max(${spendLedger.observedAt})`,
                })
                .from(spendLedger)
                .where(gte(spendLedger.observedAt, since));
              const unpriced = Number(row?.unpriced ?? 0);
              return {
                calls24h: Number(row?.calls ?? 0),
                tokens24h: Number(row?.tokens ?? 0),
                unpriced24h: unpriced,
                amount24h: unpriced === 0 && row?.amount != null ? Number(row.amount) : null,
                currency: row?.currency ?? null,
                lastObservedAt: iso(row?.last ?? null),
              };
            }),
      !global
        ? outOfScope<MemoryFacts>()
        : !db
          ? noDb<MemoryFacts>()
          : read("Durable memory", async () => {
              const [m] = await db
                .select({
                  records: count(),
                  active: sql<number>`count(*) filter (where ${memoryRecords.status} = 'active')`,
                  last: sql<Date | null>`max(${memoryRecords.updatedAt})`,
                })
                .from(memoryRecords);
              const [r] = await db
                .select({ n: count() })
                .from(memoryRetrievalLog)
                .where(gte(memoryRetrievalLog.retrievedAt, since));
              const [e] = await db.select({ n: count() }).from(memoryEntities);
              const [rel] = await db.select({ n: count() }).from(memoryRelations);
              return {
                records: Number(m?.records ?? 0),
                active: Number(m?.active ?? 0),
                retrievals24h: Number(r?.n ?? 0),
                entities: Number(e?.n ?? 0),
                relations: Number(rel?.n ?? 0),
                lastWriteAt: iso(m?.last ?? null),
              };
            }),
      global
        ? read("Service probes", async () =>
            options.services
              ? options.services()
              : (await getServiceProbes(container.databaseHealth).collect()).services,
          )
        : outOfScope<ServiceHealth[]>(),
      global ? read("Host telemetry", options.vps ?? defaultVps) : outOfScope<VpsFacts>(),
    ]);

  const attempts: Truth<DispatchAttempt[]> = pre
    ? pre.attempts
    : missions.kind === "real"
      ? await read("Dispatch attempts", async () => {
          const active = missions.value
            .flatMap((m) => m.tasks)
            .filter(
              (t) =>
                t.status === "queued" || t.status === "running" || t.status === "review_pending",
            );
          const lists = await Promise.all(
            active.map((t) => container.dispatchAttempts.listNonTerminalByMissionTaskId(t.id)),
          );
          return lists.flat();
        })
      : missions;

  return buildLiveOverview({
    now,
    scope: global ? "global" : "linked",
    tenantId,
    missions,
    attempts,
    scheduler,
    workers,
    activeAssignments,
    spend,
    services,
    memory,
    vps,
  });
}

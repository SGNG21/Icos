import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { AuthenticatedSession } from "@/core/identity";
import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import type { ServiceHealth } from "@/core/telemetry";
import { resolveOperationalScope, isMissionInScope } from "@/server/administration/mission-scope";
import { SPEND_LEDGER_TENANT_ID } from "@/server/budget/compose-spend";
import type { Container } from "@/server/container";
import type { AgentScope } from "@/server/repositories/ports";
import { getHostTelemetrySampler } from "@/server/telemetry/host-sampler";
import { getServiceProbes } from "@/server/telemetry/service-probes";

import { readMemoryFacts, readSchedulerFacts, readSpendFacts, sinceDay } from "./live-facts";
import {
  buildLiveOverview,
  type LiveOverview,
  type LiveOverviewInputs,
  type MemoryFacts,
  type SchedulerFacts,
  type SpendFacts,
  type VpsFacts,
} from "./live-overview";
import { scopeRefused } from "./observed";
import type { MissionWithTasks } from "./snapshot";
import { missing, real, type Truth } from "./truth";

/**
 * LECTURES SERVEUR DE LA VUE LIVE. Même discipline que `load.ts` : chaque source
 * est lue isolément, en lecture seule, bornée, sous la portée opérationnelle de
 * l'appelant ; un échec devient une `Truth` manquante, jamais une valeur par défaut.
 *
 * Les sources tenant-wide (scheduler, registre, ledger, mémoire, hôte) ne sont
 * lisibles qu'en portée globale (owner/admin), comme dans `loadTruthProjection`, et
 * répondent alors par un refus STRUCTURÉ (`scopeRefused`). Les agrégats durables
 * passent par `live-facts.ts` (cache 10 s, délai 5 s, filtre `tenant_id`).
 * Aucune requête SQL n'est paramétrée par le client ; aucune écriture.
 */

async function read<T>(label: string, fn: () => Promise<T>): Promise<Truth<T>> {
  try {
    return real(await fn());
  } catch {
    return missing("unknown", `${label} could not be read from ICOS.`);
  }
}

export interface LiveReadOptions {
  now?: Date;
  /** Portée déjà résolue par l'appelant (page) ; sinon résolue ici (route). */
  scope?: AgentScope;
  /**
   * Faits déjà lus par `loadSources()` (même requête, même portée) : évite une seconde
   * lecture des missions (N+1) et du registre quand une page les a déjà chargés.
   */
  preloaded?: Pick<LiveOverviewInputs, "missions" | "attempts" | "workers" | "activeAssignments">;
  /** Injectable pour les tests ; par défaut l'échantillonneur et les sondes du processus. */
  vps?: () => Promise<VpsFacts>;
  services?: () => Promise<ServiceHealth[]>;
  /** Tests d'intégration : agrégats sans cache de processus. */
  noFactsCache?: boolean;
}

async function defaultVps(): Promise<VpsFacts> {
  const snapshot = await getHostTelemetrySampler().snapshot();
  const c = snapshot.current;
  const root = c.disks[0]?.capacity;
  return {
    hostname: snapshot.hostname.available ? snapshot.hostname.value : null,
    sampledAt: c.at,
    overall: snapshot.overall,
    /* L'échantillonneur rend 0 quand /proc/stat est illisible : ce n'est pas un nombre de cœurs. */
    cores: c.cpu.cores > 0 ? c.cpu.cores : null,
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
  const started = options.now ?? new Date();
  const scope = options.scope ?? (await resolveOperationalScope(container, session));
  const global = scope.kind === "global";
  const db = container.db;
  const noDb = <T>() => missing<T>("not_connected", "This process has no durable database.");
  const since = sinceDay(started);
  const facts = { noCache: options.noFactsCache === true };

  /*
   * Mono-tenant canonique (shim `CURRENT_SINGLE_TENANT_ID`) : le tenant vient de la
   * composition, jamais d'un paramètre, d'un en-tête ou d'un cookie du client, et il
   * filtre chaque agrégat qui porte une colonne `tenant_id`.
   *
   * ÉCART CONSTATÉ (D3) : le ledger de dépense est écrit sous SON propre tenant
   * (`SPEND_LEDGER_TENANT_ID`, « icos-holding », compose-spend.ts), distinct du shim
   * (« default ») utilisé par la mémoire durable. Le lecteur suit la constante du writer
   * pour chaque table ; la réconciliation des deux vocabulaires est une décision propriétaire.
   */
  const tenantId = CURRENT_SINGLE_TENANT_ID;
  const ledgerTenantId = SPEND_LEDGER_TENANT_ID;

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
          : scopeRefused<WorkerRegistryEntry[]>("Worker infrastructure"),
      pre
        ? Promise.resolve(pre.activeAssignments)
        : global
          ? read("Dispatch ledger", () => container.dispatchAttempts.listActiveWorkerAssignments())
          : scopeRefused<string[]>("Worker infrastructure"),
      !global
        ? scopeRefused<SchedulerFacts>("The durable scheduler")
        : !db
          ? noDb<SchedulerFacts>()
          : read("Durable scheduler", () => readSchedulerFacts(db, facts)),
      !global
        ? scopeRefused<SpendFacts>("The spend ledger")
        : !db
          ? noDb<SpendFacts>()
          : read("Spend ledger", () => readSpendFacts(db, ledgerTenantId, since, facts)),
      !global
        ? scopeRefused<MemoryFacts>("Durable memory")
        : !db
          ? noDb<MemoryFacts>()
          : read("Durable memory", () => readMemoryFacts(db, tenantId, since, facts)),
      global
        ? read("Service probes", async () =>
            options.services
              ? options.services()
              : (await getServiceProbes(container.databaseHealth).collect()).services,
          )
        : scopeRefused<ServiceHealth[]>("Service probes"),
      global
        ? read("Host telemetry", options.vps ?? defaultVps)
        : scopeRefused<VpsFacts>("Host telemetry"),
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
    /* Acquisition datée APRÈS les lectures : un âge ne peut pas être négatif par construction. */
    now: new Date(),
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

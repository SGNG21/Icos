/**
 * VÉRIFICATION LECTURE SEULE DE LA VUE LIVE DU COCKPIT (mission COCKPIT-LIVE, D1/D3).
 *
 * Exécute `readLiveOverview` et les sondes de télémétrie contre une base RÉELLE avec un
 * container MINIMAL (repositories de lecture uniquement) : aucun scheduler, aucun sweeper,
 * aucune composition de service n'est démarrée. La connexion PostgreSQL est ouverte avec
 * `default_transaction_read_only=on` : toute écriture échouerait côté serveur.
 *
 *   pnpm exec tsx scripts/cockpit-live-verify.ts --env-file /chemin/vers/icos.env \
 *     [--omniroute http://127.0.0.1:20129] [--out rapport.json] [--second-sample]
 *
 * Le fichier d'environnement n'est lu que pour DATABASE_URL ; rien n'en est affiché.
 * La sortie ne contient ni URL de connexion, ni secret (contrôlé avant écriture).
 */
import { readFile, writeFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { AuthenticatedSession } from "@/core/identity";
import { readLiveOverview } from "@/features/cockpit/live-sources";
import { OperationalAccessService } from "@/server/administration/operational-access-service";
import type { Container } from "@/server/container";
import { createDatabaseHealth } from "@/server/database/health";
import * as schema from "@/server/database/schema";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { getHostTelemetrySampler } from "@/server/telemetry/host-sampler";
import { createOmniRouteMonitor } from "@/server/telemetry/omniroute-monitoring";
import { ServiceProbes, workerCapacity } from "@/server/telemetry/service-probes";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function databaseUrlFrom(envFile: string): Promise<string> {
  const text = await readFile(envFile, "utf8");
  const line = text.split("\n").find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  if (!line) throw new Error("DATABASE_URL absent du fichier d'environnement");
  return line
    .replace(/^\s*DATABASE_URL\s*=/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

async function main(): Promise<void> {
  const envFile = arg("--env-file");
  if (!envFile) throw new Error("--env-file requis");
  const omnirouteBase = arg("--omniroute") ?? "http://127.0.0.1:20129";
  const out = arg("--out");
  const secondSample = process.argv.includes("--second-sample");

  const url = await databaseUrlFrom(envFile);
  const sql = postgres(url, {
    max: 2,
    connect_timeout: 10,
    // Garde-fou : la session refuse toute écriture ; les lectures restent identiques.
    connection: {
      default_transaction_read_only: true,
      application_name: "icos-cockpit-live-verify",
    },
  });
  const db = drizzle(sql, { schema });
  try {
    const tasks = new PostgresTaskRepository(db);
    const container = {
      db,
      databaseHealth: createDatabaseHealth(sql),
      tasks,
      mission: new PostgresMissionRepository(db, tasks),
      dispatchAttempts: new PostgresDispatchAttemptRepository(db),
      workerRegistryStore: new PostgresWorkerRegistryStore(db),
      operationalAccess: new OperationalAccessService({
        listAgentIdsForHuman: async () => new Set<string>(),
      } as never),
    } as unknown as Container;
    const session: AuthenticatedSession = {
      user: { id: "verify-owner", email: "verify@localhost", status: "active" },
      roles: ["owner"],
    };
    const probes = new ServiceProbes({
      database: container.databaseHealth,
      omniRoute: createOmniRouteMonitor(omnirouteBase),
      omniRouteConnected: true,
    });

    const started = Date.now();
    const overview = await readLiveOverview(container, session, {
      services: async () => (await probes.collect()).services,
    });
    const overviewMs = Date.now() - started;

    const sampler = getHostTelemetrySampler();
    const first = await sampler.snapshot();
    let second = null;
    if (secondSample) {
      await new Promise((r) => setTimeout(r, 11_000));
      second = await sampler.snapshot();
    }
    const [workers, assignments] = await Promise.all([
      container.workerRegistryStore.list(),
      container.dispatchAttempts.listActiveWorkerAssignments(),
    ]);
    const capacity = workerCapacity(first.headroom, {
      workers: workers.map((w) => ({ status: w.status, maxConcurrency: w.maxConcurrency })),
      activeAssignments: assignments,
    });

    const report = {
      verifiedAt: new Date().toISOString(),
      overviewMs,
      overview,
      telemetry: {
        first: {
          at: first.current.at,
          overall: first.overall,
          cpu: first.current.cpu.usage,
          load: first.current.cpu.load,
          memory: first.current.memory,
          services: first.services.map((s) => ({ key: s.key, state: s.state })),
        },
        second: second && {
          at: second.current.at,
          overall: second.overall,
          cpu: second.current.cpu.usage,
          load: second.current.cpu.load,
          memory: second.current.memory,
        },
        workers: capacity,
      },
    };
    const text = JSON.stringify(report, null, 2);
    if (/postgres(ql)?:\/\/|password|secret|bearer|api[_-]?key/i.test(text)) {
      throw new Error("la sortie contient un motif sensible : non écrite");
    }
    if (out) await writeFile(out, text, "utf8");
    const s = overview.sources;
    console.log(
      `overview in ${overviewMs} ms, scope=${overview.scope}, tenant=${s.core3.tenantId}`,
    );
    for (const [k, v] of Object.entries(s)) {
      console.log(
        `${k.padEnd(9)} ${v.state.padEnd(11)} observedAt=${v.observedAt ?? "null"} maxAgeMs=${v.maxAgeMs} ${v.errorCode ?? ""}`,
      );
    }
    console.log(`incidents: ${overview.incidents.map((i) => i.code).join(", ") || "none"}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

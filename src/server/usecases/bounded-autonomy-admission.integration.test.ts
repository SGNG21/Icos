import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { eq, sql } from "drizzle-orm";

import { modelAllowlist } from "@/core/autonomy/model-allowlist";
import { createDatabase } from "@/server/database/client";
import { autonomousMissionRuntime } from "@/server/database/schema";
import { PostgresAutonomousMissionRuntimeRepository } from "@/server/repositories/postgres/autonomous-mission-runtime-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresScheduledJobRepository } from "@/server/scheduler/postgres-scheduled-job-repository";
import { createSchedulerHandlers } from "@/server/scheduler/scheduler-handlers";
import { SchedulerService } from "@/server/scheduler/scheduler-service";
import type { AutonomyCompositionPolicy } from "@/server/usecases/start-autonomous-mission";

/**
 * LA DEMANDE DU PROPRIÉTAIRE DOIT ÊTRE OBSERVABLE DANS LA LIGNE PERSISTÉE (P0-E).
 *
 * Un plafond qui n'existe que dans le retour d'un résolveur n'engage rien : le runner
 * applique `runtime.max*`, c'est-à-dire LES COLONNES. Ce test parcourt donc le vrai
 * chemin d'admission — `SchedulerService.enqueue` -> job durable en base -> `claimDue`
 * (le payload revient réellement du jsonb) -> handler `start_mission` ->
 * `igniteAutonomousMission` -> `startAutonomousMission` — et lit ensuite les colonnes
 * de `autonomous_mission_runtime` en SQL, pas un objet en mémoire.
 */

const handle = createDatabase(TEST_DATABASE_URL);

const OWNER = "bounded-autonomy-admission-test";

function handlersWith(policy: AutonomyCompositionPolicy = {}) {
  const tasks = new PostgresTaskRepository(handle.db);
  const missions = new PostgresMissionRepository(handle.db, tasks);

  return createSchedulerHandlers({
    ignite: {
      missions,
      runtimeRepository: new PostgresAutonomousMissionRuntimeRepository(handle.db),
      /* Ni planification ni dispatch ici : la ligne de runtime est ce qu'on observe. */
      supervisor: {
        run: vi.fn().mockResolvedValue(undefined),
        reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      },
      planner: {
        plan: vi.fn().mockResolvedValue({
          version: 1,
          tasks: [{ key: "a", title: "A", description: "do a", dependsOn: [] }],
        }),
      },
      ...policy,
    },
    missions,
    wakeup: { wake: vi.fn().mockResolvedValue(null) },
  });
}

/** Les colonnes durables, lues telles que la base les stocke. */
async function persistedCaps(missionId: string) {
  const rows = await handle.db
    .select({
      maxRuntimeMs: autonomousMissionRuntime.maxRuntimeMs,
      maxCycles: autonomousMissionRuntime.maxCycles,
      maxReplans: autonomousMissionRuntime.maxReplans,
      maxStagnationCycles: autonomousMissionRuntime.maxStagnationCycles,
      replanCount: autonomousMissionRuntime.replanCount,
    })
    .from(autonomousMissionRuntime)
    .where(eq(autonomousMissionRuntime.missionId, missionId));

  return rows[0] ?? null;
}

/** Admet le job PUIS le reprend de la base, pour que le payload traverse le jsonb. */
async function admitAndRun(
  payload: Record<string, unknown>,
  policy: AutonomyCompositionPolicy = {},
) {
  const jobs = new PostgresScheduledJobRepository(handle.db);
  const { job } = await new SchedulerService(jobs).enqueue({
    kind: "start_mission",
    idempotencyKey: `bounded-${payload.title as string}`,
    payload,
  });

  const claimed = await jobs.claimDue(OWNER, 60_000);
  expect(claimed?.id).toBe(job.id);

  return {
    missionId: job.missionId as string,
    run: () => handlersWith(policy).start_mission(claimed!, { signal: new AbortController().signal }),
  };
}

describe("admission bornée d'une mission autonome (bout en bout, Postgres)", () => {
  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql.raw(
        "TRUNCATE TABLE autonomous_mission_runtime, scheduled_jobs, missions, tasks RESTART IDENTITY CASCADE",
      ),
    );
  });

  /*
   * LE TEST EXIGÉ : exactement 30 min / 20 cycles / 2 replans, DANS LA LIGNE PERSISTÉE.
   */
  it("persists EXACTLY 30 min / 20 cycles / 2 replans requested at admission", async () => {
    const admitted = await admitAndRun({
      title: "Mission bornée",
      objective: "Une mission autonome bon marché et bornée",
      bounds: { maxRuntimeMs: 30 * 60 * 1000, maxCycles: 20, maxReplans: 2 },
    });

    await admitted.run();

    const caps = await persistedCaps(admitted.missionId);

    expect(caps?.maxRuntimeMs).toBe(30 * 60 * 1000);
    expect(caps?.maxCycles).toBe(20);
    expect(caps?.maxReplans).toBe(2);
    /* Non demandé = la valeur du plafond, exactement comme avant. */
    expect(caps?.maxStagnationCycles).toBe(3);
  });

  it("garde les plafonds historiques quand l'admission n'en demande aucun", async () => {
    const admitted = await admitAndRun({
      title: "Mission par défaut",
      objective: "Comportement d'avant, au bit près",
    });

    await admitted.run();

    const caps = await persistedCaps(admitted.missionId);

    expect(caps?.maxRuntimeMs).toBe(60 * 60 * 1000);
    expect(caps?.maxCycles).toBe(100);
    expect(caps?.maxReplans).toBe(5);
    expect(caps?.maxStagnationCycles).toBe(3);
  });

  it("ROGNE un élargissement au plafond du déploiement au lieu de l'accorder", async () => {
    const admitted = await admitAndRun(
      {
        title: "Mission gourmande",
        objective: "Demande 24 h et 100000 cycles",
        bounds: { maxRuntimeMs: 24 * 60 * 60 * 1000, maxCycles: 100_000 },
      },
      {
        /* Déploiement volontairement plus serré que le plafond de politique. */
        options: {
          maxRuntimeMs: 30 * 60 * 1000,
          maxCycles: 20,
          maxStagnationCycles: 2,
          maxReplans: 2,
        },
      },
    );

    await admitted.run();

    const caps = await persistedCaps(admitted.missionId);

    expect(caps?.maxRuntimeMs).toBe(30 * 60 * 1000);
    expect(caps?.maxCycles).toBe(20);
  });

  /*
   * P0-F : un goal ne s'octroie JAMAIS un modèle que le système n'autorise pas. Le refus
   * est durable au sens inverse : AUCUNE ligne de runtime n'est créée.
   */
  it("REFUSES a goal asking for a model outside the system set, and persists NO runtime", async () => {
    const admitted = await admitAndRun(
      {
        title: "Mission hors pool",
        objective: "Demande un modèle que le système n'autorise pas",
        computePolicy: { allowedModels: ["expensive-model"] },
      },
      {
        systemModelAllowlist: modelAllowlist(["cheap-model"]),
        plannerCompute: { modelId: "cheap-model", providerId: "omniroute" },
      },
    );

    await expect(admitted.run()).rejects.toThrow(/COMPUTE_REFUSED:modelIds:expensive-model/);

    expect(await persistedCaps(admitted.missionId)).toBeNull();
  });

  it("démarre quand le pool du goal est un SOUS-ENSEMBLE qui couvre le compute configuré", async () => {
    const admitted = await admitAndRun(
      {
        title: "Mission dans le pool",
        objective: "Restreint au modèle bon marché",
        bounds: { maxRuntimeMs: 30 * 60 * 1000, maxCycles: 20, maxReplans: 2 },
        computePolicy: { allowedModels: ["cheap-model"] },
      },
      {
        systemModelAllowlist: modelAllowlist(["cheap-model", "expensive-model"]),
        plannerCompute: { modelId: "cheap-model", providerId: "omniroute" },
      },
    );

    await admitted.run();

    const caps = await persistedCaps(admitted.missionId);

    expect(caps?.maxCycles).toBe(20);
    expect(caps?.maxReplans).toBe(2);
    /* Le plafond persisté est bien celui que le runner applique. */
    expect(caps?.replanCount).toBeLessThanOrEqual(2);
  });
});

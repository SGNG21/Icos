/**
 * Enqueue d'un job du Durable Scheduler — adaptateur CLI MINCE autour de
 * `SchedulerService.enqueue` (même validation, même idempotence que
 * POST /api/scheduler/jobs, aucune logique métier ici).
 *
 * Usage : pnpm scheduler:enqueue '<json>'
 *   ex. '{"kind":"start_mission","payload":{"title":"…","objective":"…"},"idempotencyKey":"k","runAt":"2026-09-20T08:00:00Z"}'
 *
 * Aucun secret n'est lu dans le JSON ni affiché. Exige PERSISTENCE=postgres.
 */
import { loadEnv } from "@/config/env";
import { createContainer } from "@/server/container";
import { toScheduledJobDto } from "@/server/scheduler/scheduled-job-dto";
import { SchedulerValidationError } from "@/server/scheduler/scheduler-service";

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) throw new Error("usage: pnpm scheduler:enqueue '<json>'");
  const env = loadEnv();
  if (env.PERSISTENCE !== "postgres") throw new Error("PERSISTENCE=postgres est requis.");

  const container = await createContainer({ env });
  try {
    const { job, created } = await container.scheduler.enqueue(JSON.parse(raw));
    console.log(JSON.stringify({ created, job: toScheduledJobDto(job) }));
  } catch (error) {
    if (error instanceof SchedulerValidationError) {
      throw new Error(`SCHEDULER_INVALID_JOB ${JSON.stringify(error.zodError.issues.map((i) => i.path.join(".")))}`);
    }
    throw error;
  } finally {
    await container.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

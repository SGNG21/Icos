/**
 * The canonical ICOS execution worker — a THIN adapter around
 * `src/server/execution/temporal` (no business logic here).
 *
 *   pnpm worker:temporal
 *
 * Replaces the out-of-repo proof-of-concept that ICOS used to depend on for every
 * autonomous execution. Same queue, same workflow type and same payload, so the existing
 * dispatcher reaches it unchanged — what differs is that the work now runs under ICOS's
 * governed gateway instead of a bare `execFile`.
 *
 * Reads `.env.local` the same way the voice host does, so one configuration serves both.
 * Never prints a secret: the startup line names the address, queue and timeout only.
 */
import { Worker, NativeConnection } from "@temporalio/worker";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file); // never overrides an already-set variable
  } catch {
    // optional file
  }
}

const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "icos-tasks";

/*
 * The worker calls ICOS back over HTTP, so it must know where ICOS listens. Defaulting to
 * a port nobody serves is how the previous worker spent fifteen days reporting every
 * execution into a closed socket, so this fails closed instead.
 */
const baseUrl = process.env.ICOS_BASE_URL;
if (!baseUrl) {
  console.error("ICOS_BASE_URL est requis : le worker doit savoir où rappeler ICOS.");
  process.exit(1);
}
const secret = process.env.ICOS_EXECUTION_CALLBACK_SECRET;
if (!secret || secret.length < 32) {
  console.error("ICOS_EXECUTION_CALLBACK_SECRET est requis (≥ 32 caractères).");
  process.exit(1);
}

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({ address });
  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue,
      /* Workflows run in their own JS context, so they are loaded by path. */
      workflowsPath: require.resolve("@/server/execution/temporal/workflows"),
      activities: await import("@/server/execution/temporal/activities"),
    });

    console.log(
      `ICOS execution worker on ${address} (namespace=${namespace} queue=${taskQueue} ` +
        `icos=${baseUrl} timeoutMs=${process.env.ICOS_WORKER_EXECUTION_TIMEOUT_MS ?? 900_000})`,
    );
    await worker.run();
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "TEMPORAL_WORKER_FAILED");
  process.exit(1);
});

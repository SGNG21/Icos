/**
 * THE REAL DURABLE PATH, in one process, for integration tests.
 *
 * `DURABLE_MISSION_TASK` is orchestrated by Temporal and by nothing else (ADR 0067). A
 * test that wants to exercise mission work therefore needs the same two things production
 * needs: a worker polling the queue, and an ICOS HTTP endpoint for that worker to report
 * back to. Without them a dispatch used to open a workflow on a queue nobody consumed and
 * sit at `dispatched` for ever — no result, no quality-control job, the reviewer never
 * asked, and a missing review as the only visible symptom.
 *
 * NOTHING HERE IS A SURROGATE. The workflow, the activities and both HTTP handlers are the
 * production modules, imported and run unmodified; this file only starts them and tells
 * them where to find each other. There is no test-only execution authority, no in-process
 * fallback executor and no second orchestrator — a test that cannot reach Temporal fails,
 * exactly as production would.
 *
 * The HTTP surface is deliberately the narrow one the activity actually calls — the two
 * internal execution callbacks — rather than the whole Next application, which the
 * activity never touches. The route handlers take a Web `Request` and return a `Response`,
 * so serving them needs a socket and nothing else.
 */
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { AddressInfo } from "node:net";

import { Client, Connection } from "@temporalio/client";
import { Worker, NativeConnection } from "@temporalio/worker";

import { POST as executionsCompleted } from "@/app/api/internal/executions/completed/route";
import { POST as executionsGrant } from "@/app/api/internal/executions/grant/route";
import { POST as executionsStarted } from "@/app/api/internal/executions/started/route";

/** The production callbacks, at the paths the production activity posts to. */
const ROUTES: Record<string, (request: Request) => Promise<Response>> = {
  "/api/internal/executions/started": executionsStarted,
  "/api/internal/executions/completed": executionsCompleted,
  /* What a writer is allowed to do — the authority seam, served by production code. */
  "/api/internal/executions/grant": executionsGrant,
};

export interface TemporalRuntime {
  /** What `ICOS_BASE_URL` must be for the worker to reach these callbacks. */
  readonly baseUrl: string;
  readonly taskQueue: string;
  stop(): Promise<void>;
}

/**
 * A queue of its own per caller, so two test files never consume each other's workflows
 * and neither one ever reaches the live `icos-tasks` queue.
 */
export function uniqueTaskQueue(label: string): string {
  return `icos-test-${label}-${process.pid}-${Date.now().toString(36)}`;
}

async function serveCallbacks(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      void (async () => {
        const path = (incoming.url ?? "").split("?")[0] ?? "";
        const handler = ROUTES[path];
        if (!handler) {
          outgoing.writeHead(404).end();
          return;
        }
        try {
          /*
           * The handler is production code and takes a standard Request, so the adapter
           * is a straight translation: same method, same headers (the callback secret
           * among them), same body. Nothing is added and no check is skipped.
           */
          const response = await handler(
            new Request(`http://127.0.0.1${path}`, {
              method: incoming.method ?? "POST",
              headers: incoming.headers as Record<string, string>,
              body: Buffer.concat(chunks),
            }),
          );
          const body = Buffer.from(await response.arrayBuffer());
          outgoing.writeHead(response.status, {
            "content-type": response.headers.get("content-type") ?? "application/json",
          });
          outgoing.end(body);
        } catch {
          /* A handler that throws is a 500 here exactly as it would be in production. */
          outgoing.writeHead(500).end();
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Starts the callbacks and a REAL Temporal worker on `taskQueue`, then returns once the
 * worker is actually polling — so a dispatch that follows cannot be refused for want of a
 * consumer.
 *
 * Sets `ICOS_BASE_URL` because the production activity reads it from the environment at
 * call time, which is also how the production worker is configured.
 */
export async function startTemporalRuntime(taskQueue: string): Promise<TemporalRuntime> {
  const { server, baseUrl } = await serveCallbacks();
  process.env.ICOS_BASE_URL = baseUrl;

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    /*
     * The production workflow and the production activities, unmodified.
     *
     * Resolved from this file's own location rather than `require.resolve`, which does
     * not exist under ESM. Workflows are bundled into their own isolate by Temporal, so
     * the path must be real — the alias the production worker uses is not available to
     * that bundler here.
     */
    workflowsPath: fileURLToPath(
      new URL("../server/execution/temporal/workflows.ts", import.meta.url),
    ),
    activities: await import("@/server/execution/temporal/activities"),
  });

  const running = worker.run();
  /*
   * Polling is exactly what the dispatcher's consumer check looks for, so do not return
   * until the worker is actually RUNNING — otherwise the first dispatch races the worker
   * and is refused for want of a consumer.
   */
  const readyBy = Date.now() + 30_000;
  while (worker.getState() !== "RUNNING") {
    if (Date.now() > readyBy) throw new Error("TEST_TEMPORAL_WORKER_NOT_RUNNING");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /*
   * AND NOT MERELY RUNNING: until the SERVER reports the poller, the dispatcher's
   * consumer check still answers "nobody is polling" and refuses the first dispatch.
   *
   * `RUNNING` is the worker's own view of itself and is reached before the first
   * long-poll has been registered, so waiting on it alone leaves a race that shows up as
   * TEMPORAL_NO_CONSUMER in whichever test happens to dispatch first — a failure that
   * looks like the guard misfiring and is really the harness returning too early. The
   * readiness condition is therefore the same question the dispatcher asks.
   */
  const pollerConnection = await Connection.connect({ address, connectTimeout: 15_000 });
  const pollerClient = new Client({ connection: pollerConnection, namespace });
  try {
    while (Date.now() < readyBy) {
      const described = await pollerClient.workflowService
        .describeTaskQueue({ namespace, taskQueue: { name: taskQueue } })
        .catch(() => undefined);
      if ((described?.pollers?.length ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await pollerConnection.close().catch(() => undefined);
  }

  return {
    baseUrl,
    taskQueue,
    async stop() {
      worker.shutdown();
      await running.catch(() => undefined);
      await connection.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Waits until the SERVER reports a poller on `taskQueue`, which is the condition the
 * dispatcher's consumer guard actually tests.
 *
 * Exported for suites that build their own worker rather than using the runtime above:
 * `Worker.getState() === "RUNNING"` is the worker's own view and is reached before its
 * first long-poll is registered, so a dispatch issued on that signal alone can still be
 * refused for want of a consumer.
 */
export async function waitForQueuePoller(
  client: Pick<Client, "workflowService">,
  taskQueue: string,
  options: { namespace?: string; timeoutMs?: number } = {},
): Promise<void> {
  const namespace = options.namespace ?? process.env.TEMPORAL_NAMESPACE ?? "default";
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  for (;;) {
    const described = await client.workflowService
      .describeTaskQueue({ namespace, taskQueue: { name: taskQueue } })
      .catch(() => undefined);
    if ((described?.pollers?.length ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`TEST_TEMPORAL_NO_POLLER: ${taskQueue}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

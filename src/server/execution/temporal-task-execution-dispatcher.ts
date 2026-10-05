import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { WorkflowIdReusePolicy, WorkflowIdConflictPolicy } from "@temporalio/common";

import type {
  TaskExecutionDispatcher,
  TaskExecutionDispatchInput,
  TaskExecutionDispatchResult,
} from "./ports";

/**
 * Adapter Temporal du port `TaskExecutionDispatcher`.
 *
 * INVARIANTS :
 * - workflowId déterministe (`icos-task-<taskId>` pour le premier essai,
 *   fourni explicitement pour une correction) : sert aussi de clé
 *   d'idempotence côté ICOS lors de la boucle de complétion Temporal → ICOS ;
 * - un unique argument structuré corrélé (mission, tâche, workflow, routage et
 *   contexte) est envoyé au workflow
 *   `runIcosTask` (voir `temporal-poc/src/workflows.ts`) ;
 * - le dispatcher NE bloque PAS pour attendre le résultat : la preuve métier
 *   canonique est écrite plus tard par la boucle de callback ;
 * - aucun secret n'est journalisé ; le prompt lui-même relève du contrat métier
 *   ICOS et ne doit contenir aucun secret côté appelant.
 *
 * PRODUCTION BEHAVIOR: Fails closed when Temporal is unavailable.
 * TEST BEHAVIOR: Can inject failing client via constructor for controlled testing.
 */
export class TemporalTaskExecutionDispatcher implements TaskExecutionDispatcher {
  private clientPromise?: Promise<Client>;

  constructor(
    private readonly address = "localhost:7233",
    private readonly taskQueue = "hello-world",
    private readonly workflowType = "runIcosTask",
    private readonly failClosed = true, // PRODUCTION: true (fail closed). TEST: can inject false with mock client
    private readonly mockClient?: Client, // TEST ONLY: inject mock client
    private readonly timeoutMs = 10_000,
    /** Namespace the task queue lives in; only ever read, never created here. */
    private readonly namespace = "default",
    /**
     * How long a proven consumer is believed without asking again. Short: long enough
     * that a burst of dispatches costs one describe, short enough that a worker dying is
     * noticed almost at once. A NEGATIVE answer is never cached, so a worker coming back
     * takes effect immediately.
     */
    private readonly consumerProofTtlMs = 5_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("TEMPORAL_INVALID_DISPATCH_TIMEOUT");
    }
  }

  /** When the last positive consumer proof expires. */
  private consumerProvenUntilMs = 0;

  /**
   * REFUSES TO ENQUEUE WORK NOBODY WILL RUN.
   *
   * Connecting to Temporal proves the SERVER is up; it proves nothing about a worker.
   * Starting a workflow on a queue with no poller succeeds, returns a workflowId, and the
   * attempt is recorded `dispatched` — then nothing ever happens. No error is raised
   * anywhere, so the task is stranded silently and only a human comparing timestamps ever
   * notices. That is a fail-OPEN wearing the costume of a successful dispatch, and it is
   * exactly how an entire integration family came to sit at `dispatched` for ever.
   *
   * `DescribeTaskQueue` is the strongest signal the architecture already has: the server
   * reports the pollers currently attached to the queue. No poller means no consumer, and
   * a dispatch that cannot be consumed is refused before anything is written.
   *
   * Fails closed on an unreadable answer too — being unable to prove a consumer is not
   * evidence of one.
   */
  private async assertConsumerAvailable(client: Client): Promise<void> {
    if (Date.now() < this.consumerProvenUntilMs) return;

    let pollers: number;
    try {
      const described = await client.workflowService.describeTaskQueue({
        namespace: this.namespace,
        taskQueue: { name: this.taskQueue },
      });
      pollers = described.pollers?.length ?? 0;
    } catch {
      throw new Error(
        `TEMPORAL_CONSUMER_UNKNOWN: could not describe task queue ${this.taskQueue}`,
      );
    }

    if (pollers === 0) {
      throw new Error(
        `TEMPORAL_NO_CONSUMER: no worker is polling task queue ${this.taskQueue}`,
      );
    }
    this.consumerProvenUntilMs = Date.now() + this.consumerProofTtlMs;
  }

  private getClient(): Promise<Client> {
    // TEST: if mock client provided, use it
    if (this.mockClient) {
      return Promise.resolve(this.mockClient);
    }

    this.clientPromise ??= Connection.connect({
      address: this.address,
      connectTimeout: this.timeoutMs,
    })
      .then((connection) => new Client({ connection }))
      .catch(() => {
        // A temporary outage must not poison this dispatcher instance forever;
        // later reconciliation retries need a fresh connection attempt.
        this.clientPromise = undefined;
        if (this.failClosed) {
          throw new Error("TEMPORAL_UNAVAILABLE");
        }
        throw new Error("TEMPORAL_CONNECTION_FAILED");
      });
    return this.clientPromise;
  }

  private async startWorkflow(
    client: Client,
    input: TaskExecutionDispatchInput,
    workflowId: string,
  ) {
    const start = () =>
      client.workflow.start(this.workflowType, {
        taskQueue: this.taskQueue,
        workflowId,
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        args: [
          {
            missionId: input.missionId,
            taskId: input.taskId,
            workflowId,
            title: input.taskTitle,
            prompt: input.prompt,
            workerKind: input.workerKind,
            capability: input.capability,
          },
        ],
      });

    const startWithDeadline = () => client.withDeadline(Date.now() + this.timeoutMs, start);

    return input.signal
      ? client.withAbortSignal(input.signal, startWithDeadline)
      : startWithDeadline();
  }

  async dispatch(
    input: TaskExecutionDispatchInput,
    digitalosFacadePath?: string,
  ): Promise<TaskExecutionDispatchResult> {
    void digitalosFacadePath;
    if (input.signal?.aborted) {
      throw new Error("TEMPORAL_DISPATCH_ABORTED");
    }
    const client = await this.getClient();
    /* Before anything durable is written: is there anyone to run this at all? */
    await this.assertConsumerAvailable(client);
    const workflowId = input.workflowId ?? `icos-task-${input.taskId}`;

    try {
      input.signal?.throwIfAborted();
      const handle = await this.startWorkflow(client, input, workflowId);
      return { workflowId: handle.workflowId };
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        // Workflow already exists (either running or closed with REJECT_DUPLICATE policy).
        // Treat as success-equivalent: return the workflowId without starting a new execution.
        return { workflowId };
      }
      if (input.signal?.aborted) {
        throw new Error("TEMPORAL_DISPATCH_ABORTED");
      }
      throw new Error("TEMPORAL_DISPATCH_UNCERTAIN");
    }
  }
}

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
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("TEMPORAL_INVALID_DISPATCH_TIMEOUT");
    }
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

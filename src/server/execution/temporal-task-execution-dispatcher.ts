import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { WorkflowIdReusePolicy, WorkflowIdConflictPolicy } from "@temporalio/common";

import type {
  DurableExecutionReconciler,
  TaskExecutionDispatcher,
  TaskExecutionDispatchInput,
  TaskExecutionDispatchResult,
} from "./ports";
import {
  decideExistingExecution,
  EXECUTION_IDENTITY_MEMO,
  type ExistingExecutionFacts,
} from "./temporal-existing-execution";

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
    /**
     * HOW ICOS ANSWERS "has this execution already settled?".
     *
     * Required to turn a CLOSED canonical execution into a reconciliation rather than a
     * refusal. Absent, a closed workflow can only be refused — which is the honest
     * default: without ICOS's own terminal result there is no evidence the work was ever
     * settled, and reporting a dispatch for a finished-and-unsettled execution is exactly
     * the false success this adapter must not produce.
     */
    private readonly reconciler?: DurableExecutionReconciler,
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
   *
   * NOTE what this check cannot see: it asks about the queue this dispatcher intends to
   * use, which says nothing about the queue an ALREADY EXISTING workflow of the same id
   * happens to sit on. That second question is `temporal-existing-execution.ts`.
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
      throw new Error(`TEMPORAL_CONSUMER_UNKNOWN: could not describe task queue ${this.taskQueue}`);
    }

    if (pollers === 0) {
      throw new Error(`TEMPORAL_NO_CONSUMER: no worker is polling task queue ${this.taskQueue}`);
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
        /*
         * FAIL, never USE_EXISTING.
         *
         * `USE_EXISTING` makes Temporal answer a start request for an already-open id by
         * handing back a handle to whatever is open — on any queue, of any type, started
         * for any task or attempt. The adapter had no way to tell that handle apart from
         * one it had just created, so it reported a successful dispatch for an execution
         * that may have had nothing to do with this task.
         *
         * `FAIL` removes the ambiguity at the source: the ONLY way a handle comes back
         * from `start` is a genuinely new execution. An id that is already taken raises
         * `WorkflowExecutionAlreadyStartedError`, and reuse then has to be EARNED by
         * proving the existing execution is the same canonical one — see
         * `resolveExistingExecution`.
         *
         * `REJECT_DUPLICATE` keeps the same rule for CLOSED executions: a finished
         * attempt is not silently started again under its own id.
         */
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
        /*
         * WHOSE EXECUTION THIS IS, stamped where `describe` can read it.
         *
         * The workflow arguments are not part of a description, so without this a later
         * dispatch looking at the same id can learn only what Temporal knows (queue,
         * type, status) and nothing about which ICOS task or attempt it belongs to. The
         * memo is written once, here, at start: a running execution therefore carries the
         * identity of the attempt it was started for and cannot be made to claim another.
         */
        memo: {
          [EXECUTION_IDENTITY_MEMO.taskId]: input.taskId,
          ...(input.attempt !== undefined
            ? { [EXECUTION_IDENTITY_MEMO.attempt]: input.attempt }
            : {}),
          ...(input.missionId !== undefined
            ? { [EXECUTION_IDENTITY_MEMO.missionId]: input.missionId }
            : {}),
        },
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

  /** Reads back what Temporal knows about an execution already holding this id. */
  private async describeExisting(
    client: Client,
    workflowId: string,
  ): Promise<ExistingExecutionFacts> {
    const described = await client.workflow.getHandle(workflowId).describe();
    return {
      status: described.status?.name,
      taskQueue: described.taskQueue,
      workflowType: described.type,
      memo: described.memo as Readonly<Record<string, unknown>> | undefined,
    };
  }

  /**
   * THE WORKFLOW ID IS ALREADY TAKEN. By what, and may this dispatch stand on it?
   *
   * Reached only when `start` refused the id, so nothing has been enqueued and no
   * execution has been created by this call. Three outcomes, and none of them is a bare
   * success:
   *
   *   reuse        provably the same canonical execution, still open — idempotent;
   *   reconcile    provably the same canonical execution, finished, and ICOS already
   *                holds its durable terminal result: the work must NOT run again, and
   *                saying so is not the same as saying it was dispatched;
   *   refuse       anything else, with the reason naming the collision.
   */
  private async resolveExistingExecution(
    client: Client,
    input: TaskExecutionDispatchInput,
    workflowId: string,
  ): Promise<TaskExecutionDispatchResult> {
    let facts: ExistingExecutionFacts;
    try {
      facts = await this.describeExisting(client, workflowId);
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        /*
         * It existed a moment ago (start said so) and cannot be read now — retention
         * deleted it, or it is a namespace this client cannot see. Either way the
         * collision is unexplained, so it is not a dispatch.
         */
        throw new Error(`TEMPORAL_EXISTING_WORKFLOW_VANISHED: ${workflowId}`);
      }
      throw new Error(`TEMPORAL_EXISTING_WORKFLOW_UNREADABLE: ${workflowId}`);
    }

    const verdict = decideExistingExecution(facts, {
      taskId: input.taskId,
      attempt: input.attempt,
      missionId: input.missionId,
      taskQueue: this.taskQueue,
      workflowType: this.workflowType,
    });

    if (verdict.kind === "refuse") {
      /* Explicit collision reason. Never a successful dispatch. */
      throw new Error(`${verdict.reason}: ${workflowId}`);
    }

    if (verdict.kind === "reuse") {
      /* Idempotent: the canonical execution for this exact attempt is already running. */
      return { workflowId, disposition: "reused" };
    }

    /*
     * CLOSED. The question is now ICOS's, not Temporal's: does the canonical terminal
     * result for exactly this task and attempt exist? If it does, this attempt is
     * settled and re-running it would be a duplicate integration. If it does not, the
     * execution ended without ever settling, and reporting a dispatch would strand the
     * task at `dispatched` for ever — the very failure this adapter exists to refuse.
     */
    const closure = verdict.terminated
      ? "TEMPORAL_TERMINATED_WORKFLOW_WITHOUT_RESULT"
      : "TEMPORAL_CLOSED_WORKFLOW_WITHOUT_RESULT";

    if (!this.reconciler) {
      throw new Error(`${closure}: ${workflowId}`);
    }

    let settled: boolean;
    try {
      settled = await this.reconciler.hasTerminalResult(workflowId);
    } catch {
      /* Unable to ask is not a yes, in either direction. */
      throw new Error(`TEMPORAL_RECONCILIATION_UNKNOWN: ${workflowId}`);
    }

    if (!settled) {
      throw new Error(`${closure}: ${workflowId}`);
    }

    /*
     * Settled. Nothing was dispatched and nothing will run — and that is the correct
     * answer, which is why the caller is told `reconciled` rather than handed a
     * workflowId that looks like a fresh dispatch.
     */
    return { workflowId, disposition: "reconciled" };
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
    /*
     * ATTEMPT IDENTITY COMES FROM CORE3, never from here.
     *
     * The adapter derives no retry of its own: it either uses the id the caller computed
     * (`workflowIdForAttempt`, which is where a retry's new attempt identity is issued)
     * or, for a caller that states no id, the first-attempt id — which is the same value
     * `workflowIdForAttempt(taskId, 1)` produces. Incrementing an attempt here would
     * create a retry ICOS never authorised and has no durable record of.
     */
    const workflowId = input.workflowId ?? `icos-task-${input.taskId}`;

    try {
      input.signal?.throwIfAborted();
      const handle = await this.startWorkflow(client, input, workflowId);
      return { workflowId: handle.workflowId, disposition: "started" };
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        /*
         * The id is taken. With conflict policy FAIL this is the ONLY way an existing
         * execution can be reached, so every reuse decision passes through the proof
         * step — there is no path left on which a handle is trusted merely because
         * Temporal returned one.
         */
        return await this.resolveExistingExecution(client, input, workflowId);
      }
      if (input.signal?.aborted) {
        throw new Error("TEMPORAL_DISPATCH_ABORTED");
      }
      /*
       * Anything else really is uncertain: the start may or may not have landed, and
       * recovery's job is to go and look. Note that the refusals raised by the proof step
       * above are NOT routed here — they are thrown from inside this catch block, so they
       * propagate with their own certain reason rather than being flattened into
       * "go and check", which would send recovery hunting for an execution this dispatch
       * deliberately declined to stand on.
       */
      throw new Error("TEMPORAL_DISPATCH_UNCERTAIN");
    }
  }
}

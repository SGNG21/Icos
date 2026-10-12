import { getContainer } from "@/server/container";
import { ExecutionScopeMismatchError, type ExecutionScope } from "@/core/execution/execution-scope";
import { verifyExecutionCallback } from "@/server/execution/callback-auth";
import { ExecutionScopeReader } from "@/server/execution/execution-scope-reader";
import { zodDetails } from "@/server/http/errors";
import { executionGrantBodySchema } from "@/server/http/execution-schemas";
import { toErrorResponse } from "@/server/http/map-error";
import { apiError, json, readJson } from "@/server/http/respond";
import { decideWorkspaceAllocation } from "@/server/supervisor/workspace-allocation-policy";
import { identityOf } from "@/server/workers/execution/worker-executor";

/**
 * WHAT MAY THIS EXECUTION DO? Answered by ICOS, from durable state, never by the worker.
 *
 * The governed writer used to exist only on the in-process dispatcher: it ran in a
 * worktree the WorkspaceManager had allocated, on a branch the IntegrationGate later
 * consumed. The Temporal activity had none of that — it bound the repository read-only
 * and handed the worker a scratch directory — so routing all mission work to Temporal did
 * not relocate code-writing work, it removed it (ADR 0067, amendment A).
 *
 * This is how the capability comes back WITHOUT the worker being trusted to assert it.
 * The request carries identifiers only. Everything that confers authority — the worktree,
 * the branch, the file scope, whether writing is allowed at all — is looked up here from
 * the dispatch ledger, the workspace registry and the canonical Task, and returned. A
 * forged payload field changes nothing because no such field is read; a worker that
 * decides it ought to be a writer is simply wrong, and the sandbox it is given does not
 * care what it decided.
 *
 * SECURITY: same `x-icos-callback-secret` as the other internal execution callbacks,
 * compared in constant time. No session, no cookie. The grant names paths inside the
 * workspace root and never a credential.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();

    const auth = verifyExecutionCallback(request, container.executionCallbackSecret);
    if (!auth.ok) {
      if (auth.reason === "unconfigured") {
        return apiError("persistence_unavailable", "callback d'exécution non configuré");
      }
      return apiError("unauthenticated", "callback non autorisé");
    }

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }

    const parsed = executionGrantBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "paramètres invalides", zodDetails(parsed.error));
    }

    /*
     * The ledger decides which task this workflow is, and the pair must agree — the same
     * correlation the `started` callback performs, for the same reason: a workflow id is
     * guessable and must never select a task on its own.
     */
    const attempt = await container.dispatchAttempts.getByWorkflowId(parsed.data.workflowId);
    if (!attempt || attempt.taskId !== parsed.data.taskId) {
      /*
       * WHICH correlation failed. Two different invariants shared one message, and a
       * refused callback is invisible from outside: the dispatch succeeded, the worker
       * reported, ICOS refused, Temporal retried twenty times, and the attempt sat
       * `dispatched` for ever. The message is unchanged — it is the stable contract — and
       * the discriminator rides in `details`, a fixed code, never a field value.
       */
      return apiError("invalid_input", "workflow d'exécution non corrélé", {
        reason: !attempt ? "EXECUTION_ATTEMPT_UNKNOWN" : "EXECUTION_ATTEMPT_TASK_MISMATCH",
      });
    }

    const task = await container.tasks.getById(attempt.taskId);
    if (!task) {
      return apiError("not_found", "tâche canonique introuvable");
    }

    /*
     * WRITE AUTHORITY, from the canonical Task alone: its declared risk class and file
     * scope. Not the command, not the model, not the prompt, not anything the caller
     * sent. `read_only` mutates nothing; a writer with no declared scope is REFUSED
     * rather than given a permissive one.
     */
    const allocation = decideWorkspaceAllocation({
      taskId: task.id,
      title: task.title,
      riskClass: task.riskClass,
      allowedFileScope: task.allowedFileScope,
    });
    if (allocation.kind === "REFUSED") {
      return apiError("invalid_input", allocation.reason);
    }
    const writeAllowed = allocation.kind === "GOVERNED";

    /*
     * The worktree is the one the supervisor allocated BEFORE dispatch, keyed on this
     * workflow. A writer with no live workspace is a bug upstream, and running it
     * anywhere else is precisely the orphan-branch defect governance exists to prevent.
     */
    /*
     * No workspace manager composed means governance is not available in this
     * deployment at all — so a writer cannot be granted anything. Refusing is the only
     * safe answer; the alternative is an ungoverned write.
     */
    if (writeAllowed && !container.workspaceManager) {
      return apiError(
        "persistence_unavailable",
        "WORKSPACE_MANAGER_ABSENT: écriture non gouvernable",
      );
    }
    const workspace = (await container.workspaceManager?.list())?.find(
      (candidate) =>
        candidate.workflowId === parsed.data.workflowId && candidate.releasedAt === null,
    );
    if (writeAllowed && !workspace) {
      return apiError("invalid_input", "WORKSPACE_NOT_ALLOCATED: aucun worktree gouverné actif");
    }

    const mission = await container.mission.findById(attempt.missionId);

    /*
     * WHOSE WORK THIS IS (decision 0063 amendment A), read from the task's goal — the one
     * source — and refused when the task's lineage disagrees with it: a task whose goal
     * declares a client is never presented to a worker under another client, or under none.
     */
    let scope: ExecutionScope | null;
    try {
      scope = await new ExecutionScopeReader({
        goals: container.goalRepository,
        missions: container.mission,
        tasks: container.tasks,
      }).forTask(attempt.missionId, attempt.taskId);
    } catch (error) {
      if (error instanceof ExecutionScopeMismatchError) {
        return apiError("invalid_input", "périmètre d'exécution incohérent", {
          reason: "EXECUTION_SCOPE_MISMATCH",
          field: error.field,
        });
      }
      throw error;
    }

    /*
     * THE ROUTED MODEL (decision 0054), from the registration of the worker this attempt was
     * routed to — the one source. The activity substitutes it for `{{model}}`; without it a
     * launch command that names the model is refused rather than run on the CLI's default.
     */
    /*
     * THE DURABLE STORE, not the in-process view. The view is seeded when ITS container is
     * built; a route handler's container can be older than the fleet bootstrap that registered
     * the routed worker, and then answers "no such worker" — measured 2026-10-12 (FABLE lab,
     * three runs): the router chose codex/gpt-5.6-sol from the durable rows, the grant found
     * nothing in its view, and every launch failed WORKER_EXEC_UNROUTABLE. The rows the router
     * decided from are the rows the grant identifies from.
     */
    const routedWorker = attempt.workerId
      ? ((await container.workerRegistryStore.get(attempt.workerId)) ??
        container.workerRegistry.getWorker(attempt.workerId))
      : undefined;
    const routedIdentity = routedWorker ? identityOf(routedWorker) : undefined;

    return json({
      grant: {
        model: routedIdentity?.model ?? null,
        provider: routedIdentity?.provider ?? null,
        taskId: attempt.taskId,
        missionId: attempt.missionId,
        missionTaskId: attempt.missionTaskId,
        workflowId: attempt.workflowId,
        attempt: attempt.attempt,
        /* Attribution: the goal whose budget this execution spends under. */
        goalId: mission?.goalId ?? null,
        workerId: attempt.workerId ?? null,
        /*
         * THE SECRETS THIS TASK MAY RECEIVE, named by the executor ICOS actually routed.
         *
         * Credentials used to be chosen purely from the command the DEPLOYMENT declared,
         * so changing that declaration changed which secrets a task was handed, with no
         * reference to what ICOS had authorised it to use. Naming the scope here means a
         * declaration that disagrees with the routing decision is a refusal rather than
         * a wider grant.
         */
        credentialScope: attempt.workerKind ? [attempt.workerKind] : [],
        writeAllowed,
        /* Exported to the worker as ICOS_CLIENT_ID / ICOS_PROJECT_ID; ids only, no knowledge. */
        scope: scope ?? null,
        /* Absent for a reader: nothing to write means nothing to write INTO. */
        workspace: workspace
          ? {
              worktreePath: workspace.worktreePath,
              branch: workspace.branch,
              baseCommit: workspace.baseCommit,
              /* The fence the worker's result is judged against if it reports late. */
              fencingToken: workspace.fencingToken,
              /*
               * THE DEADLINE A WRITER MAY COAST TO when ICOS is briefly unreachable. It
               * is the workspace lease already held in the registry — not a second clock
               * — so a grace period can never outlast the authority it is covering for.
               */
              leaseExpiresAt: workspace.leaseExpiresAt,
              fileScope: workspace.fileScope,
            }
          : null,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

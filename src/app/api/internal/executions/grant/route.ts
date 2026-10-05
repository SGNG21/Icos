import { getContainer } from "@/server/container";
import { verifyExecutionCallback } from "@/server/execution/callback-auth";
import { zodDetails } from "@/server/http/errors";
import { executionGrantBodySchema } from "@/server/http/execution-schemas";
import { toErrorResponse } from "@/server/http/map-error";
import { apiError, json, readJson } from "@/server/http/respond";
import { decideWorkspaceAllocation } from "@/server/supervisor/workspace-allocation-policy";

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
      return apiError("invalid_input", "workflow d'exécution non corrélé");
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
      return apiError("persistence_unavailable", "WORKSPACE_MANAGER_ABSENT: écriture non gouvernable");
    }
    const workspace = (await container.workspaceManager?.list())?.find(
      (candidate) => candidate.workflowId === parsed.data.workflowId && candidate.releasedAt === null,
    );
    if (writeAllowed && !workspace) {
      return apiError("invalid_input", "WORKSPACE_NOT_ALLOCATED: aucun worktree gouverné actif");
    }

    const mission = await container.mission.findById(attempt.missionId);

    return json({
      grant: {
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
        /* Absent for a reader: nothing to write means nothing to write INTO. */
        workspace: workspace
          ? {
              worktreePath: workspace.worktreePath,
              branch: workspace.branch,
              baseCommit: workspace.baseCommit,
              /* The fence the worker's result is judged against if it reports late. */
              fencingToken: workspace.fencingToken,
              fileScope: workspace.fileScope,
            }
          : null,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

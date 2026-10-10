import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { missionTasks, missions, tasks } from "@/server/database/schema";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresTaskExecutionResultRepository } from "@/server/repositories/postgres/task-execution-result-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { PostgresQualityControlRepository } from "@/server/repositories/postgres/quality-control-repository";
import { PostgresReviewDecisionRepository } from "@/server/repositories/postgres/review-decision-repository";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { DeterministicReviewer } from "@/server/review/deterministic-reviewer";
import { ReviewerServiceImpl } from "@/server/review/reviewer-service";
import type { ReviewerPort } from "@/server/review/ports";
import { QualityControlService } from "@/server/usecases/quality-control-service";
import { ExternalWorkerTaskExecutionDispatcher } from "@/server/execution/external-worker-task-execution-dispatcher";
import { finalizeSuccessfulWorkerExecution } from "@/server/usecases/finalize-successful-worker-execution";
import { WorkspaceManager } from "@/server/workspace-manager/manager";
import { PostgresWorkspaceRegistry } from "@/server/workspace-manager/postgres-workspace-registry";
import { PostgresGit } from "@/server/workspace-manager/postgres-git";
import { PostgresTestDatabaseProvisioner } from "@/server/workspace-manager/test-database";
import { Git } from "@/server/workspace-manager/git";
import { commitWorkerChanges } from "@/server/workspace-manager/git-authority";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { identities, type TestIdentity } from "@/test/test-identity";
import { CommandWorkerExecutor } from "@/server/workers/execution/command-worker-executor";
import {
  createWorkerExecResolver,
  parseWorkerExecCommands,
} from "@/server/workers/execution/exec-command-config";
import { WorkerExecutor } from "@/server/workers/execution/worker-executor";
import { runNonInteractive } from "@/server/workers/process/run-process";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";

/*
 * CORE3 CHAOS CERTIFICATION.
 *
 * Every mechanism below is already proven in isolation (M4 routing, M5 orchestration and
 * capacity, M6.1/M6.2 real probing, M6.3 external execution, M7 abandoned-execution
 * recovery, M7.1 routed QC retries). This is the COMPOSITION, and compositions are where
 * the surprises live: M6.3's classifier defect passed every unit test and only appeared
 * when a real worker produced two signals at once.
 *
 * WHAT IS REAL HERE: real PostgreSQL, real OS processes, real git worktrees and commits,
 * the real `DeterministicReviewer` hard rules, the real routing/capacity/QC/recovery
 * services, and restarts that are new connections with new service instances.
 *
 * WHAT IS STUBBED, and why: the LLM half of the reviewer (a network model — the rule
 * that matters, UNKNOWN_EFFECT -> RETRY, is the REAL deterministic one) and the probe
 * sweep's observation that the hung worker is unhealthy (certified separately in M6.2;
 * running it here would add noise, not proof).
 *
 * THE FAULT IS REAL: a worker process hangs and is KILLED by its own execution timeout.
 */

const DATABASE_URL = TEST_DATABASE_URL;
/**
 * IDENTITY PER CASE, not per file.
 *
 * These were fixed constants, which was harmless while mission work ran on the in-process
 * executor — each case built its own executor, so two cases sharing a task id could not
 * see each other. `DURABLE_MISSION_TASK` is orchestrated by Temporal now, and a Temporal
 * workflow id is GLOBAL to the namespace and OUTLIVES the execution that used it. One
 * `icos-task-<taskId>` was therefore shared by every case in this file, by every rerun of
 * it, and by every process running it at once: the first case of a fresh run passed, and
 * from then on each one collided with the closed workflow its predecessor left behind.
 *
 * Nothing here cleans Temporal, deliberately: correctness must not depend on a cleanup
 * step a crashed run never reaches. A fresh namespace per run makes leftover state
 * irrelevant rather than merely unlikely.
 *
 * Registered FIRST, so the hooks below that seed from these ids see this case's values.
 * Within a case every id is deterministic, so the business assertions stay exactly as
 * exact as they were; a RETRIED case gets a new namespace instead of colliding with its
 * own first run.
 */
const FILE_IDENTITIES = identities("chaos");
let caseNumber = 0;
let ids: TestIdentity;

let MISSION_ID: string;
let MISSION_TASK_ID: string;
let TASK_ID: string;

beforeEach(() => {
  caseNumber += 1;
  ids = FILE_IDENTITIES.forCase(`c${caseNumber}`);
  MISSION_ID = ids.mission();
  MISSION_TASK_ID = ids.missionTask("1");
  TASK_ID = ids.task("1");
});
/**
 * THE RUNNER'S OWN OWNERSHIP TOKEN.
 *
 * The execution lease fences one logical attempt to ONE runner: `acquireExecutionLease`
 * answers true only for the holder, which is what stops two runners producing two results
 * for one attempt. These cases granted the lease to a literal `"test-owner"` for sixty
 * seconds and then invoked the external dispatcher, whose own token is different — so the
 * dispatcher correctly declined to take the lease, returned without executing, and the
 * attempt stayed `dispatched`. The fault being certified never happened; both cases were
 * asserting against a worker that had never run.
 *
 * In production the ordering makes the question moot: the supervisor dispatches FIRST and
 * marks the attempt dispatched afterwards, so nothing holds the lease when the runner
 * reaches for it. These cases need the attempt already `dispatched` before the fault, so
 * they name the runner that will execute it instead — one process marking its own attempt
 * and then running it.
 *
 * The fencing property is untouched: a FOREIGN owner still cannot take a live lease, which
 * is proven where it belongs, against the ledger itself.
 */
const RUNNER_OWNER = "chaos-runner";

const WORKER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAPABILITY = "code-generation";

const handles: DatabaseHandle[] = [];
let root: string;
let repo: string;
/** The governed worktree root: outside the canonical repository, which stays untouchable. */
let trees: string;

const git = async (cwd: string, args: string[]) => {
  const result = await runNonInteractive({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/**
 * THE WORKER. One command for the `node` runtime, as a deployment would configure it.
 *
 * Attempt 1 HANGS — the fault. Its own execution timeout kills it, which is a real
 * process death, not a simulated one. Any later attempt does the work for real: writes a
 * file, commits it, and reports a structured verdict.
 */
const CHAOS_WORKER = `
  if (process.env.ICOS_ATTEMPT === '1') {
    setTimeout(() => {}, 60000);
  } else {
    const fs = require('fs');
    /* INSIDE the declared scope: anything else is refused at capture, before any commit. */
    fs.mkdirSync('src/chaos', { recursive: true });
    fs.writeFileSync('src/chaos/proof.txt', 'done by attempt ' + process.env.ICOS_ATTEMPT + '\\n');
    /* NO git: the worker holds no Git authority; ICOS materializes the commit (ADR 0073). */
    process.stdout.write(process.env.ICOS_RESULT_SENTINEL_START + JSON.stringify({
      status: 'succeeded',
      summary: 'wrote proof.txt on attempt ' + process.env.ICOS_ATTEMPT,
      testsRun: ['proof-check'],
    }) + process.env.ICOS_RESULT_SENTINEL_END);
  }
`;

/** The scope this writer declares, and the only paths its capture may contain. */
const SCOPE = "src/chaos/**";

/** The integration target every governed workspace branches from. */
const TARGET = "integration/phase-7";

/**
 * A GOVERNED WORKSPACE, ALLOCATED BEFORE THE WRITER RUNS.
 *
 * In production the execution coordinator does this; here the harness does it explicitly, at
 * the same moment and with the same inputs, so that every dispatch below is a governed one.
 * The lease matters: the trusted finalizer refuses to capture a workspace whose lease is not
 * live, which is what stops a takeover being committed under our identity.
 */
async function grantGovernedWorkspace(
  w: { workspaces: WorkspaceManager; workspaceRegistry: PostgresWorkspaceRegistry },
  workflowId: string,
  workerId: string,
): Promise<void> {
  await w.workspaceRegistry.initialize();
  const existing = (await w.workspaces.list()).find(
    (ws) => ws.workflowId === workflowId && ws.releasedAt === null,
  );
  const ws =
    existing ??
    (await w.workspaces.request({
      slug: `chaos-${slugSeq++}`,
      workerId,
      missionId: MISSION_ID,
      taskId: TASK_ID,
      workflowId,
      fileScope: { owns: [SCOPE], shared: [], forbidden: [] },
      integrationTarget: TARGET,
    }));
  /* The lease FIRST: `create` and `transition` are fenced mutations and refuse without it. */
  let current = await holdLease(w.workspaces, ws.workspaceId);
  if (current.status === "requested") {
    /* requested -> creating -> ready: the dedicated database, then `git worktree add`. */
    current = await w.workspaces.create(ws.workspaceId, RUNNER_OWNER, current.fencingToken);
  }
  if (current.status === "ready") {
    await w.workspaces.transition(ws.workspaceId, "working", RUNNER_OWNER, current.fencingToken);
  }
}

let slugSeq = 1;

/** Ours and still valid -> renew; otherwise acquire. The coordinator's rule, not a new one. */
async function holdLease(workspaces: WorkspaceManager, workspaceId: string) {
  const ws = await workspaces.get(workspaceId);
  const oursAndValid =
    ws.leaseOwner === RUNNER_OWNER &&
    ws.leaseExpiresAt !== null &&
    Date.parse(ws.leaseExpiresAt) > Date.now();
  return oursAndValid
    ? workspaces.renewLease(workspaceId, RUNNER_OWNER, ws.fencingToken, 10 * 60_000)
    : workspaces.acquireLease(workspaceId, RUNNER_OWNER, 10 * 60_000);
}

/**
 * THE REAPER'S JOB ON AN ABANDONED ATTEMPT (M7): free the task's slot, keep the work.
 *
 * `cleanup` refuses a workspace with uncommitted changes and deletes the branch only when it
 * is already merged into the integration target, so an abandoned attempt keeps its branch as
 * evidence while the task becomes allocatable again.
 */
async function reapAbandonedWorkspace(
  w: { workspaces: WorkspaceManager },
  workflowId: string,
): Promise<void> {
  const ws = (await w.workspaces.list()).find(
    (candidate) => candidate.workflowId === workflowId && candidate.releasedAt === null,
  );
  if (!ws) return;
  const leased = await holdLease(w.workspaces, ws.workspaceId);
  await w.workspaces.transition(ws.workspaceId, "abandoned", RUNNER_OWNER, leased.fencingToken);
  await w.workspaces.cleanup(ws.workspaceId, RUNNER_OWNER, leased.fencingToken);
}

/** A restart: new connection, new services, zero shared memory. */
function restart() {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const taskRepo = new PostgresTaskRepository(handle.db);
  const missionRepo = new PostgresMissionRepository(handle.db, taskRepo);
  const ledger = new PostgresDispatchAttemptRepository(handle.db);
  const store = new PostgresWorkerRegistryStore(handle.db);
  const executionResults = new PostgresTaskExecutionResultRepository(handle.db);
  const durableMemory = new PostgresDurableMemory(handle.db);
  const reviewDecisions = new PostgresReviewDecisionRepository(handle.db);
  const qualityJobs = new PostgresQualityControlRepository(handle.db);

  const router = new CapabilityRouter(store, {
    activeAssignments: () => ledger.listActiveWorkerAssignments(),
    /* Composed as the container composes it (decision 0054). */
    computeHistory: (since) => ledger.listRecentComputeOutcomes(since),
    executionLeaseMs: 20 * 60_000,
    defaultBudgetMs: () => 1_500,
  });

  const supervisor = new SupervisorService(
    missionRepo,
    taskRepo,
    { dispatch: vi.fn(async () => ({ workflowId: "x" })) } as unknown as TaskExecutionDispatcher,
    durableMemory,
    ledger,
    undefined,
    router,
  );

  /* The REAL external worker execution boundary (0038), on the real `node` runtime. */
  const executor = new WorkerExecutor({
    node: new CommandWorkerExecutor(
      createWorkerExecResolver(
        parseWorkerExecCommands(
          JSON.stringify({
            node: {
              command: process.execPath,
              args: ["-e", CHAOS_WORKER],
              /* Short on purpose: the hang must be killed, and quickly. */
              timeoutMs: 1_500,
            },
          }),
        ),
      ),
    ),
  });

  /*
   * THE GOVERNED WORKSPACE AUTHORITY, composed as `container.ts` composes it: the durable
   * registry, a Git port bound to the DECLARED canonical repository, and the manager that
   * owns branch naming and leases.
   */
  const workspaceRegistry = new PostgresWorkspaceRegistry(DATABASE_URL);
  const workspaces = new WorkspaceManager({
    git: new PostgresGit(DATABASE_URL, repo),
    registry: workspaceRegistry,
    provisioner: new PostgresTestDatabaseProvisioner(DATABASE_URL),
    masterRepo: repo,
    worktreeRoot: trees,
  });

  const dispatcher = new ExternalWorkerTaskExecutionDispatcher({
    /* Named, so the attempt this runner marks dispatched is one it can still lease. */
    owner: RUNNER_OWNER,
    executor,
    workers: store,
    dispatchAttempts: ledger,
    executionResults,
    missions: missionRepo,
    tasks: taskRepo,
    supervisor,
    durableMemory,
    repoPath: repo,
    workspaceRoot: root,
    /*
     * THE WORKTREE COMES FROM THE REGISTRY ROW, and so does the repository it belongs to.
     * `canonical_repo` was bound by the allocator before any worker existed; a row without it
     * throws rather than falling back to the ambient deployment, because a wrong repository is
     * worse than a stopped capture.
     */
    workspaceFor: async (dispatch) => {
      if (!dispatch.workflowId) return null;
      const registered = (await workspaces.list()).find(
        (ws) => ws.workflowId === dispatch.workflowId && ws.releasedAt === null,
      );
      if (!registered) return null;
      if (!registered.canonicalRepo) throw new Error("CANONICAL_REPO_UNBOUND");
      return {
        path: registered.worktreePath,
        mode: "writer",
        branch: registered.branch,
        baseCommit: registered.baseCommit,
        repoPath: registered.canonicalRepo,
        /* The WorkspaceManager owns this worktree's lifecycle, not the executor. */
        dispose: async () => {},
      };
    },
    /* THE ONE MATERIALIZATION (ADR 0073), the same function both production paths call. */
    finalizeGovernedWork: (work) =>
      finalizeSuccessfulWorkerExecution(
        {
          workspaces,
          gitFor: (repoDir) => new Git(repoDir),
          materialize: commitWorkerChanges,
          tasks: taskRepo,
        },
        work,
      ),
  });

  /* Real deterministic hard rules; only the LLM half is stubbed. */
  const llm: ReviewerPort = {
    review: async () => ({ decision: "APPROVE", reasons: ["work verified by evidence"] }),
  };
  const reviewer = new ReviewerServiceImpl(llm, new DeterministicReviewer(), reviewDecisions);

  const qualityControl = new QualityControlService({
    missions: missionRepo,
    tasks: taskRepo,
    executionResults,
    reviewer,
    reviewDecisions,
    dispatchAttempts: ledger,
    qualityJobs,
    /* M7.1 — QC routes its retries through the one canonical router. */
    capabilityRouter: router,
    dispatchPrepared: async (prepared) => {
      /* A WRITER NEVER RUNS UNGOVERNED, retries included. */
      if (!prepared.workerId) {
        /* Fail closed: a retry with no routed worker cannot be governed, so it must not run. */
        throw new Error("RETRY_WITHOUT_ROUTED_WORKER");
      }
      await grantGovernedWorkspace(
        { workspaces, workspaceRegistry },
        prepared.workflowId,
        prepared.workerId,
      );
      const result = await dispatcher.dispatch({
        /* Mission work: a DAG task with review and settlement. */
        executionClass: "DURABLE_MISSION_TASK",
        missionId: prepared.missionId,
        taskId: prepared.taskId,
        prompt: prepared.prompt,
        workflowId: prepared.workflowId,
        workerKind: prepared.workerKind,
        capability: prepared.capability,
      });
      if (result.workflowId !== prepared.workflowId) {
        throw new Error("DISPATCH_ACKNOWLEDGEMENT_ID_MISMATCH");
      }
      await ledger.markDispatched(prepared.id, { owner: RUNNER_OWNER, leaseMs: 60_000 });
    },
  });

  return {
    handle,
    taskRepo,
    missionRepo,
    ledger,
    store,
    executionResults,
    dispatcher,
    qualityControl,
    router,
    registration: new WorkerRegistrationService(store),
    workspaces,
    workspaceRegistry,
  };
}

const seed = restart();

async function seedWorld() {
  const now = new Date();
  await seed.handle.db.insert(missions).values({
    id: MISSION_ID,
    title: "CORE3 chaos",
    objective: "Survive a worker dying mid-execution",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(tasks).values({
    id: TASK_ID,
    title: "Write proof.txt",
    description: "Write src/chaos/proof.txt",
    status: "running",
    assignedAgentId: null,
    requiredCapabilities: [CAPABILITY],
    /*
     * THE CANONICAL DECLARATION, and the only thing allocation is allowed to read. Without it
     * `requiresGovernedWorkspace` is false, this writer would run ungoverned, and ADR 0073
     * would correctly refuse to capture anything it produced.
     */
    riskClass: "reversible",
    allowedFileScope: [SCOPE],
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(missionTasks).values({
    id: MISSION_TASK_ID,
    missionId: MISSION_ID,
    title: "Write proof.txt",
    description: "Write proof.txt and commit it",
    dependsOn: [],
    status: "running",
    workerKind: null,
    capability: CAPABILITY,
    taskId: TASK_ID,
    createdAt: now,
    updatedAt: now,
  });

  for (const id of [WORKER_A, WORKER_B]) {
    await seed.registration.register({
      id,
      workerKind: "agent",
      displayName: id,
      capabilities: [CAPABILITY],
      runtime: "node",
      runtimeSupport: "SUPPORTED_RUNTIME",
      maxConcurrency: 1,
    });
    /* Dated health evidence: routing refuses a worker it has never seen work (0033). */
    await seed.registration.probe(id, { health: "healthy", availability: "available" });
  }
}

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  if (root) await rm(root, { recursive: true, force: true });
});

describe("CORE3 CHAOS CERTIFICATION", () => {
  beforeEach(async () => {
    await seed.handle.db.execute(
      sql.raw(
        /* `icos_workspace_registry` included: it is durable, and a leftover lease or scope claim blocks the next case. */
        "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items, recovery_units, quality_control_jobs, icos_workspace_registry RESTART IDENTITY CASCADE",
      ),
    );

    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "icos-chaos-"));
    repo = join(root, "canonical");
    /* Governed worktrees live OUTSIDE the canonical repository, which stays untouchable. */
    trees = join(root, "trees");
    await mkdir(trees, { recursive: true });
    await git(root, ["init", "--initial-branch=main", "canonical"]);
    await git(repo, ["config", "user.email", "test@icos.local"]);
    await git(repo, ["config", "user.name", "ICOS Test"]);
    await writeFile(join(repo, "README.md"), "canonical\n", "utf8");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    /* The integration target a governed workspace branches from. Nothing here advances it. */
    await git(repo, ["branch", TARGET]);

    await seedWorld();
  });

  it("A WORKER DIES MID-EXECUTION AND THE MISSION TASK STILL COMPLETES, EXACTLY ONCE", async () => {
    const canonicalHead = await git(repo, ["rev-parse", "HEAD"]);

    /* ---- 1. ROUTE and dispatch attempt 1, through the real router. ---- */
    const boot = restart();
    const routed = await boot.router.route({ requiredCapabilities: [CAPABILITY] });
    expect(routed.decision).toBe("ROUTED");
    const firstWorker = routed.worker!.id;

    const attempt1 = await boot.ledger.prepare({
      missionId: MISSION_ID,
      missionTaskId: MISSION_TASK_ID,
      taskId: TASK_ID,
      attempt: 1,
      workflowId: workflowIdForAttempt(TASK_ID, 1),
      prompt: "Write proof.txt and commit it",
      workerKind: "agent",
      workerId: firstWorker,
      capability: CAPABILITY,
    });
    await boot.ledger.markDispatched(attempt1.attempt.id, { owner: RUNNER_OWNER, leaseMs: 60_000 });

    /* A WRITER NEVER RUNS UNGOVERNED: its workspace, branch and scope exist first. */
    await grantGovernedWorkspace(boot, workflowIdForAttempt(TASK_ID, 1), firstWorker);

    /* ---- 2. THE FAULT: the worker hangs and is really killed. ---- */
    await boot.dispatcher.dispatch({
      /* Mission work: a DAG task with review and settlement. */
      executionClass: "DURABLE_MISSION_TASK",
      missionId: MISSION_ID,
      taskId: TASK_ID,
      prompt: "Write proof.txt and commit it",
      workflowId: workflowIdForAttempt(TASK_ID, 1),
      capability: CAPABILITY,
    });

    const afterFault = restart();
    const failed = await afterFault.ledger.getByWorkflowId(workflowIdForAttempt(TASK_ID, 1));
    expect(failed?.state).toBe("failed");
    /* Killed for its budget (decision 0054); the effect is still UNKNOWN — never "the task failed". */
    expect(failed?.failureClass).toBe("EXECUTION_TIMEOUT");
    expect(
      (await afterFault.executionResults.getByWorkflowId(workflowIdForAttempt(TASK_ID, 1)))?.error
        ?.code,
    ).toBe("UNKNOWN_EFFECT");
    /* The slot came back the moment the attempt was settled. */
    expect(await afterFault.ledger.listActiveWorkerAssignments()).toEqual([]);

    /*
     * ---- 3. The probe sweep observes that the hung worker is not healthy. ----
     * Stands in for M6.2's certified autonomous sweep; running it here would add noise,
     * not proof. Without it the router would legitimately choose the same worker again.
     */
    await afterFault.registration.probe(firstWorker, {
      health: "unhealthy",
      availability: "unavailable",
    });

    /*
     * The killed attempt's workspace is reaped, as the abandoned-execution reaper does: the
     * task becomes allocatable again and the dead branch is kept. Without this the retry
     * cannot be governed at all — one live workspace per task is the registry's invariant.
     */
    await reapAbandonedWorkspace(afterFault, workflowIdForAttempt(TASK_ID, 1));

    /* ---- 4. RECOVERY drives the retry — the production path, not the test. ---- */
    /*
     * SUCCESSIVE SWEEP TICKS, because the recovery sweeper is PERIODIC in production.
     * One tick cannot both create the retry and review its result: `recoverUnregistered`
     * runs at the start of a pass, so attempt 2's result does not exist yet when the
     * pass that CREATES attempt 2 begins. The second tick reviews it. Modelling that
     * honestly is the point — a single all-in-one call would prove a system that does
     * not exist.
     *
     * Nothing here decides anything: the test only advances the clock.
     */
    for (let tick = 0; tick < 3; tick += 1) {
      await restart().qualityControl.recover(MISSION_ID);
      if ((await restart().taskRepo.getById(TASK_ID))?.status === "succeeded") break;
    }

    /* ---- 5. THE ASSERTIONS, all on durable rows read from a NEW connection. ---- */
    const verify = restart();

    const attempts = await verify.handle.db.execute(
      sql.raw(
        `select attempt, state, worker_id, failure_class from dispatch_attempts where mission_task_id = '${MISSION_TASK_ID}' order by attempt`,
      ),
    );
    const rows = attempts as unknown as Array<{
      attempt: number;
      state: string;
      worker_id: string;
      failure_class: string | null;
    }>;

    /* EXACTLY TWO attempts: the fault and its retry. No third, no fork. */
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      attempt: 1,
      state: "failed",
      failure_class: "EXECUTION_TIMEOUT",
    });

    /* REASSIGNED: the retry went to the OTHER worker, chosen by the real router. */
    const otherWorker = firstWorker === WORKER_A ? WORKER_B : WORKER_A;
    expect(rows[1]!.attempt).toBe(2);
    expect(rows[1]!.worker_id).toBe(otherWorker);

    /*
     * DECISION 0054 — WHY the retry went elsewhere is durable, on the retry's own row, read
     * from a NEW connection: the ledger's EXECUTION_TIMEOUT on attempt 1 penalised the model
     * that timed out. Both executions carry their observed duration. Attempt 1's row is the
     * fault exactly as it happened — the retry added a row and changed none.
     */
    const evidence = (await verify.handle.db.execute(
      sql.raw(
        `select attempt, routing_decision, execution_duration_ms from dispatch_attempts where mission_task_id = '${MISSION_TASK_ID}' order by attempt`,
      ),
    )) as unknown as Array<{
      attempt: number;
      routing_decision: Record<string, any> | null;
      execution_duration_ms: number | null;
    }>;
    const retryDecision = evidence[1]!.routing_decision!;
    expect(retryDecision).toMatchObject({
      kind: "ROUTING_DECISION",
      role: "writer",
      previousFailure: { attempt: 1, failureClass: "EXECUTION_TIMEOUT" },
      selected: { workerId: otherWorker },
    });
    const timedOut = (retryDecision.candidateSet as Array<Record<string, any>>).find(
      (c) => c.workerId === firstWorker,
    )!;
    /* The dead worker lost its health evidence, and its timeout is in the history it carries. */
    expect(timedOut.selectable).toBe(false);
    expect(timedOut.excludedBecause).toContain("HEALTH_NOT_HEALTHY");
    expect(timedOut.history).toMatchObject({
      executions: 1,
      timeouts: 1,
      infraFailures: 1,
      reviewed: 0,
    });
    expect(evidence[0]!.execution_duration_ms).toBeGreaterThanOrEqual(1_400);
    expect(evidence[1]!.execution_duration_ms).not.toBeNull();

    /* EXACTLY ONE SUCCESS among exactly two results. */
    const results = (await verify.handle.db.execute(
      sql.raw(
        `select workflow_id, outcome from task_execution_results where task_id = '${TASK_ID}' order by recorded_at`,
      ),
    )) as unknown as Array<{ workflow_id: string; outcome: string }>;
    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.outcome === "success")).toHaveLength(1);
    expect(results.find((r) => r.outcome === "success")?.workflow_id).toBe(
      workflowIdForAttempt(TASK_ID, 2),
    );

    /* THE TASK COMPLETED — reviewed, not self-declared. */
    expect((await verify.taskRepo.getById(TASK_ID))?.status).toBe("succeeded");

    /*
     * THE WORK IS REAL, AND IT LANDED EXACTLY ONCE.
     *
     * ONE governed branch remains. The killed attempt's branch was reaped BECAUSE IT CARRIED
     * NOTHING: the worker hung before writing, so the branch never left the integration
     * target, and `cleanup` deletes a branch only when the target already contains it.
     * Deleting an empty reference loses no work; preserving one that holds work is proven
     * against the manager, where the rule lives.
     */
    const branches = (await git(repo, ["branch", "--list", "ws/chaos-*"]))
      .split("\n")
      /* `+` marks a branch checked out in another worktree: the governed one, still attached. */
      .map((b) => b.replace(/^[*+]/, "").trim())
      .filter(Boolean);
    expect(branches).toEqual([`ws/chaos-${slugSeq - 1}`]);

    const files = await git(repo, ["show", "--name-only", "--format=", branches[0]!]);
    expect(files.trim()).toBe("src/chaos/proof.txt");

    /*
     * AND THE COMMIT IS ICOS'S, NOT THE WORKER'S. The worker runs no git at all — its gitdir
     * is read-only in the sandbox — so a commit on that branch can only have come from the
     * trusted finalizer. The registry row carries its identity, which is what the gate reads,
     * and the repository it was made in is the one the row declared.
     */
    const workspaces = await verify.workspaces.list();
    const retry = workspaces.find((ws) => ws.workflowId === workflowIdForAttempt(TASK_ID, 2));
    expect(retry!.sourceCommit).toBe((await git(repo, ["rev-parse", branches[0]!])).trim());
    expect(retry!.canonicalRepo).toBe(repo);

    /* THE DEAD ATTEMPT CAPTURED NOTHING: released, with no commit ever recorded for it. */
    const killed = workspaces.find((ws) => ws.workflowId === workflowIdForAttempt(TASK_ID, 1));
    expect(killed!.releasedAt).not.toBeNull();
    expect(killed!.sourceCommit).toBeNull();

    /* AND THE CANONICAL CHECKOUT NEVER MOVED. */
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(canonicalHead);
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
  }, 60_000);

  it("A TOTAL FLEET OUTAGE IS BACK-PRESSURE: the task is not failed, and no retry is spent", async () => {
    const boot = restart();
    const attempt1 = await boot.ledger.prepare({
      missionId: MISSION_ID,
      missionTaskId: MISSION_TASK_ID,
      taskId: TASK_ID,
      attempt: 1,
      workflowId: workflowIdForAttempt(TASK_ID, 1),
      prompt: "Write proof.txt and commit it",
      workerKind: "agent",
      workerId: WORKER_A,
      capability: CAPABILITY,
    });
    await boot.ledger.markDispatched(attempt1.attempt.id, { owner: RUNNER_OWNER, leaseMs: 60_000 });
    await boot.dispatcher.dispatch({
      /* Mission work: a DAG task with review and settlement. */
      executionClass: "DURABLE_MISSION_TASK",
      missionId: MISSION_ID,
      taskId: TASK_ID,
      prompt: "Write proof.txt and commit it",
      workflowId: workflowIdForAttempt(TASK_ID, 1),
      capability: CAPABILITY,
    });

    /* The whole fleet goes down between the failure and the retry. */
    const outage = restart();
    for (const id of [WORKER_A, WORKER_B]) {
      await outage.registration.probe(id, { health: "unhealthy", availability: "unavailable" });
    }

    await expect(outage.qualityControl.recover(MISSION_ID)).rejects.toThrow(
      /QUALITY_CONTROL_NO_ELIGIBLE_WORKER/,
    );

    const verify = restart();
    /* No attempt 2: a fleet outage must not spend a bounded retry budget. */
    expect(await verify.ledger.getByWorkflowId(workflowIdForAttempt(TASK_ID, 2))).toBeNull();
    /* And the task is still alive, waiting for capacity — not failed. */
    expect((await verify.taskRepo.getById(TASK_ID))?.status).not.toBe("failed");
  }, 60_000);
});

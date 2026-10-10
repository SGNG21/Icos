import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git } from "./git";
import { InMemoryWorkspaceRegistry } from "./registry";
import { WorkspaceManager } from "./manager";
import { IntegrationGate, type CommandRunner } from "./integration-gate";
import { IntegrationApplier } from "./integration-applier";
import { WorkspaceExecutionCoordinator } from "./workspace-execution-coordinator";
import { FakeProvisioner, makeRepoFixture, type RepoFixture } from "./test-fixtures";
import { ExternalWorkerTaskExecutionDispatcher } from "@/server/execution/external-worker-task-execution-dispatcher";
import { finalizeSuccessfulWorkerExecution } from "@/server/usecases/finalize-successful-worker-execution";
import { commitWorkerChanges } from "@/server/workspace-manager/git-authority";
import { RuntimeDispatchRouter } from "@/server/execution/runtime-dispatch-router";
import { CommandWorkerExecutor } from "@/server/workers/execution/command-worker-executor";
import {
  createWorkerExecResolver,
  parseWorkerExecCommands,
} from "@/server/workers/execution/exec-command-config";
import { WorkerExecutor } from "@/server/workers/execution/worker-executor";
import { workerRegistryEntrySchema } from "@/core/contracts/worker-registry";
import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import { identities, type TestIdentity } from "@/test/test-identity";

/*
 * DEFECTS 22 + 19, END TO END: a REAL external worker process writes into a GOVERNED
 * workspace, the gate reviews it, the applier integrates it exactly once, and the branch is
 * reaped — with the dispatcher chosen BY RUNTIME the way the container now chooses it.
 *
 * WHAT IS REAL: a real git repository, real worktrees, a real OS process doing the work,
 * the real WorkspaceManager / IntegrationGate / IntegrationApplier / coordinator, and the
 * real RuntimeDispatchRouter.
 *
 * WHAT IS SUBSTITUTED, and why: the gate's shell commands (typecheck/lint/test/build) are a
 * recorded runner, because running four full pnpm suites inside a throwaway fixture would
 * take many minutes and prove pnpm works, not that ICOS integrates correctly. The gate's
 * DECISION LOGIC, its scope/secret/diff/conflict/review rules and every transition are the
 * real ones.
 */

const WORKER_ID = "77777777-7777-4777-8777-777777777777";
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
const FILE_IDENTITIES = identities("gwe2e");
let caseNumber = 0;
let ids: TestIdentity;

let TASK_ID: string;
let MISSION_ID: string;
let WORKFLOW_ID: string;

beforeEach(() => {
  caseNumber += 1;
  ids = FILE_IDENTITIES.forCase(`c${caseNumber}`);
  TASK_ID = ids.task("e2e-1");
  MISSION_ID = ids.mission("e2e");
  /* Via the PRODUCTION helper, so the test cannot assert a shape production does not use. */
  WORKFLOW_ID = ids.workflow(TASK_ID, 1);
});

let fx: RepoFixture;
let git: Git;
let manager: WorkspaceManager;
let applier: IntegrationApplier;
let coordinator: WorkspaceExecutionCoordinator;

/** The gate's external commands always pass; its decision logic is untouched. */
const passingRunner: CommandRunner = { run: async () => ({ code: 0, output: "" }) };

/*
 * A REAL worker: it writes a file in its workspace. It does NOT commit — under ADR 0073 it
 * holds no Git authority at all, and ICOS materializes the tree it leaves.
 */
const WORKER_SCRIPT = `
  const fs = require('fs');
  fs.mkdirSync('src/e2e', { recursive: true });
  fs.writeFileSync('src/e2e/feature.txt', 'built by ' + process.env.ICOS_TASK_ID + '\\n');
  /*
   * NO git HERE (ADR 0073). A confined worker holds no Git authority: its gitdir lives in
   * the canonical .git directory, which the sandbox never grants. It leaves its change as
   * FILES and ICOS — outside the sandbox, after revalidating success, ownership, the lease
   * and the fencing token — materializes the commit through the hardened Git authority.
   * (No backticks in here: this comment lives inside a template literal.)
   */
  process.stdout.write(process.env.ICOS_RESULT_SENTINEL_START + JSON.stringify({
    status: 'succeeded', summary: 'wrote src/e2e/feature.txt', testsRun: ['unit'],
  }) + process.env.ICOS_RESULT_SENTINEL_END);
`;

const attempt = (): DispatchAttempt =>
  ({
    id: "att-1",
    missionId: MISSION_ID,
    missionTaskId: "mt-1",
    taskId: TASK_ID,
    attempt: 1,
    workflowId: WORKFLOW_ID,
    prompt: "build the feature",
    workerId: WORKER_ID,
    state: "dispatched",
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as DispatchAttempt;

const worker = workerRegistryEntrySchema.parse({
  id: WORKER_ID,
  workerKind: "agent",
  displayName: "external",
  capabilities: ["code-generation"],
  /* `binary` is what the deployment configured an executor adapter for. */
  runtime: "binary",
  runtimeSupport: "SUPPORTED_RUNTIME",
  health: "healthy",
  availability: "available",
  metadata: { model: "m", provider: "p", account: "a" },
  updatedAt: new Date().toISOString(),
});

/** Records results in memory; the durable ledger is certified elsewhere. */
function recorder() {
  const results = new Map<string, { outcome: string; result?: string }>();
  return {
    results,
    executionResults: {
      getByWorkflowId: async (id: string) => results.get(id) ?? null,
      record: async (input: { workflowId: string; outcome: string; result?: string }) => {
        results.set(input.workflowId, { outcome: input.outcome, result: input.result });
        return { ok: true as const, record: input, duplicate: false };
      },
    },
  };
}

function buildRuntime() {
  const rec = recorder();
  const fallback: TaskExecutionDispatcher = {
    dispatch: async () => {
      throw new Error("FALLBACK_SHOULD_NOT_RUN: this worker's runtime is external");
    },
  };

  const external = new ExternalWorkerTaskExecutionDispatcher({
    /*
     * THE TRUSTED MATERIALIZATION (ADR 0073), the same function the container gives the
     * production dispatcher. The worker holds no Git authority and commits nothing; ICOS
     * captures the tree it leaves, under the lease and the fencing token, and records the
     * commit the review and the gate then judge.
     */
    finalizeGovernedWork: (work) =>
      finalizeSuccessfulWorkerExecution(
        {
          workspaces: manager,
          gitFor: (repoDir) => new Git(repoDir),
          materialize: commitWorkerChanges,
          /* The repository now travels on the workspace row, bound at allocation. */
          tasks: { getById: async () => ({ id: TASK_ID, title: `Add ${TASK_ID} feature`, riskClass: "reversible" as const, allowedFileScope: ["src/e2e/**"] }) },
        },
        work,
      ),
    executor: new WorkerExecutor({
      binary: new CommandWorkerExecutor(
        createWorkerExecResolver(
          parseWorkerExecCommands(
            JSON.stringify({
              binary: { command: process.execPath, args: ["-e", WORKER_SCRIPT], timeoutMs: 30_000 },
            }),
          ),
        ),
      ),
    }),
    workers: { get: async () => worker } as never,
    /*
     * The lease/resume surface the external dispatcher fences on. Certified durably
     * against PostgreSQL in M6.3/M7; here it only needs to grant the lease so the real
     * execution path runs end to end.
     */
    dispatchAttempts: {
      getByWorkflowId: async () => attempt(),
      acquireExecutionLease: async () => true,
      holdsExecutionLease: async () => true,
      latestResumableState: async () => null,
      recordExecutionFailure: async () => undefined,
      markCompletedByWorkflowId: async () => undefined,
    } as never,
    executionResults: rec.executionResults as never,
    missions: { findById: async () => null } as never,
    tasks: { getById: async () => ({ id: TASK_ID }) } as never,
    durableMemory: {} as never,
    repoPath: fx.master,
    /* THE GOVERNED HOOK: run in the registered workspace, exactly as the container does. */
    workspaceFor: async (input) => {
      if (!input.workflowId) return null;
      const registered = (await manager.list()).find(
        (w) => w.workflowId === input.workflowId && w.releasedAt === null,
      );
      if (!registered) return null;
      return {
        path: registered.worktreePath,
        mode: "writer" as const,
        branch: registered.branch,
        baseCommit: registered.baseCommit,
        dispose: async () => {},
      };
    },
  });

  const router = new RuntimeDispatchRouter({
    dispatchAttempts: { getByWorkflowId: async () => attempt() },
    workers: { get: async () => worker } as never,
    external,
    fallback,
    externalRuntimes: ["binary"],
  });

  return { router, rec };
}

beforeEach(() => {
  fx = makeRepoFixture();
  git = new Git(fx.master);
  manager = new WorkspaceManager({
    git,
    registry: new InMemoryWorkspaceRegistry(),
    provisioner: new FakeProvisioner(),
    worktreeRoot: fx.root,
    masterRepo: fx.master,
  });
  applier = new IntegrationApplier({ git, manager });
});
afterEach(() => fx.cleanup());

function buildCoordinator(
  dispatcher: TaskExecutionDispatcher,
  over: {
    reviewDecisions?: {
      getByWorkflowId(id: string): Promise<{
        decision: string;
        reviewerKind?: string;
        providerMetadata?: { provider?: string; model?: string; routing?: Record<string, unknown> };
      } | null>;
    };
    writerAttempts?: {
      getByWorkflowId(id: string): Promise<{ routingDecision?: Record<string, unknown> } | null>;
    };
  } = {},
) {
  const reviewDecisions =
    "reviewDecisions" in over
      ? over.reviewDecisions
      : {
          getByWorkflowId: async () => ({ decision: "APPROVE", reviewerKind: "deterministic" }),
        };
  return new WorkspaceExecutionCoordinator({
    git,
    manager,
    integrationGate: new IntegrationGate({
      git,
      manager,
      runner: passingRunner,
      database: { reset: async () => {} },
    }),
    integrationApplier: applier,
    /*
     * The canonical review decision, as QC would have persisted it. The gate refuses
     * anything unreviewed, so this is what makes an autonomous ACCEPT reachable at all —
     * and the reviewer identity is a KIND, never a worker id, so self-review stays
     * structurally impossible.
     */
    reviewDecisions,
    writerAttempts: over.writerAttempts,
    dispatcher,
    missions: { listTasks: async () => [] } as never,
    tasks: {} as never,
    durableMemory: {} as never,
    defaultIntegrationTarget: "integration/phase-7",
    defaultFileScope: { owns: ["src/**"], shared: [], forbidden: [] },
  });
}

const target = () => git.resolveCommit("integration/phase-7");

describe("DEFECTS 22 + 19 — governed external worker integration, end to end", () => {
  it("REAL worker -> gate -> integrate -> reap, with the canonical branch advanced ONCE", async () => {
    const { router } = buildRuntime();
    coordinator = buildCoordinator(router);
    const before = await target();

    // 1. Allocate a GOVERNED workspace bound to the canonical workflow id.
    const execWs = await coordinator.allocateWorkspace(
      MISSION_ID,
      TASK_ID,
      WORKER_ID,
      "e2e",
      WORKFLOW_ID,
    );
    const ws = await manager.get(execWs.workspaceId);
    expect(existsSync(ws.worktreePath)).toBe(true);

    // 2-5. Dispatch: routed by RUNTIME to the external executor, which launches a REAL
    //      process that writes and commits INSIDE the governed worktree; then the gate runs.
    const result = await coordinator.executeInWorkspace(MISSION_ID, TASK_ID, {
      taskId: TASK_ID,
      missionId: MISSION_ID,
      prompt: "build the feature",
      workflowId: WORKFLOW_ID,
      /*
       * WHICH ORCHESTRATOR, declared. The router stopped inferring this from executor
       * configuration (declaring an executor used to move mission work silently onto a
       * non-durable path), so a dispatch that declares nothing is refused
       * EXECUTION_CLASS_REQUIRED — and this suite declared nothing, so every case here
       * failed before the worker was ever reached.
       *
       * INTERACTIVE_COMMAND, because what this suite proves is the IN-PROCESS external
       * executor launching a real worker and the gate judging what it wrote. The mapping
       * is total and has no fallback either way: `DURABLE_MISSION_TASK` means Temporal and
       * nothing else, so declaring it here and still expecting the in-process executor
       * would be asking for exactly the second durable executor the architecture forbids.
       * Durable mission orchestration is proven against the real Temporal path, elsewhere.
       */
      executionClass: "INTERACTIVE_COMMAND",
    });

    if (result.error) throw new Error(`coordination failed: ${result.error}`);
    expect(result.decision).toBe("ACCEPT");
    expect(result.success).toBe(true);

    /* The work is real, and it was done in the GOVERNED worktree — not an orphan one. */
    const head = await git.resolveCommit(ws.branch);
    expect(head).not.toBe(ws.baseCommit);

    // 6. INTEGRATED through the canonical applier, as part of the same fenced flow.
    expect(result.integration).toMatchObject({ status: "INTEGRATED", commit: head });

    // 7. The canonical repository state really advanced, read back from git.
    expect(await target()).toBe(head);
    expect(await target()).not.toBe(before);

    // 8. REAP: worktree removed, branch deleted (its commits live on in the target),
    //    archive written first.
    /* The gate already transitioned it to `accepted`; nothing else can grant that. */
    const accepted = await manager.get(execWs.workspaceId);
    expect(accepted.status).toBe("accepted");

    const cleanup = await manager.cleanup(
      execWs.workspaceId,
      accepted.leaseOwner!,
      accepted.fencingToken,
    );
    expect(cleanup.worktreeRemoved).toBe(true);
    expect(cleanup.branchDeleted).toBe(true);
    expect(existsSync(ws.worktreePath)).toBe(false);
    expect(await git.branchExists(ws.branch)).toBe(false);
    expect(existsSync(cleanup.archivePath)).toBe(true);
    /* The work survives the reaping. */
    expect(await git.isAncestor(head, await target())).toBe(true);
  }, 120_000);

  it("RESTART: a fresh applier does NOT integrate the same result twice", async () => {
    const { router } = buildRuntime();
    coordinator = buildCoordinator(router);
    const execWs = await coordinator.allocateWorkspace(
      MISSION_ID,
      TASK_ID,
      WORKER_ID,
      "e2e",
      WORKFLOW_ID,
    );
    await coordinator.executeInWorkspace(MISSION_ID, TASK_ID, {
      taskId: TASK_ID,
      missionId: MISSION_ID,
      prompt: "build the feature",
      workflowId: WORKFLOW_ID,
      /*
       * WHICH ORCHESTRATOR, declared. The router stopped inferring this from executor
       * configuration (declaring an executor used to move mission work silently onto a
       * non-durable path), so a dispatch that declares nothing is refused
       * EXECUTION_CLASS_REQUIRED — and this suite declared nothing, so every case here
       * failed before the worker was ever reached.
       *
       * INTERACTIVE_COMMAND, because what this suite proves is the IN-PROCESS external
       * executor launching a real worker and the gate judging what it wrote. The mapping
       * is total and has no fallback either way: `DURABLE_MISSION_TASK` means Temporal and
       * nothing else, so declaring it here and still expecting the in-process executor
       * would be asking for exactly the second durable executor the architecture forbids.
       * Durable mission orchestration is proven against the real Temporal path, elsewhere.
       */
      executionClass: "INTERACTIVE_COMMAND",
    });
    const headAfterIntegration = await target();

    /*
     * A restarted process: new Git handle, new applier, nothing carried in memory. The
     * exactly-once answer survives because it is a property of the repository.
     */
    const current = await manager.get(execWs.workspaceId);
    const restarted = new IntegrationApplier({ git: new Git(fx.master), manager });
    const replay = await restarted.apply(execWs.workspaceId, {
      lease: { owner: current.leaseOwner!, fencingToken: current.fencingToken },
    });

    expect(replay.status).toBe("ALREADY_INTEGRATED");
    /* The canonical HEAD moved at most once for this logical accepted result. */
    expect(await target()).toBe(headAfterIntegration);
  }, 120_000);

  it("A STALE OR FOREIGN OWNER CANNOT INTEGRATE, even after a valid ACCEPT", async () => {
    const { router } = buildRuntime();
    coordinator = buildCoordinator(router);
    const execWs = await coordinator.allocateWorkspace(
      MISSION_ID,
      TASK_ID,
      WORKER_ID,
      "e2e",
      WORKFLOW_ID,
    );
    await coordinator.executeInWorkspace(MISSION_ID, TASK_ID, {
      taskId: TASK_ID,
      missionId: MISSION_ID,
      prompt: "build the feature",
      workflowId: WORKFLOW_ID,
      /*
       * WHICH ORCHESTRATOR, declared. The router stopped inferring this from executor
       * configuration (declaring an executor used to move mission work silently onto a
       * non-durable path), so a dispatch that declares nothing is refused
       * EXECUTION_CLASS_REQUIRED — and this suite declared nothing, so every case here
       * failed before the worker was ever reached.
       *
       * INTERACTIVE_COMMAND, because what this suite proves is the IN-PROCESS external
       * executor launching a real worker and the gate judging what it wrote. The mapping
       * is total and has no fallback either way: `DURABLE_MISSION_TASK` means Temporal and
       * nothing else, so declaring it here and still expecting the in-process executor
       * would be asking for exactly the second durable executor the architecture forbids.
       * Durable mission orchestration is proven against the real Temporal path, elsewhere.
       */
      executionClass: "INTERACTIVE_COMMAND",
    });
    const head = await target();
    const current = await manager.get(execWs.workspaceId);

    /*
     * A different owner holding a stale report must not be able to move the canonical
     * branch: the gate that produced the ACCEPT may since have been superseded.
     */
    await expect(
      applier.apply(execWs.workspaceId, {
        lease: { owner: "someone-else", fencingToken: current.fencingToken },
      }),
    ).rejects.toThrow(/LEASE_NOT_OWNER/);

    /* A stale FENCING TOKEN is refused too, even for the right owner. */
    await expect(
      applier.apply(execWs.workspaceId, {
        lease: { owner: current.leaseOwner!, fencingToken: current.fencingToken - 1 },
      }),
    ).rejects.toThrow(/STALE_FENCE/);

    expect(await target()).toBe(head);
  }, 120_000);

  it("UNREVIEWED WORK IS NEVER INTEGRATED, even with an applier composed", async () => {
    /*
     * The safety property the whole gate exists for. A worker that did perfect work, with
     * every check passing, must still not reach the canonical branch without an independent
     * verdict — and silence is not consent.
     */
    const { router } = buildRuntime();
    const unreviewed = buildCoordinator(router, { reviewDecisions: undefined });
    const before = await target();

    await unreviewed.allocateWorkspace(MISSION_ID, TASK_ID, WORKER_ID, "e2e", WORKFLOW_ID);
    const result = await unreviewed.executeInWorkspace(MISSION_ID, TASK_ID, {
      taskId: TASK_ID,
      missionId: MISSION_ID,
      prompt: "build the feature",
      workflowId: WORKFLOW_ID,
      /*
       * WHICH ORCHESTRATOR, declared. The router stopped inferring this from executor
       * configuration (declaring an executor used to move mission work silently onto a
       * non-durable path), so a dispatch that declares nothing is refused
       * EXECUTION_CLASS_REQUIRED — and this suite declared nothing, so every case here
       * failed before the worker was ever reached.
       *
       * INTERACTIVE_COMMAND, because what this suite proves is the IN-PROCESS external
       * executor launching a real worker and the gate judging what it wrote. The mapping
       * is total and has no fallback either way: `DURABLE_MISSION_TASK` means Temporal and
       * nothing else, so declaring it here and still expecting the in-process executor
       * would be asking for exactly the second durable executor the architecture forbids.
       * Durable mission orchestration is proven against the real Temporal path, elsewhere.
       */
      executionClass: "INTERACTIVE_COMMAND",
    });

    /*
     * Since M13 (defect 28) absent review no longer produces a premature NEEDS_HUMAN_APPROVAL:
     * the gate does not run at all, and the work waits. The SAFETY PROPERTY is unchanged and
     * is what this test exists for — nothing unreviewed reaches the canonical branch.
     */
    expect(result.awaitingReview).toBe(true);
    expect(result.decision).toBeUndefined();
    expect(result.integration).toBeUndefined();
    expect(await target()).toBe(before);
  }, 120_000);

  it("A REVIEW DEMANDING CHANGES BLOCKS INTEGRATION", async () => {
    const { router } = buildRuntime();
    const rejecting = buildCoordinator(router, {
      reviewDecisions: {
        getByWorkflowId: async () => ({
          decision: "REQUEST_CHANGES",
          reviewerKind: "deterministic",
        }),
      },
    });
    const before = await target();

    await rejecting.allocateWorkspace(MISSION_ID, TASK_ID, WORKER_ID, "e2e", WORKFLOW_ID);
    const result = await rejecting.executeInWorkspace(MISSION_ID, TASK_ID, {
      taskId: TASK_ID,
      missionId: MISSION_ID,
      prompt: "build the feature",
      workflowId: WORKFLOW_ID,
      /*
       * WHICH ORCHESTRATOR, declared. The router stopped inferring this from executor
       * configuration (declaring an executor used to move mission work silently onto a
       * non-durable path), so a dispatch that declares nothing is refused
       * EXECUTION_CLASS_REQUIRED — and this suite declared nothing, so every case here
       * failed before the worker was ever reached.
       *
       * INTERACTIVE_COMMAND, because what this suite proves is the IN-PROCESS external
       * executor launching a real worker and the gate judging what it wrote. The mapping
       * is total and has no fallback either way: `DURABLE_MISSION_TASK` means Temporal and
       * nothing else, so declaring it here and still expecting the in-process executor
       * would be asking for exactly the second durable executor the architecture forbids.
       * Durable mission orchestration is proven against the real Temporal path, elsewhere.
       */
      executionClass: "INTERACTIVE_COMMAND",
    });

    expect(result.decision).toBe("REJECT");
    expect(result.integration).toBeUndefined();
    expect(await target()).toBe(before);
  }, 120_000);

  it("DECISION 0054 — AN APPROVAL BY THE WRITER'S OWN MODEL IS NOT INDEPENDENT: nothing integrates", async () => {
    const run = async (reviewerModel: string) => {
      const { router } = buildRuntime();
      const coordinator = buildCoordinator(router, {
        reviewDecisions: {
          getByWorkflowId: async () => ({
            decision: "APPROVE",
            reviewerKind: "llm",
            /* A ROUTED reviewer on another worker, as QC persists it. */
            providerMetadata: {
              provider: "reviewer-route",
              model: reviewerModel,
              routing: { kind: "ROUTING_DECISION", selected: { workerId: "reviewer-worker" } },
            },
          }),
        },
        /* The writer's durable routing evidence: steered, so its model is known. */
        writerAttempts: {
          getByWorkflowId: async () => ({
            routingDecision: {
              selected: { model: "oc/nemotron-3-ultra-free", modelSteered: true },
            },
          }),
        },
      });
      await coordinator.allocateWorkspace(MISSION_ID, TASK_ID, WORKER_ID, "e2e", WORKFLOW_ID);
      return coordinator.executeInWorkspace(MISSION_ID, TASK_ID, {
        taskId: TASK_ID,
        missionId: MISSION_ID,
        prompt: "build the feature",
        workflowId: WORKFLOW_ID,
        /* The in-process external executor, declared rather than inferred. */
        executionClass: "INTERACTIVE_COMMAND",
      });
    };
    const before = await target();

    /* Same model, different name/route/worker: the canonical gate refuses. */
    const same = await run("nvidia/nvidia/nemotron-3-ultra-550b-a55b");
    expect(same.decision).toBe("NEEDS_HUMAN_APPROVAL");
    expect(same.reasons?.join(" ")).toMatch(/même modèle/);
    expect(same.integration).toBeUndefined();
    expect(await target()).toBe(before);
  }, 120_000);

  it("DECISION 0054 — control: a DIFFERENT model's approval integrates exactly as before", async () => {
    const { router } = buildRuntime();
    const coordinator = buildCoordinator(router, {
      reviewDecisions: {
        getByWorkflowId: async () => ({
          decision: "APPROVE",
          reviewerKind: "llm",
          providerMetadata: {
            provider: "cc",
            model: "cc/claude-opus-5",
            routing: { kind: "ROUTING_DECISION", selected: { workerId: "reviewer-worker" } },
          },
        }),
      },
      writerAttempts: {
        getByWorkflowId: async () => ({
          routingDecision: { selected: { model: "oc/nemotron-3-ultra-free", modelSteered: true } },
        }),
      },
    });
    const before = await target();
    await coordinator.allocateWorkspace(MISSION_ID, TASK_ID, WORKER_ID, "e2e", WORKFLOW_ID);
    const result = await coordinator.executeInWorkspace(MISSION_ID, TASK_ID, {
      taskId: TASK_ID,
      missionId: MISSION_ID,
      prompt: "build the feature",
      workflowId: WORKFLOW_ID,
      /*
       * WHICH ORCHESTRATOR, declared. The router stopped inferring this from executor
       * configuration (declaring an executor used to move mission work silently onto a
       * non-durable path), so a dispatch that declares nothing is refused
       * EXECUTION_CLASS_REQUIRED — and this suite declared nothing, so every case here
       * failed before the worker was ever reached.
       *
       * INTERACTIVE_COMMAND, because what this suite proves is the IN-PROCESS external
       * executor launching a real worker and the gate judging what it wrote. The mapping
       * is total and has no fallback either way: `DURABLE_MISSION_TASK` means Temporal and
       * nothing else, so declaring it here and still expecting the in-process executor
       * would be asking for exactly the second durable executor the architecture forbids.
       * Durable mission orchestration is proven against the real Temporal path, elsewhere.
       */
      executionClass: "INTERACTIVE_COMMAND",
    });
    expect(result.decision).toBe("ACCEPT");
    expect(await target()).not.toBe(before);
  }, 120_000);

  it("A NON-APPROVING VERDICT (escalation) IS NOT CONSENT", async () => {
    const { router } = buildRuntime();
    const escalated = buildCoordinator(router, {
      reviewDecisions: {
        getByWorkflowId: async () => ({
          decision: "ESCALATE_TO_HUMAN",
          reviewerKind: "deterministic",
        }),
      },
    });
    const before = await target();

    await escalated.allocateWorkspace(MISSION_ID, TASK_ID, WORKER_ID, "e2e", WORKFLOW_ID);
    const result = await escalated.executeInWorkspace(MISSION_ID, TASK_ID, {
      taskId: TASK_ID,
      missionId: MISSION_ID,
      prompt: "build the feature",
      workflowId: WORKFLOW_ID,
      /*
       * WHICH ORCHESTRATOR, declared. The router stopped inferring this from executor
       * configuration (declaring an executor used to move mission work silently onto a
       * non-durable path), so a dispatch that declares nothing is refused
       * EXECUTION_CLASS_REQUIRED — and this suite declared nothing, so every case here
       * failed before the worker was ever reached.
       *
       * INTERACTIVE_COMMAND, because what this suite proves is the IN-PROCESS external
       * executor launching a real worker and the gate judging what it wrote. The mapping
       * is total and has no fallback either way: `DURABLE_MISSION_TASK` means Temporal and
       * nothing else, so declaring it here and still expecting the in-process executor
       * would be asking for exactly the second durable executor the architecture forbids.
       * Durable mission orchestration is proven against the real Temporal path, elsewhere.
       */
      executionClass: "INTERACTIVE_COMMAND",
    });

    /*
     * Only APPROVE authorises. An escalating verdict is NOT a review the gate can act on, so
     * since M13 it leaves the work waiting rather than gating it — and, either way, nothing
     * is integrated, which is the property that matters.
     */
    expect(result.decision).not.toBe("ACCEPT");
    expect(result.integration).toBeUndefined();
    expect(await target()).toBe(before);
  }, 120_000);

  it("WITHOUT AN APPLIER the gate still only DECIDES — integration is opt-in", async () => {
    const { router } = buildRuntime();
    const noApply = new WorkspaceExecutionCoordinator({
      git,
      manager,
      integrationGate: new IntegrationGate({
        git,
        manager,
        runner: passingRunner,
        database: { reset: async () => {} },
      }),
      /* integrationApplier deliberately absent */
      reviewDecisions: {
        getByWorkflowId: async () => ({ decision: "APPROVE", reviewerKind: "deterministic" }),
      },
      dispatcher: router,
      missions: { listTasks: async () => [] } as never,
      tasks: {} as never,
      durableMemory: {} as never,
      defaultIntegrationTarget: "integration/phase-7",
      defaultFileScope: { owns: ["src/**"], shared: [], forbidden: [] },
    });

    const before = await target();
    await noApply.allocateWorkspace(MISSION_ID, TASK_ID, WORKER_ID, "e2e", WORKFLOW_ID);
    const result = await noApply.executeInWorkspace(MISSION_ID, TASK_ID, {
      taskId: TASK_ID,
      missionId: MISSION_ID,
      prompt: "build the feature",
      workflowId: WORKFLOW_ID,
      /*
       * WHICH ORCHESTRATOR, declared. The router stopped inferring this from executor
       * configuration (declaring an executor used to move mission work silently onto a
       * non-durable path), so a dispatch that declares nothing is refused
       * EXECUTION_CLASS_REQUIRED — and this suite declared nothing, so every case here
       * failed before the worker was ever reached.
       *
       * INTERACTIVE_COMMAND, because what this suite proves is the IN-PROCESS external
       * executor launching a real worker and the gate judging what it wrote. The mapping
       * is total and has no fallback either way: `DURABLE_MISSION_TASK` means Temporal and
       * nothing else, so declaring it here and still expecting the in-process executor
       * would be asking for exactly the second durable executor the architecture forbids.
       * Durable mission orchestration is proven against the real Temporal path, elsewhere.
       */
      executionClass: "INTERACTIVE_COMMAND",
    });

    expect(result.decision).toBe("ACCEPT");
    expect(result.integration).toBeUndefined();
    /* Autonomous integration is never switched on by upgrading. */
    expect(await target()).toBe(before);
  }, 120_000);
});

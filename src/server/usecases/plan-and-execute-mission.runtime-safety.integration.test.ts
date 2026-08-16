import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { buildMissionContext } from "@/core/context";
import type { Capability } from "@/core/contracts";
import {
  D1PolicyEngine,
  PERMISSION_SUPERVISOR_WORKER_EXECUTE,
  SYSTEM_ACTIONS,
  type PolicyGate,
  type SystemAgent,
} from "@/core/policy";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryMissionContextRepository } from "@/server/context/in-memory/mission-context-repository";
import { InMemoryMissionRepository } from "@/server/mission/in-memory/mission-repository";
import { MissionService } from "@/server/mission/mission-service";
import { D1PolicyService } from "@/server/policy/d1-policy-service";
import type { GetCapabilitySnapshotDeps } from "@/server/usecases/get-capability-snapshot";
import { InMemoryAuditRepository } from "@/server/services/in-memory/audit-repository";
import { InMemoryCapabilityRepository } from "@/server/services/in-memory/capability-repository";
import { IntegrationOrchestrator } from "@/server/integration/integration-orchestrator";
import type { GlobalGatesPort } from "@/server/integration/ports";
import { getSelfStateSnapshot } from "@/server/self-state/get-self-state-snapshot";
import { InMemorySupervisorRepository } from "@/server/supervisor/in-memory/supervisor-repository";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { DeterministicPatchWorker } from "@/server/worker/deterministic-patch-worker";
import type {
  DeterministicPatchCatalog,
  DeterministicPatchDefinition,
  DeterministicPatchWorkerResult,
} from "@/server/worker/deterministic-patch-worker";
import type { CorrectionLoopManagerPort, ReviewerManagerPort } from "@/server/review/ports";
import type { PreviewDeliveryPort } from "@/server/preview/ports";
import { WorktreeManager } from "@/server/worktree/worktree-manager";

import { planAndExecuteMission } from "./plan-and-execute-mission";

const execFile = promisify(execFileCallback);
const NOW = "2026-07-29T09:00:00.000Z";
const TENANT_ID = "tenant-runtime-safety";
const REQUESTER_ID = "human-requester";
const EXECUTOR_ID = "composition-supervisor-executor";
const OBJECTIVE = "Inspect the repository; rm -rf /; $(touch pwned); deploy production";
const PROOF_PATH = "src/runtime-safety-proof.txt";
const FOCUSED_TEST_PATH = "tests/runtime-safety-proof.test.ts";
const PATCH_CONTENT = "composition-owned runtime safety proof\n";
const COMMIT_MESSAGE = "test: apply catalog-owned runtime safety proof";

async function git(repoRoot: string, args: readonly string[]): Promise<string> {
  const result = await execFile("git", [...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function createDisposableRepository(repoRoot: string): Promise<void> {
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.name", "Runtime Safety Fixture"]);
  await git(repoRoot, ["config", "user.email", "runtime-safety-fixture@icos.invalid"]);
  await writeFile(path.join(repoRoot, ".gitignore"), "node_modules/\n.claude/\n", "utf8");
  await writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({ name: "runtime-safety-fixture", private: true, type: "module" }, null, 2) +
      "\n",
    "utf8",
  );
  await execFile("pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--offline"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: "1",
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "src", ".gitkeep"), "baseline source directory\n", "utf8");
  await writeFile(path.join(repoRoot, "src-placeholder.txt"), "baseline\n", "utf8");
  await mkdir(path.dirname(path.join(repoRoot, FOCUSED_TEST_PATH)), { recursive: true });
  await writeFile(
    path.join(repoRoot, FOCUSED_TEST_PATH),
    [
      'import { readFileSync } from "node:fs";',
      'import { expect, it } from "vitest";',
      "",
      `it(\"accepts the catalog-owned patch\", () => {`,
      `  expect(readFileSync(\"${PROOF_PATH}\", \"utf8\")).toBe(${JSON.stringify(PATCH_CONTENT)});`,
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "chore: create runtime safety fixture"]);
}

async function captureSourceState(repoRoot: string) {
  const trackedPaths = (await git(repoRoot, ["ls-files", "-z"])).split("\0").filter(Boolean);
  const files = new Map<string, string>();
  for (const trackedPath of trackedPaths) {
    files.set(trackedPath, (await readFile(path.join(repoRoot, trackedPath))).toString("base64"));
  }
  return {
    branch: await git(repoRoot, ["symbolic-ref", "--short", "HEAD"]),
    head: await git(repoRoot, ["rev-parse", "HEAD"]),
    index: await git(repoRoot, ["diff", "--cached", "--binary"]),
    status: await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    files,
  };
}

class ObservedWorktreeManager extends WorktreeManager {
  readonly taskCreates: string[] = [];
  readonly integrationCreates: string[] = [];
  readonly taskCleanups: string[] = [];
  readonly integrationCleanups: string[] = [];
  readonly integrationStatusesBeforeCleanup: string[] = [];
  readonly integrationCherryPickHeadsBeforeCleanup: Array<string | null> = [];

  constructor(
    worktreeBase: string,
    repoRoot: string,
    private readonly seedIntegrationConflict = false,
  ) {
    super(worktreeBase, repoRoot);
  }

  override async createWorktree(taskId: string, baseSha?: string) {
    const result = await super.createWorktree(taskId, baseSha);
    this.taskCreates.push(result.path);
    return result;
  }

  override async createIntegrationWorktree(input: {
    integrationId: string;
    branch: string;
    baseSha: string;
  }) {
    const result = await super.createIntegrationWorktree(input);
    this.integrationCreates.push(result.path);
    if (this.seedIntegrationConflict) {
      await writeFile(path.join(result.path, PROOF_PATH), "integration conflict\n", "utf8");
      await git(result.path, ["add", "--", PROOF_PATH]);
      await git(result.path, ["commit", "-m", "chore: seed integration conflict"]);
    }
    return result;
  }

  override async cleanupWorktree(worktreePath: string): Promise<void> {
    this.taskCleanups.push(worktreePath);
    await super.cleanupWorktree(worktreePath);
  }

  override async cleanupIntegrationWorktree(
    worktreePath: string,
    options: { preserveBranch: boolean },
  ): Promise<void> {
    this.integrationCleanups.push(worktreePath);
    this.integrationStatusesBeforeCleanup.push(
      await git(worktreePath, ["status", "--porcelain=v1"]).catch(() => "<unreadable>"),
    );
    this.integrationCherryPickHeadsBeforeCleanup.push(
      await git(worktreePath, ["rev-parse", "--verify", "CHERRY_PICK_HEAD"]).catch(() => null),
    );
    await super.cleanupIntegrationWorktree(worktreePath, options);
  }
}

class FixedPolicyGate implements PolicyGate {
  readonly name = "fixed-runtime-safety-test-gate";

  constructor(private readonly decision: "deny" | "require_approval") {}

  evaluate() {
    return this.decision === "deny"
      ? { decision: "deny" as const, code: "forbidden" as const, reason: "fixture denial" }
      : { decision: "require_approval" as const, reason: "fixture approval required" };
  }
}

type FailureCompositionOptions = {
  executor?: SystemAgent | null;
  policy?: D1PolicyService;
  capabilitySeed?: readonly Capability[];
  gates?: GlobalGatesPort;
  seedIntegrationConflict?: boolean;
};

type FailureComposition = {
  tempRepoRoot: string;
  previousCwd: string;
  sourceBefore: Awaited<ReturnType<typeof captureSourceState>>;
  createdMissionId: string;
  missionService: MissionService;
  missionContexts: InMemoryMissionContextRepository;
  capabilitySnapshotDeps: GetCapabilitySnapshotDeps;
  policy: D1PolicyService;
  policyDecisions: ReturnType<typeof vi.spyOn>;
  catalog: DeterministicPatchCatalog;
  worktrees: ObservedWorktreeManager;
  supervisorRepository: InMemorySupervisorRepository;
  supervisor: SupervisorService;
  previewCalls: Array<{ integrationSha: string; integrationBranch: string }>;
  gateWorkspaces: string[];
  dispose: () => Promise<void>;
};

async function createFailureComposition(
  options: FailureCompositionOptions = {},
): Promise<FailureComposition> {
  const sourceRepoRoot = await realpath(process.cwd());
  const tempRepoRoot = await mkdtemp(path.join(os.tmpdir(), "icos-runtime-safety-failure-"));
  const previousCwd = process.cwd();
  const executor: SystemAgent = options.executor ?? {
    id: EXECUTOR_ID,
    tenantId: TENANT_ID,
    roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
    authorizationLevel: 2,
    justification: "Composition-owned bounded local runtime safety execution",
  };
  const previewCalls: Array<{ integrationSha: string; integrationBranch: string }> = [];
  const gateWorkspaces: string[] = [];

  await createDisposableRepository(tempRepoRoot);
  await symlink(
    path.join(sourceRepoRoot, "node_modules"),
    path.join(tempRepoRoot, "node_modules"),
    "dir",
  );
  process.chdir(tempRepoRoot);

  const sourceBefore = await captureSourceState(tempRepoRoot);
  const missionRepository = new InMemoryMissionRepository();
  const missionService = new MissionService(
    missionRepository,
    new InMemoryAuditRepository(new InMemoryAuditLog()),
  );
  const missionContexts = new InMemoryMissionContextRepository();
  const created = await missionService.createMission({
    tenantId: TENANT_ID,
    userRequest: OBJECTIVE,
  });
  if (!created.ok) throw new Error("Mission fixture creation failed");

  const builtContext = buildMissionContext({
    conversation: {
      tenantId: TENANT_ID,
      turns: [
        {
          id: "hostile-objective-turn",
          role: "user",
          text: OBJECTIVE,
          confirmed: true,
          isObjective: true,
          isOpenQuestion: false,
          conflictsWithMission: false,
          observedAt: NOW,
        },
      ],
      memoryReferences: [],
    },
    mission: created.data,
    builtByLabel: REQUESTER_ID,
    now: NOW,
    version: 0,
  });
  if (!builtContext.ok) throw new Error("MissionContext fixture creation failed");
  const savedContext = await missionContexts.save({
    context: builtContext.context,
    expectedVersion: null,
  });
  if (!savedContext.ok) throw new Error("MissionContext fixture persistence failed");

  const taskId = `task-${created.data.id}`;
  const patch: DeterministicPatchDefinition = {
    id: "runtime-safety-proof-patch",
    targets: [
      {
        path: PROOF_PATH,
        expected: { kind: "ABSENT" },
        content: PATCH_CONTENT,
      },
    ],
    focusedTestPaths: [FOCUSED_TEST_PATH],
    commitMessage: COMMIT_MESSAGE,
  };
  const catalog: DeterministicPatchCatalog = {
    get: vi.fn((requestedTaskId: string) =>
      requestedTaskId === taskId ? structuredClone(patch) : undefined,
    ),
  };

  const policy = options.policy ?? new D1PolicyService();
  const policyDecisions = vi.spyOn(policy, "decide");
  const capabilityRepository = new InMemoryCapabilityRepository(
    options.capabilitySeed ?? [capability(NOW)],
  );
  const availability = {
    check: vi.fn(async () => ({
      state: "AVAILABLE" as const,
      evidence: [
        {
          component: "CAPABILITY" as const,
          key: SYSTEM_ACTIONS.SUPERVISOR_WORKER_EXECUTE,
          state: "AVAILABLE" as const,
          source: "INJECTED_RUNTIME_PROBE" as const,
          reason: "deterministic local-only capability availability",
        },
      ],
    })),
  };
  const capabilitySnapshotDeps = {
    capabilities: capabilityRepository,
    availability,
    policy,
    clock: () => new Date(NOW),
  };

  const worktrees = new ObservedWorktreeManager(
    ".claude/worktrees",
    tempRepoRoot,
    options.seedIntegrationConflict,
  );
  const worker = new DeterministicPatchWorker(policy, catalog, {
    taskWorktreeRoot: path.join(tempRepoRoot, ".claude", "worktrees"),
  });
  const supervisorRepository = new InMemorySupervisorRepository();
  const reviewer = {
    conductReview: vi.fn(async () => ({
      verdict: "PASS" as const,
      checks: [
        { category: "tests" as const, description: "fixed focused test", passed: true },
        { category: "scope" as const, description: "catalog-owned target only", passed: true },
        { category: "security" as const, description: "bounded runtime safety", passed: true },
      ],
      summary: "deterministic independent review passed",
      confidence: 5,
      durationMs: 1,
      reviewerWorkerId: "independent-reviewer",
      completedAt: NOW,
    })),
    ensureIndependentReview: vi.fn(async () => true),
  } as unknown as ReviewerManagerPort;
  const corrector = {
    applyCorrection: vi.fn(async () => ({ applied: false })),
  } as unknown as CorrectionLoopManagerPort;
  const gates =
    options.gates ??
    ({
      executeAll: vi.fn(async (workspacePath: string) => {
        gateWorkspaces.push(workspacePath);
        return [{ gate: "deterministic-local-gate", passed: true }];
      }),
      executeGate: vi.fn(async () => ({ gate: "deterministic-local-gate", passed: true })),
      gitDiffCheck: vi.fn(async () => ({ gate: "git-diff-check", passed: true })),
    } as unknown as GlobalGatesPort);
  const preview = {
    deliver: vi.fn(async (integrationSha: string, integrationBranch: string) => {
      previewCalls.push({ integrationSha, integrationBranch });
      return { delivered: true };
    }),
  } as unknown as PreviewDeliveryPort;
  const integrator = new IntegrationOrchestrator(gates, worktrees);
  const supervisor = new SupervisorService(
    supervisorRepository,
    worker,
    worktrees,
    reviewer,
    corrector,
    gates,
    integrator,
    preview,
    {
      agentIdentity: options.executor === null ? undefined : executor,
      maxConcurrentWorkers: 1,
      maxCorrectionRetries: 0,
      defaultWorkerTimeoutMs: 120_000,
    },
  );

  return {
    tempRepoRoot,
    previousCwd,
    sourceBefore,
    createdMissionId: created.data.id,
    missionService,
    missionContexts,
    capabilitySnapshotDeps,
    policy,
    policyDecisions,
    catalog,
    worktrees,
    supervisorRepository,
    supervisor,
    previewCalls,
    gateWorkspaces,
    dispose: async () => {
      process.chdir(previousCwd);
      await rm(tempRepoRoot, { recursive: true, force: true });
    },
  };
}

function assertNoDangerousEffects(
  result: Awaited<ReturnType<typeof planAndExecuteMission>>,
  fixture: FailureComposition,
): void {
  if (!result.ok) {
    expect(result.mergePerformed ?? false).toBe(false);
    expect(result.productionPerformed ?? false).toBe(false);
  } else {
    expect(result.mergePerformed).toBe(false);
    expect(result.productionPerformed).toBe(false);
  }
  const taskEvidence = !result.ok
    ? result.executionResult?.taskEvidence
    : result.outcome === "EXECUTED"
      ? result.executionResult.taskEvidence
      : undefined;
  expect(fixture.previewCalls).toHaveLength(0);
  for (const evidence of Object.values(taskEvidence ?? {})) {
    for (const process of (evidence.workerResult as DeterministicPatchWorkerResult | undefined)
      ?.evidence?.processes ?? []) {
      const args = process.args.join(" ");
      expect(args).not.toContain("rm -rf /");
      expect(args).not.toContain("touch pwned");
      expect(args).not.toContain("deploy production");
    }
  }
}

async function assertSourceUnchanged(fixture: FailureComposition): Promise<void> {
  expect(await captureSourceState(fixture.tempRepoRoot)).toEqual(fixture.sourceBefore);
  expect(await git(fixture.tempRepoRoot, ["remote"])).toBe("");
}

async function assertTerminalFailure(
  fixture: FailureComposition,
  result: Awaited<ReturnType<typeof planAndExecuteMission>>,
): Promise<void> {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe("supervisor_execution_failed");
  expect(result.mission?.status).toBe("FAILED");
  expect(result.dag?.status).toBe("FAILED");
  expect(result.dag?.status).not.toBe("COMPLETED");
  const persistedMission = await fixture.missionService.getMission(fixture.createdMissionId);
  expect(persistedMission?.status).toBe("FAILED");
  const persistedDag = result.dag
    ? await fixture.supervisorRepository.findDagById(result.dag.id)
    : null;
  expect(persistedDag?.status).toBe("FAILED");
  expect(persistedDag?.status).not.toBe("COMPLETED");
  expect(
    Object.values(persistedDag?.nodes ?? {}).every((node) => node.status === "SUCCEEDED"),
  ).toBe(true);
  expect(fixture.worktrees.taskCreates).toHaveLength(1);
  expect(fixture.worktrees.taskCleanups).toEqual(fixture.worktrees.taskCreates);
  expect(fixture.worktrees.integrationCreates).toHaveLength(1);
  expect(fixture.worktrees.integrationCleanups).toEqual(fixture.worktrees.integrationCreates);
  expect(await realpath(fixture.worktrees.taskCreates[0]!).catch(() => null)).toBeNull();
  expect(await realpath(fixture.worktrees.integrationCreates[0]!).catch(() => null)).toBeNull();
  expect(await fixture.worktrees.listActive()).toEqual([]);
  expect(await git(fixture.tempRepoRoot, ["worktree", "list", "--porcelain"])).not.toContain(
    ".claude/worktrees",
  );
  await assertSourceUnchanged(fixture);
  assertNoDangerousEffects(result, fixture);
}

function executeMission(fixture: FailureComposition) {
  return planAndExecuteMission(
    {
      missionService: fixture.missionService,
      missionContexts: fixture.missionContexts,
      capabilitySnapshotDeps: fixture.capabilitySnapshotDeps,
      supervisor: fixture.supervisor,
      supervisorRepository: fixture.supervisorRepository,
      clock: () => new Date(NOW),
      getSelfState: getSelfStateSnapshot,
    },
    { missionId: fixture.createdMissionId },
    { tenantId: TENANT_ID, actorId: REQUESTER_ID },
  );
}

async function assertNonExecutingOutcome(
  fixture: FailureComposition,
  result: Awaited<ReturnType<typeof planAndExecuteMission>>,
  expectedOutcome: "WAITING_FOR_APPROVAL" | "BLOCKED_BY_POLICY" | "PROVIDER_UNAVAILABLE",
  expectedMissionStatus: "WAITING_FOR_APPROVAL" | "BLOCKED_BY_POLICY" | "PROVIDER_UNAVAILABLE",
): Promise<void> {
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.outcome).toBe(expectedOutcome);
  if (result.outcome === "EXECUTED") return;
  expect(result.mission.status).toBe(expectedMissionStatus);
  expect(result.mission.status).not.toBe("COMPLETED");
  expect(result.mergePerformed).toBe(false);
  expect(result.productionPerformed).toBe(false);
  expect(result.blockers[0]?.permissionState).toBe(
    expectedOutcome === "WAITING_FOR_APPROVAL"
      ? "APPROVAL_REQUIRED"
      : expectedOutcome === "BLOCKED_BY_POLICY"
        ? "DENIED"
        : "UNAVAILABLE",
  );
  expect(fixture.catalog.get).not.toHaveBeenCalled();
  expect(fixture.policyDecisions).toHaveBeenCalledTimes(
    expectedOutcome === "PROVIDER_UNAVAILABLE" ? 0 : 1,
  );
  expect(fixture.worktrees.taskCreates).toHaveLength(0);
  expect(fixture.worktrees.integrationCreates).toHaveLength(0);
  expect(fixture.previewCalls).toHaveLength(0);
  const persistedMission = await fixture.missionService.getMission(fixture.createdMissionId);
  expect(persistedMission?.status).toBe(expectedMissionStatus);
  await assertSourceUnchanged(fixture);
}

function policyWithFixedDecision(decision: "deny" | "require_approval"): D1PolicyService {
  return new D1PolicyService(new D1PolicyEngine([new FixedPolicyGate(decision)]));
}

function capability(now: string): Capability {
  return {
    id: "capability-supervisor-worker-execute",
    key: SYSTEM_ACTIONS.SUPERVISOR_WORKER_EXECUTE,
    name: "Supervisor worker execution",
    category: "code",
    status: "active",
    sensitivityLevel: "C1",
    dataCategory: "INTERNAL",
    retentionPolicyRef: {
      maxRetentionDays: 30,
      legalBasis: "contract",
      purpose: "bounded local runtime safety composition",
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe("planAndExecuteMission runtime safety", () => {
  it("composes one successful real mission execution", async () => {
    const sourceRepoRoot = await realpath(process.cwd());
    const tempRepoRoot = await mkdtemp(path.join(os.tmpdir(), "icos-runtime-safety-"));
    const previousCwd = process.cwd();
    const requester = { tenantId: TENANT_ID, actorId: REQUESTER_ID };
    const executor: SystemAgent = {
      id: EXECUTOR_ID,
      tenantId: TENANT_ID,
      roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
      authorizationLevel: 2,
      justification: "Composition-owned bounded local runtime safety execution",
    };
    const previewCalls: Array<{ integrationSha: string; integrationBranch: string }> = [];
    const gateWorkspaces: string[] = [];

    try {
      await createDisposableRepository(tempRepoRoot);
      await symlink(
        path.join(sourceRepoRoot, "node_modules"),
        path.join(tempRepoRoot, "node_modules"),
        "dir",
      );
      process.chdir(tempRepoRoot);

      const sourceBefore = await captureSourceState(tempRepoRoot);
      const missionRepository = new InMemoryMissionRepository();
      const missionService = new MissionService(
        missionRepository,
        new InMemoryAuditRepository(new InMemoryAuditLog()),
      );
      const missionContexts = new InMemoryMissionContextRepository();
      const created = await missionService.createMission({
        tenantId: TENANT_ID,
        userRequest: OBJECTIVE,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("Mission fixture creation failed");

      const builtContext = buildMissionContext({
        conversation: {
          tenantId: TENANT_ID,
          turns: [
            {
              id: "hostile-objective-turn",
              role: "user",
              text: OBJECTIVE,
              confirmed: true,
              isObjective: true,
              isOpenQuestion: false,
              conflictsWithMission: false,
              observedAt: NOW,
            },
          ],
          memoryReferences: [],
        },
        mission: created.data,
        builtByLabel: REQUESTER_ID,
        now: NOW,
        version: 0,
      });
      expect(builtContext.ok).toBe(true);
      if (!builtContext.ok) throw new Error("MissionContext fixture creation failed");
      const savedContext = await missionContexts.save({
        context: builtContext.context,
        expectedVersion: null,
      });
      expect(savedContext.ok).toBe(true);

      const taskId = `task-${created.data.id}`;
      const patch: DeterministicPatchDefinition = {
        id: "runtime-safety-proof-patch",
        targets: [
          {
            path: PROOF_PATH,
            expected: { kind: "ABSENT" },
            content: PATCH_CONTENT,
          },
        ],
        focusedTestPaths: [FOCUSED_TEST_PATH],
        commitMessage: COMMIT_MESSAGE,
      };
      const catalog: DeterministicPatchCatalog = {
        get: vi.fn((requestedTaskId: string) =>
          requestedTaskId === taskId ? structuredClone(patch) : undefined,
        ),
      };

      const policy = new D1PolicyService();
      const policyDecisions = vi.spyOn(policy, "decide");
      const capabilityRepository = new InMemoryCapabilityRepository([capability(NOW)]);
      const capabilitySnapshotDeps = {
        capabilities: capabilityRepository,
        availability: {
          check: vi.fn(async () => ({
            state: "AVAILABLE" as const,
            evidence: [
              {
                component: "CAPABILITY" as const,
                key: SYSTEM_ACTIONS.SUPERVISOR_WORKER_EXECUTE,
                state: "AVAILABLE" as const,
                source: "INJECTED_RUNTIME_PROBE" as const,
                reason: "deterministic local-only capability availability",
              },
            ],
          })),
        },
        policy,
        clock: () => new Date(NOW),
      };

      const worktrees = new ObservedWorktreeManager(".claude/worktrees", tempRepoRoot);
      const worker = new DeterministicPatchWorker(policy, catalog, {
        taskWorktreeRoot: path.join(tempRepoRoot, ".claude", "worktrees"),
      });
      const supervisorRepository = new InMemorySupervisorRepository();
      const reviewer = {
        conductReview: vi.fn(async () => ({
          verdict: "PASS" as const,
          checks: [
            { category: "tests" as const, description: "fixed focused test", passed: true },
            { category: "scope" as const, description: "catalog-owned target only", passed: true },
            { category: "security" as const, description: "bounded runtime safety", passed: true },
          ],
          summary: "deterministic independent review passed",
          confidence: 5,
          durationMs: 1,
          reviewerWorkerId: "independent-reviewer",
          completedAt: NOW,
        })),
        ensureIndependentReview: vi.fn(async () => true),
      } as unknown as ReviewerManagerPort;
      const corrector = {
        applyCorrection: vi.fn(async () => ({ applied: false })),
      } as unknown as CorrectionLoopManagerPort;
      const gates = {
        executeAll: vi.fn(async (workspacePath: string) => {
          gateWorkspaces.push(workspacePath);
          return [{ gate: "deterministic-local-gate", passed: true }];
        }),
        executeGate: vi.fn(async () => ({ gate: "deterministic-local-gate", passed: true })),
        gitDiffCheck: vi.fn(async () => ({ gate: "git-diff-check", passed: true })),
      } as unknown as GlobalGatesPort;
      const preview = {
        deliver: vi.fn(async (integrationSha: string, integrationBranch: string) => {
          previewCalls.push({ integrationSha, integrationBranch });
          return { delivered: true };
        }),
      } as unknown as PreviewDeliveryPort;
      const integrator = new IntegrationOrchestrator(gates, worktrees);
      const supervisor = new SupervisorService(
        supervisorRepository,
        worker,
        worktrees,
        reviewer,
        corrector,
        gates,
        integrator,
        preview,
        {
          agentIdentity: executor,
          maxConcurrentWorkers: 1,
          maxCorrectionRetries: 0,
          defaultWorkerTimeoutMs: 120_000,
        },
      );

      expect(requester.actorId).not.toBe(supervisor.getExecutionIdentity()?.id);
      expect(supervisor.getExecutionIdentity()).toEqual(executor);

      const result = await planAndExecuteMission(
        {
          missionService,
          missionContexts,
          capabilitySnapshotDeps,
          supervisor,
          supervisorRepository,
          clock: () => new Date(NOW),
          getSelfState: getSelfStateSnapshot,
        },
        { missionId: created.data.id },
        requester,
      );

      if (!result.ok) {
        throw new Error(
          `runtime safety composition failed: ${result.reason}: ${result.message} ${JSON.stringify(result.executionResult ?? result.dag ?? {})}`,
        );
      }
      if (result.outcome !== "EXECUTED") {
        throw new Error(`runtime safety composition did not execute: ${result.outcome}`);
      }
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("EXECUTED");
      expect(result.mergePerformed).toBe(false);
      expect(result.productionPerformed).toBe(false);
      expect(result.mission.userRequest).toBe(OBJECTIVE);
      expect(result.executionResult.status).toBe("SUCCEEDED");
      expect(result.executionResult.dag.status).toBe("COMPLETED");
      expect(
        Object.values(result.executionResult.dag.nodes).every(
          (node) => node.status === "SUCCEEDED",
        ),
      ).toBe(true);

      expect(catalog.get).toHaveBeenCalledWith(taskId);
      const evidence = result.executionResult.taskEvidence?.[taskId];
      expect(evidence).toBeDefined();
      const workerResult = evidence?.workerResult as unknown as {
        outcome: string;
        evidence: {
          patchId: string;
          targetFiles: string[];
          focusedTestsPassed: boolean;
          commitSha?: string;
          processes: Array<{ executable: string; args: readonly string[] }>;
        };
        mergePerformed: false;
        productionPerformed: false;
      };
      expect(workerResult.outcome).toBe("SUCCESS");
      expect(workerResult.evidence.patchId).toBe(patch.id);
      expect(workerResult.evidence.targetFiles).toEqual([PROOF_PATH]);
      expect(workerResult.evidence.focusedTestsPassed).toBe(true);
      expect(workerResult.evidence.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(workerResult.evidence.processes.map((process) => process.executable)).toEqual(
        expect.arrayContaining(["git", "pnpm"]),
      );
      expect(
        workerResult.evidence.processes.some(
          (process) =>
            process.executable === "pnpm" && process.args.join(" ").includes(FOCUSED_TEST_PATH),
        ),
      ).toBe(true);
      expect(
        workerResult.evidence.processes.some(
          (process) =>
            process.args.join(" ").includes("rm -rf") ||
            process.args.join(" ").includes("touch pwned") ||
            process.args.join(" ").includes("deploy production"),
        ),
      ).toBe(false);
      expect(workerResult.mergePerformed).toBe(false);
      expect(workerResult.productionPerformed).toBe(false);
      expect(evidence?.worktreeResult?.commitShas.length).toBeGreaterThan(0);
      expect(evidence?.worktreeResult?.commitMessages).toContain(COMMIT_MESSAGE);

      expect(policyDecisions).toHaveBeenCalledTimes(2);
      const preflightRequest = policyDecisions.mock.calls[0]?.[0];
      const workerRequest = policyDecisions.mock.calls[1]?.[0];
      expect(preflightRequest?.actor).toEqual(workerRequest?.actor);
      expect(preflightRequest?.actor).toEqual({
        kind: "system",
        id: EXECUTOR_ID,
        tenantId: TENANT_ID,
        roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
        authorizationLevel: 2,
      });
      expect(preflightRequest?.actor).not.toEqual({ kind: "human", id: REQUESTER_ID });
      expect(preflightRequest?.action).toBe(SYSTEM_ACTIONS.SUPERVISOR_WORKER_EXECUTE);
      expect(workerRequest?.action).toBe(SYSTEM_ACTIONS.SUPERVISOR_WORKER_EXECUTE);
      expect(preflightRequest?.actor?.roles).not.toContain(OBJECTIVE);
      expect(workerRequest?.actor?.roles).not.toContain(OBJECTIVE);
      expect(workerRequest?.actor?.authorizationLevel).toBe(2);

      const persistedMission = await missionService.getMission(created.data.id);
      expect(persistedMission?.status).toBe("COMPLETED");
      const persistedDag = await supervisorRepository.findDagById(result.dag.id);
      expect(persistedDag?.status).toBe("COMPLETED");
      expect(
        Object.values(persistedDag?.nodes ?? {}).every((node) => node.status === "SUCCEEDED"),
      ).toBe(true);

      expect(result.executionResult.integrationResult?.status).toBe("SUCCEEDED");
      expect(result.executionResult.integrationResult?.finalSha).toMatch(/^[0-9a-f]{40}$/);
      expect(previewCalls.length).toBe(1);
      expect(gateWorkspaces).toHaveLength(1);
      expect(gateWorkspaces[0]).toBe(worktrees.integrationCreates[0]);

      const sourceAfter = await captureSourceState(tempRepoRoot);
      expect(sourceAfter).toEqual(sourceBefore);
      expect(await git(tempRepoRoot, ["remote"]).then((value) => value)).toBe("");
      expect(worktrees.taskCreates).toHaveLength(1);
      expect(worktrees.taskCleanups).toEqual(worktrees.taskCreates);
      expect(worktrees.integrationCreates).toHaveLength(1);
      expect(worktrees.integrationCleanups).toEqual(worktrees.integrationCreates);
      expect(await realpath(worktrees.taskCreates[0]).catch(() => null)).toBeNull();
      expect(await realpath(worktrees.integrationCreates[0]).catch(() => null)).toBeNull();
      expect(await worktrees.listActive()).toEqual([]);
      expect(await git(tempRepoRoot, ["branch", "--list", `worktree-${taskId}`])).toBe("");
      expect(await git(tempRepoRoot, ["branch", "--list", "integration/*"])).toContain(
        "integration/",
      );
    } finally {
      process.chdir(previousCwd);
      await rm(tempRepoRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when GlobalGates rejects the real integration", async () => {
    const gates = {
      executeAll: vi.fn(async () => [
        { gate: "deterministic-local-gate", passed: false, reason: "fixture gate failure" },
      ]),
      executeGate: vi.fn(async () => ({ gate: "deterministic-local-gate", passed: false })),
      gitDiffCheck: vi.fn(async () => ({ gate: "git-diff-check", passed: false })),
    } as unknown as GlobalGatesPort;
    const fixture = await createFailureComposition({ gates });
    try {
      const result = await executeMission(fixture);
      await assertTerminalFailure(fixture, result);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.executionResult?.integrationResult?.status).toBe("GATES_FAILED");
        expect(result.executionResult?.integrationResult?.gateResults).toEqual([
          { gate: "deterministic-local-gate", passed: false, reason: "fixture gate failure" },
        ]);
      }
      expect(gates.executeAll).toHaveBeenCalledWith(fixture.worktrees.integrationCreates[0]);
      expect(fixture.worktrees.integrationStatusesBeforeCleanup[0]).toBe("");
    } finally {
      await fixture.dispose();
    }
  });

  it("fails closed on a real integration conflict and aborts cherry-pick", async () => {
    const fixture = await createFailureComposition({ seedIntegrationConflict: true });
    try {
      const result = await executeMission(fixture);
      await assertTerminalFailure(fixture, result);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.executionResult?.integrationResult?.status).toBe("CONFLICT");
        expect(result.executionResult?.integrationResult?.conflict?.files).toEqual([PROOF_PATH]);
        expect(result.executionResult?.integrationResult?.commitsIntegrated).toBe(0);
      }
      expect(fixture.worktrees.integrationCherryPickHeadsBeforeCleanup[0]).toBeNull();
      expect(fixture.worktrees.integrationStatusesBeforeCleanup[0]).toContain(`AA ${PROOF_PATH}`);
    } finally {
      await fixture.dispose();
    }
  });

  it("fails closed when the Supervisor executor identity is absent", async () => {
    const fixture = await createFailureComposition({ executor: null });
    try {
      const result = await executeMission(fixture);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("capability_preflight_failed");
        expect(result.message).toContain("identité d'exécution système");
        expect(result.dag).toBeUndefined();
        expect(result.mergePerformed ?? false).toBe(false);
        expect(result.productionPerformed ?? false).toBe(false);
      }
      expect(fixture.policyDecisions).not.toHaveBeenCalled();
      expect(fixture.catalog.get).not.toHaveBeenCalled();
      expect(fixture.worktrees.taskCreates).toHaveLength(0);
      expect(fixture.worktrees.integrationCreates).toHaveLength(0);
      expect(fixture.previewCalls).toHaveLength(0);
      expect(await fixture.missionService.getMission(fixture.createdMissionId)).toMatchObject({
        status: "CREATED",
        userRequest: OBJECTIVE,
      });
      await assertSourceUnchanged(fixture);
    } finally {
      await fixture.dispose();
    }
  });

  it("blocks an executor with an invalid role at D1 preflight", async () => {
    const fixture = await createFailureComposition({
      executor: {
        id: EXECUTOR_ID,
        tenantId: TENANT_ID,
        roles: ["invalid.runtime.role"],
        authorizationLevel: 2,
        justification: "Composition-owned invalid-role fixture",
      },
    });
    try {
      const result = await executeMission(fixture);
      await assertNonExecutingOutcome(fixture, result, "BLOCKED_BY_POLICY", "BLOCKED_BY_POLICY");
      expect(result.ok).toBe(true);
      if (result.ok && result.outcome !== "EXECUTED") {
        expect(result.plan).toBeDefined();
        expect(result.blockers[0]?.reason).toMatch(/permission|role|autor/i);
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("blocks an executor below authorization level 2 at D1 preflight", async () => {
    const fixture = await createFailureComposition({
      executor: {
        id: EXECUTOR_ID,
        tenantId: TENANT_ID,
        roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
        authorizationLevel: 1,
        justification: "Composition-owned insufficient-authorization fixture",
      },
    });
    try {
      const result = await executeMission(fixture);
      await assertNonExecutingOutcome(fixture, result, "BLOCKED_BY_POLICY", "BLOCKED_BY_POLICY");
      expect(result.ok).toBe(true);
      if (result.ok && result.outcome !== "EXECUTED") {
        expect(result.blockers[0]?.reason).toContain("niveau 2");
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("waits for approval when D1 returns APPROVAL_REQUIRED", async () => {
    const fixture = await createFailureComposition({
      policy: policyWithFixedDecision("require_approval"),
    });
    try {
      const result = await executeMission(fixture);
      await assertNonExecutingOutcome(
        fixture,
        result,
        "WAITING_FOR_APPROVAL",
        "WAITING_FOR_APPROVAL",
      );
      expect(result.ok).toBe(true);
      if (result.ok && result.outcome !== "EXECUTED") {
        expect(result.blockers[0]?.reason).toBe("fixture approval required");
        expect(result).not.toHaveProperty("approval");
        expect(result).not.toHaveProperty("executionGrant");
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("blocks when D1 returns DENIED", async () => {
    const fixture = await createFailureComposition({
      policy: policyWithFixedDecision("deny"),
    });
    try {
      const result = await executeMission(fixture);
      await assertNonExecutingOutcome(fixture, result, "BLOCKED_BY_POLICY", "BLOCKED_BY_POLICY");
      expect(result.ok).toBe(true);
      if (result.ok && result.outcome !== "EXECUTED") {
        expect(result.blockers[0]?.reason).toBe("fixture denial");
        expect(result).not.toHaveProperty("approval");
        expect(result).not.toHaveProperty("executionGrant");
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("reports UNAVAILABLE without dispatching a worker", async () => {
    const fixture = await createFailureComposition({ capabilitySeed: [] });
    try {
      const result = await executeMission(fixture);
      await assertNonExecutingOutcome(
        fixture,
        result,
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_UNAVAILABLE",
      );
      expect(result.ok).toBe(true);
      if (result.ok && result.outcome !== "EXECUTED") {
        expect(result.blockers[0]?.reason).toContain("missing");
        expect(result).not.toHaveProperty("approval");
        expect(result).not.toHaveProperty("executionGrant");
      }
    } finally {
      await fixture.dispose();
    }
  });
});

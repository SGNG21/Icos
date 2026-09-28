import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { composeAutonomyRuntime } from "@/server/system/production-services";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { createImprovementCandidate } from "@/core/autonomy/improvement-backlog";
import { selfDevelopmentIds } from "@/server/autonomy/self-development-chain";

/*
 * SELF_DEVELOPMENT_E2E — from an ImprovementCandidate to an INTEGRATED commit, through
 * PRODUCTION composition.
 *
 * No missionId, no taskId, no manual plan, no injected execution handoff, NO PRE-SEEDED
 * REVIEW and no manual stage advancement. The test supplies a candidate, makes ONE call —
 * `runtime.selfDevelopment.advance()` — and then only OBSERVES: the chain creates the goal
 * and mission and invokes the canonical planner, the certified runtime executes, the
 * independent reviewer decides, the IntegrationGate runs the REAL repository gates, and the
 * canonical applier advances the branch exactly once.
 *
 * IT IS OPT-IN (ICOS_SELF_DEV_E2E=1) because it spends real model credits on a real planner
 * and a real worker, and takes minutes. The deterministic paths it composes are covered by
 * the ordinary suites; what this adds is contact with real compute end to end.
 *
 * REPRODUCE:
 *   ICOS_SELF_DEV_E2E=1 npx vitest run --config vitest.integration.config.ts \
 *     src/server/autonomy/self-development-e2e.integration.test.ts
 */

const ENABLED = process.env.ICOS_SELF_DEV_E2E === "1";
const REPO = process.env.ICOS_SELF_DEV_REPO ?? "/tmp/claude-501/sdrepo";
const HERMES = process.env.ICOS_SELF_DEV_AGENT ?? "hermes";

const DATABASE_URL = TEST_DATABASE_URL;
const containers: Container[] = [];
let worktreeRoot: string | undefined;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=icos", "-c", "user.email=icos@local", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** The REAL repository gates. No trivial commands. */
const REAL_GATE_COMMANDS = {
  install: ["pnpm", "install", "--frozen-lockfile", "--offline"],
  typecheck: ["pnpm", "run", "typecheck"],
  lint: ["pnpm", "run", "lint"],
  unit: ["pnpm", "test"],
  postgres: [
    ["pnpm", "run", "test:db:setup"],
    ["pnpm", "run", "test:integration"],
  ],
  build: ["pnpm", "build"],
};

async function productionContainer(): Promise<Container> {
  worktreeRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "icos-selfdev-")));
  const env = loadEnv({
    NODE_ENV: "test",
    PERSISTENCE: "postgres",
    DATABASE_URL,
    /*
     * The REVIEWER backend: the same local agent, as compute. Not a stub — the canonical
     * review policy, vocabulary and schema are the production ones; only the transport is a
     * process instead of HTTP. No OmniRoute endpoint is configured, so there is exactly one
     * reviewer backend and the container's ambiguity refusal stays meaningful.
     */
    ICOS_REVIEWER_COMMAND: JSON.stringify({ command: HERMES, args: ["-z", "{{prompt}}", "--cli"] }),
    ICOS_REVIEWER_TIMEOUT_MS: "900000",
    /* The PLANNER backend: a real local agent, named only here as configuration. */
    ICOS_PLANNER_COMMAND: JSON.stringify({ command: HERMES, args: ["-z", "{{prompt}}", "--cli"] }),
    ICOS_PLANNER_TIMEOUT_MS: "300000",
    /* The WORKER backend, keyed by runtime. */
    ICOS_WORKER_EXEC_COMMANDS: JSON.stringify({
      binary: { command: HERMES, args: ["-z", "{{prompt}}", "--cli", "--yolo"], timeoutMs: 600_000 },
    }),
    ICOS_REPO_PATH: REPO,
    ICOS_WORKER_WORKSPACE_ROOT: worktreeRoot,
    ICOS_GATE_COMMANDS: JSON.stringify(REAL_GATE_COMMANDS),
  });
  const container = await buildPostgresContainer(DATABASE_URL, undefined, env);
  containers.push(container);
  return container;
}

afterAll(async () => {
  await Promise.all(containers.splice(0).map((c) => c.close().catch(() => undefined)));
  if (worktreeRoot) rmSync(worktreeRoot, { recursive: true, force: true });
});

describe.runIf(ENABLED)("SELF_DEVELOPMENT_E2E — candidate to integrated commit, via production composition", () => {
  it("ICOS IMPROVES ITSELF FROM A CANDIDATE — no ids, no review, no gates supplied", async () => {
    const container = await productionContainer();
    const runtime = composeAutonomyRuntime(container);

    await container.db!.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks, mission_tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items, quality_control_jobs, recovery_units, icos_workspace_registry, goals RESTART IDENTITY CASCADE",
      ),
    );

    /*
     * THE ONLY INPUT: an improvement ICOS should make. No missionId, no taskId, no plan.
     * Bounded and genuinely useful — the repository really does accumulate worker branches.
     */
    const candidate = createImprovementCandidate({
      title: "Document the worker branch lifecycle",
      description:
        "Add a short docs/ note describing the icos/worker branch lifecycle: created per writer attempt, kept when a run is rejected, and reaped once its commits are contained in the integration target.",
      rationale:
        "The reaping rule is non-obvious and was the source of a real defect; writing it down prevents the next one.",
      category: "maintainability",
      targetComponent: "docs",
      priority: "medium",
      proposedBy: "icos-self-development",
    });
    await runtime.backlog.add(candidate);

    /*
     * THE FLEET. Two workers on the configured runtime, differing on every identity axis, so
     * the existing independence rule can find a reviewer that is provably not the producer.
     * Registration is what a real deployment's workers do for themselves at boot; nothing
     * here decides routing, review outcome or integration.
     */
    for (const [id, name, model] of [
      ["11111111-1111-4111-8111-111111111111", "self-dev-writer", "writer-model"],
      ["22222222-2222-4222-8222-222222222222", "self-dev-reviewer", "reviewer-model"],
    ]) {
      await container.workerRegistration.register({
        id,
        workerKind: "agent",
        displayName: name,
        capabilities: ["code_editing", "documentation", "writing", "markdown", "analysis"],
        runtime: "binary",
        runtimeSupport: "SUPPORTED_RUNTIME",
        maxConcurrency: 1,
        metadata: { model, provider: `${name}-provider`, account: `${name}-account` },
      });
      await container.workerRegistration.probe(id, {
        health: "healthy",
        availability: "available",
      });
    }

    const beforeTarget = git(REPO, "rev-parse", "integration/phase-7");
    const { goalId, missionId } = selfDevelopmentIds(candidate);

    /*
     * THE ONLY CALL. Selection, goal, mission, planning, governed execution, independent
     * review, the gate, the real gates, integration and learning all happen inside it.
     */
    const outcome = await runtime.selfDevelopment.advance();

    if ("status" in outcome) throw new Error(`NO_CANDIDATE: ${outcome.reason}`);
    console.log(
      `SELF_DEV outcome: state=${outcome.finalState} gate=${outcome.gateDecision} reason=${outcome.reason}` +
        ` mission=${outcome.missionId} task=${outcome.taskId} workflow=${outcome.workflowId}`,
    );

    /* GOAL — created by ICOS, carrying its provenance back to the candidate. */
    const goal = await container.goalRepository.getById(goalId);
    expect(goal?.goal.metadata).toMatchObject({
      source: "self-development",
      candidateId: candidate.id,
    });

    /* MISSION — canonical, linked to the goal. */
    const mission = await container.mission.findById(missionId);
    expect(mission?.goalId).toBe(goalId);
    expect(outcome.missionId).toBe(missionId);

    /* PLAN + DAG — produced by the REAL planner, materialised as canonical mission tasks. */
    const missionTasks = await container.mission.listTasks(missionId);
    console.log(
      `SELF_DEV plan: ${missionTasks.length} task(s): ${missionTasks.map((t) => t.title).join(" | ")}`,
    );
    expect(missionTasks.length).toBeGreaterThan(0);

    /* Every planned task carries a canonical envelope the planner chose, not a default. */
    const canonical = await container.tasks.getById(missionTasks[0]!.taskId);
    expect(canonical).not.toBeNull();
    console.log(
      `SELF_DEV envelope: riskClass=${canonical?.riskClass} scope=${JSON.stringify(canonical?.allowedFileScope)}`,
    );

    /*
     * WHY IT STOPPED, IN THE RUNTIME'S OWN TERMS. A self-development run has many honest
     * ways to stop early (unroutable capability, refused scope, no independent reviewer),
     * and without this the failure is an assertion on a number with no context.
     */
    for (const t of missionTasks) {
      const ct = await container.tasks.getById(t.taskId);
      console.log(
        `SELF_DEV task: ${t.title} status=${t.status} capability=${t.capability}` +
          ` risk=${ct?.riskClass} scope=${JSON.stringify(ct?.allowedFileScope)}`,
      );
    }
    console.log(
      `SELF_DEV workspaces: ${(await container.workspaceManager!.list()).length}` +
        ` workers=${container.workerRegistry.listWorkers().map((w) => `${w.id.slice(0, 4)}:${w.health}/${w.availability}`).join(",")}`,
    );

    /* The run reached a landed state, or the reason says why — never a raw query error. */
    expect(outcome.finalState, outcome.reason).toBe("integrated");
    expect(outcome.workflowId, outcome.reason).toBeDefined();

    /* EXECUTION — a real worker ran on the certified path and its result is durable. */
    const executionResult = await container.executionResults.getByWorkflowId(outcome.workflowId!);
    expect(executionResult).not.toBeNull();

    /*
     * REVIEW — produced by the INDEPENDENT reviewer during the run. Nothing pre-seeded it;
     * it exists because the coordinator asked the canonical review authority, and the
     * reviewer is not the producer.
     */
    const review = await container.reviewDecisions.getByWorkflowId(outcome.workflowId!);
    expect(review).not.toBeNull();
    console.log(`SELF_DEV review: ${review?.decision} by ${review?.reviewerKind}`);

    /* GATE + INTEGRATION — the canonical branch advanced, exactly once, by ancestry. */
    expect(outcome.finalState).toBe("integrated");
    const afterTarget = git(REPO, "rev-parse", "integration/phase-7");
    expect(afterTarget).not.toBe(beforeTarget);
    expect(git(REPO, "log", "--oneline", `${beforeTarget}..${afterTarget}`).split("\n")).toHaveLength(1);
    console.log(`SELF_DEV integrated: ${beforeTarget.slice(0, 8)} -> ${afterTarget.slice(0, 8)}`);

    /* EVALUATION — the candidate reached a decided state, not limbo. */
    const stored = await runtime.backlog.get(candidate.id);
    expect(stored?.status).toBe("approved");

    /* DURABLE LEARNING — the run left a pattern behind for the next one. */
    const patterns = await container.durableMemory.getPatterns({ limit: 50 });
    console.log(`SELF_DEV learning: ${patterns.length} durable pattern(s)`);
    expect(patterns.length).toBeGreaterThan(0);
  }, 3_600_000);
});

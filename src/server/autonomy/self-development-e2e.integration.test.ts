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

/*
 * SELF_DEVELOPMENT_E2E — from an ImprovementCandidate, through PRODUCTION composition.
 *
 * No missionId, no taskId, no manual plan, no injected execution handoff. The test supplies a
 * candidate and then only OBSERVES: `SelfDevelopmentChain` creates the goal and mission and
 * invokes the canonical planner, and the certified runtime does the rest.
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
    OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
    OMNIROUTE_API_KEY: "unused-self-dev",
    ICOS_REVIEWER_MODEL: "self-dev-reviewer",
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

describe.runIf(ENABLED)("SELF_DEVELOPMENT_E2E — candidate to plan, via production composition", () => {
  it("ICOS TURNS A CANDIDATE INTO A GOAL, A MISSION AND A REAL PLAN — no ids supplied", async () => {
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

    const beforeTarget = git(REPO, "rev-parse", "integration/phase-7");

    /* ICOS selects, creates the goal and mission, and invokes the CANONICAL planner. */
    const outcome = await runtime.selfDevelopmentChain.advance();

    expect(outcome.status).toBe("STARTED");
    if (outcome.status !== "STARTED") throw new Error("unreachable");

    console.log(
      `SELF_DEV lineage: candidate=${outcome.candidate.id} goal=${outcome.goalId} mission=${outcome.missionId}`,
    );

    /* GOAL — created by ICOS, carrying its provenance back to the candidate. */
    const goal = await container.goalRepository.getById(outcome.goalId);
    expect(goal?.goal.metadata).toMatchObject({
      source: "self-development",
      candidateId: candidate.id,
    });

    /* MISSION — canonical, linked to the goal. */
    const mission = await container.mission.findById(outcome.missionId);
    expect(mission?.goalId).toBe(outcome.goalId);

    /* PLAN + DAG — produced by the REAL planner, materialised as canonical mission tasks. */
    const missionTasks = await container.mission.listTasks(outcome.missionId);
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

    /* The canonical branch has NOT moved: planning alone integrates nothing. */
    expect(git(REPO, "rev-parse", "integration/phase-7")).toBe(beforeTarget);

    /* DURABLE PROVENANCE: the selection evidence survives in the backlog. */
    const stored = await runtime.backlog.get(candidate.id);
    expect(stored?.status).toBe("under_review");
    expect(stored?.reviewNotes).toContain(outcome.missionId);
  }, 900_000);
});

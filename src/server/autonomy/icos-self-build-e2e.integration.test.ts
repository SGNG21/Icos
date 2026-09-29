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
import { selfDevelopmentIds } from "@/server/autonomy/self-development-chain";
import { writeSelfDevelopmentEvidence } from "@/server/autonomy/self-development-evidence";

/*
 * ICOS_SELF_BUILD_E2E — the decisive one.
 *
 * THE ONLY INPUT IS A SENTENCE. No improvement candidate, no goal, no missionId, no taskId,
 * no plan, no worker, no review, no approval and no integration call. ICOS decides WHAT to
 * improve, plans it, governs it, writes it, reviews it independently, runs the repository's
 * OWN gates against it, and advances the canonical branch — or it does not, and says why.
 *
 * IT IS OPT-IN (ICOS_SELF_BUILD_E2E=1): it spends real model credits on a real proposer, a
 * real planner, a real worker and a real reviewer, and it runs the full gate suite inside a
 * fresh worktree. Expect several minutes.
 *
 * REPRODUCE:
 *   ICOS_SELF_BUILD_E2E=1 npx vitest run --config vitest.integration.config.ts \
 *     src/server/autonomy/icos-self-build-e2e.integration.test.ts
 */

const ENABLED = process.env.ICOS_SELF_BUILD_E2E === "1";
const REPO = process.env.ICOS_SELF_BUILD_REPO ?? "/tmp/claude-501/sdrepo";
const HERMES = process.env.ICOS_SELF_BUILD_AGENT ?? "hermes";

/*
 * A DEDICATED database. These runs TRUNCATE, and the shared `icos_test` is where every other
 * integration suite lives — a self-build run must not erase their rows, and the next suite
 * must not erase the lineage this run is evidence for.
 */
const DATABASE_URL = process.env.ICOS_SELF_BUILD_DATABASE_URL ?? TEST_DATABASE_URL;

/** The whole input. */
const INSTRUCTION = "Improve ICOS autonomously.";
const containers: Container[] = [];
const heartbeats: NodeJS.Timeout[] = [];
let worktreeRoot: string | undefined;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=icos", "-c", "user.email=icos@local", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/**
 * The REAL repository gates. No trivial commands.
 *
 * THE OPT-IN FLAGS ARE STRIPPED FIRST. A gate command is a child process and inherits this
 * one's environment, so `ICOS_SELF_DEV_E2E=1` reached the gate's own `test:integration` run
 * and it re-entered THIS test — recursively, inside the workspace it was gating, where it
 * failed and rejected the run it was part of. Unsetting them is the fixture's business, not
 * the gate's: the gate is right to run the repository's real commands unmodified.
 */
const withoutOptIn = (...command: string[]): string[] => [
  "env",
  "-u",
  "ICOS_SELF_DEV_E2E",
  "-u",
  "ICOS_SELF_BUILD_E2E",
  ...command,
];

const REAL_GATE_COMMANDS = {
  install: ["pnpm", "install", "--frozen-lockfile", "--offline"],
  typecheck: ["pnpm", "run", "typecheck"],
  lint: ["pnpm", "run", "lint"],
  unit: withoutOptIn("pnpm", "test"),
  postgres: [
    ["pnpm", "run", "test:db:setup"],
    withoutOptIn("pnpm", "run", "test:integration"),
  ],
  build: ["pnpm", "build"],
};

async function productionContainer(): Promise<Container> {
  worktreeRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "icos-selfbuild-")));
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
  for (const h of heartbeats.splice(0)) clearInterval(h);
  await Promise.all(containers.splice(0).map((c) => c.close().catch(() => undefined)));
  if (worktreeRoot) rmSync(worktreeRoot, { recursive: true, force: true });
});

describe.runIf(ENABLED)("ICOS_SELF_BUILD_E2E — from one instruction to an integrated commit", () => {
  it("IMPROVE ICOS AUTONOMOUSLY — and nothing else is supplied", async () => {
    const container = await productionContainer();
    const runtime = composeAutonomyRuntime(container);

    await container.db!.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks, mission_tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items, quality_control_jobs, recovery_units, icos_workspace_registry, goals RESTART IDENTITY CASCADE",
      ),
    );

    /*
     * THE FLEET. Two workers on the configured runtime, differing on every identity axis, so
     * the existing independence rule can find a reviewer that is provably not the producer.
     * Registration is what a real deployment's workers do for themselves at boot.
     */
    const fleet: string[] = [];
    for (const [id, name, model] of [
      ["11111111-1111-4111-8111-111111111111", "self-build-writer", "writer-model"],
      ["22222222-2222-4222-8222-222222222222", "self-build-reviewer", "reviewer-model"],
    ]) {
      await container.workerRegistration.register({
        id,
        workerKind: "agent",
        displayName: name,
        capabilities: ["code_editing", "documentation", "analysis"],
        runtime: "binary",
        runtimeSupport: "SUPPORTED_RUNTIME",
        maxConcurrency: 1,
        metadata: { model, provider: `${name}-provider`, account: `${name}-account` },
      });
      await container.workerRegistration.probe(id, {
        health: "healthy",
        availability: "available",
      });
      fleet.push(id);
    }

    /*
     * KEEP THE FLEET'S EVIDENCE DATED, as production's scheduled probe job does.
     *
     * Health evidence expires after HEALTH_EVIDENCE_MAX_AGE_MS (120s) and the canonical
     * matcher then refuses to route — correctly. An autonomous cycle's own THINKING takes
     * longer than that: proposing and planning with a real model is minutes, so by the time
     * the supervisor routes, a fleet probed once at the start has gone ineligible and the
     * task blocks. `startProductionServices` runs a durable `probe_workers` job every 30s
     * for exactly this reason; `composeAutonomyRuntime` alone does not, so the fixture
     * stands in for it here.
     */
    const heartbeat = setInterval(() => {
      for (const id of fleet) {
        void container.workerRegistration
          .probe(id, { health: "healthy", availability: "available" })
          .catch(() => undefined);
      }
    }, 30_000);
    heartbeats.push(heartbeat);

    const startedAt = new Date().toISOString();
    const beforeTarget = git(REPO, "rev-parse", "integration/phase-7");

    /* The proposer must be COMPOSED, not built here. Absent means ICOS cannot start. */
    expect(runtime.improvementProposer, "no proposer composed: ICOS cannot decide what to improve").toBeDefined();

    /* ================= THE ONLY INPUT ================= */
    const candidate = await runtime.improvementProposer!.propose(INSTRUCTION);
    /* ================================================== */

    console.log(
      `SELF_BUILD proposed: [${candidate.category}/${candidate.priority}] ${candidate.title}` +
        ` -> ${candidate.targetComponent}\n  ${candidate.description}`,
    );
    expect(candidate.status).toBe("proposed");
    expect(candidate.proposedBy).toBe("icos-self-development");

    const { goalId, missionId } = selfDevelopmentIds(candidate);

    /* Everything else: ICOS. */
    /*
     * A RUN THAT THROWS IS STILL A RUN. The evidence below used to be written only after a
     * normal return, so a reviewer or planner failure — 14 minutes of real compute — left
     * nothing at all behind. The throw is captured, recorded, and re-raised afterwards.
     */
    let outcome: Awaited<ReturnType<typeof runtime.selfDevelopment.advance>> | undefined;
    let thrown: unknown;
    try {
      outcome = await runtime.selfDevelopment.advance();
    } catch (error) {
      thrown = error;
    }

    /*
     * THE EVIDENCE, BEFORE THE ASSERTIONS.
     *
     * Written from durable rows, and written whatever the outcome: a run that stops early is
     * exactly the run whose lineage someone needs to read. Doing it after the assertions
     * would record only the successes.
     */
    const record = await writeSelfDevelopmentEvidence({
      container,
      marker: "ICOS_SELF_BUILD_E2E",
      instruction: INSTRUCTION,
      candidateId: candidate.id,
      goalId,
      missionId,
      repoPath: REPO,
      integrationRef: "integration/phase-7",
      targetBefore: beforeTarget,
      targetAfter: git(REPO, "rev-parse", "integration/phase-7"),
      databaseUrl: DATABASE_URL,
      addedCommits: git(REPO, "log", "--reverse", "--oneline", `${beforeTarget}..integration/phase-7`)
        .split("\n")
        .filter(Boolean),
      outPath: `audit/self-build-bootstrap/evidence/icos-self-build-e2e-${startedAt.replace(/[:.]/g, "-")}.md`,
      startedAt,
      outcome: outcome ?? { threw: thrown instanceof Error ? thrown.message : String(thrown) },
      gateCommands: REAL_GATE_COMMANDS,
      notes: [
        "Decision 0052: self-development runs on the canonical path only — QC review (persisted, section 8) -> pending-review sweep -> IntegrationGate -> applier -> integrated settlement. The coordinator never reviews, gates, applies or completes a task itself.",
        `Worker branch and commits survive in ${REPO} even when this run is reset.`,
      ],
    });
    console.log(`SELF_BUILD evidence: ${record}`);

    /* Now that the lineage is on disk, let the failure be a failure. */
    if (thrown) throw thrown;
    if (!outcome) throw new Error("UNREACHABLE: no outcome and no error");

    if ("status" in outcome) throw new Error(`NO_CANDIDATE: ${outcome.reason}`);
    console.log(
      `SELF_BUILD outcome: state=${outcome.finalState} gate=${outcome.gateDecision} reason=${outcome.reason}` +
        ` mission=${outcome.missionId} workflow=${outcome.workflowId}`,
    );

    /* It worked on the candidate IT proposed — no other lineage exists. */
    expect(outcome.candidateId).toBe(candidate.id);
    expect(outcome.missionId).toBe(missionId);

    const goal = await container.goalRepository.getById(goalId);
    expect(goal?.goal.metadata).toMatchObject({
      source: "self-development",
      candidateId: candidate.id,
    });

    const missionTasks = await container.mission.listTasks(missionId);
    console.log(
      `SELF_BUILD plan: ${missionTasks.length} task(s): ${missionTasks.map((t) => t.title).join(" | ")}`,
    );
    expect(missionTasks.length).toBeGreaterThan(0);


    /* WHY IT STOPPED, in the runtime's own terms — not an assertion on a number. */
    for (const t of missionTasks) {
      const ct = await container.tasks.getById(t.taskId);
      console.log(
        `SELF_BUILD task: ${t.title} status=${t.status} risk=${ct?.riskClass}` +
          ` scope=${JSON.stringify(ct?.allowedFileScope)} reqCaps=${JSON.stringify(ct?.requiredCapabilities)} cap=${t.capability} kind=${t.workerKind}`,
      );
    }

    expect(outcome.finalState, outcome.reason).toBe("integrated");
    expect(outcome.workflowId, outcome.reason).toBeDefined();

    /* A REAL worker ran on the certified path, and a REAL independent reviewer judged it. */
    expect(await container.executionResults.getByWorkflowId(outcome.workflowId!)).not.toBeNull();

    /* The canonical branch advanced, exactly once, by git ancestry. */
    const afterTarget = git(REPO, "rev-parse", "integration/phase-7");
    expect(afterTarget).not.toBe(beforeTarget);
    expect(git(REPO, "log", "--oneline", `${beforeTarget}..${afterTarget}`).split("\n")).toHaveLength(1);
    console.log(
      `SELF_BUILD integrated: ${beforeTarget.slice(0, 8)} -> ${afterTarget.slice(0, 8)}\n` +
        git(REPO, "show", "--stat", "--oneline", afterTarget),
    );

    /* And the change is REAL: the integrated commit touches files. */
    expect(git(REPO, "diff", "--name-only", `${beforeTarget}..${afterTarget}`).length).toBeGreaterThan(0);

    /* Evaluation and durable learning. */
    expect((await runtime.backlog.get(candidate.id))?.status).toBe("approved");
    expect(await container.durableMemory.getPatterns({ limit: 50 })).not.toHaveLength(0);
  }, 3_600_000);
});

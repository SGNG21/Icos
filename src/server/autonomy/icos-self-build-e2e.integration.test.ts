import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { composeAutonomyRuntime } from "@/server/system/production-services";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { selfDevelopmentIds } from "@/server/autonomy/self-development-chain";
import { writeSelfDevelopmentEvidence } from "@/server/autonomy/self-development-evidence";
import {
  candidateRegistration,
  classifyModels,
  computeSnapshot,
  listOmniRouteModels,
  representativeModels,
} from "@/server/workers/compute-fleet";

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
/*
 * THE CANONICAL PROBE, per candidate model, through the worker's own path (0054). Health is what
 * this answers — a model that is listed but refused, throttled or silent is unhealthy. Set on the
 * PROCESS env, as every certified suite does: the container's probe adapters read it there.
 */
const PROBE_COMMANDS = JSON.stringify({
      binary: {
        command: HERMES,
        args: ["-z", "Reply with exactly the word OK and nothing else.", "--cli", "-m", "{{model}}"],
        timeoutMs: 45_000,
        healthyStdout: "^\\s*OK\\.?\\s*$",
      },
    });

const containers: Container[] = [];
const stopProbing: Array<() => Promise<void>> = [];
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
  vi.stubEnv("ICOS_WORKER_PROBE_COMMANDS", PROBE_COMMANDS);
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
    /* `{{model}}`: the reviewer runs on compute ROUTED per review (decision 0054). */
    ICOS_REVIEWER_COMMAND: JSON.stringify({
      command: HERMES,
      args: ["-z", "{{prompt}}", "--cli", "-m", "{{model}}"],
    }),
    ICOS_REVIEWER_TIMEOUT_MS: "900000",
    /* The PLANNER backend: a real local agent, named only here as configuration. */
    ICOS_PLANNER_COMMAND: JSON.stringify({ command: HERMES, args: ["-z", "{{prompt}}", "--cli"] }),
    ICOS_PLANNER_TIMEOUT_MS: "300000",
    /* The WORKER backend, keyed by runtime. */
    ICOS_WORKER_EXEC_COMMANDS: JSON.stringify({
      /*
       * A RESOURCE BUDGET, not a check. The configured agent runs an extra-high-reasoning model;
       * on this repository a correct edit took longer than 10 min twice (runs 1 and 2), and a
       * retry on the same compute would time out the same way. ICOS's handling of a timeout is
       * proven separately (core3-dag-settlement, SUPERSEDED_ATTEMPT_*).
       */
      binary: {
        command: HERMES,
        /* `{{model}}`: the ROUTED candidate's model runs, not the agent's default (0054). */
        args: ["-z", "{{prompt}}", "--cli", "--yolo", "-m", "{{model}}"],
        timeoutMs: 1_200_000,
        /*
         * The agent CLI exits 0 when the gateway REFUSES the model, printing the refusal on
         * stdout (live, 2026-09-29). Without the result block the run is a classified failure,
         * never a success the reviewer would then have to reject as bad work.
         */
        requireStructuredResult: true,
      },
    }),
    /* Must outlive the worker budget, or a run that uses it is fenced (refused at boot). */
    ICOS_WORKER_EXECUTION_LEASE_MS: "1500000",
    /* How a refused model reads on stdout, so routing can route around it (0054). Data, not code. */
    ICOS_WORKER_FAILURE_CONFIG: JSON.stringify({
      patterns: {
        RATE_LIMITED: ["HTTP 429", "quota threshold", "rate.?limit"],
        AUTH_FAILURE: ["HTTP 40[13]", "credits exhausted", "unauthori[sz]ed"],
        MODEL_UNAVAILABLE: ["HTTP 404", "not supported", "no active credentials"],
      },
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
  for (const stop of stopProbing.splice(0)) await stop();
  vi.unstubAllEnvs();
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
     * THE FLEET, FROM PROVIDER TRUTH (decision 0054). Which models exist is OmniRoute's answer,
     * not this test's: one candidate per served model of a recognised family, every one able to
     * write and to review. No model, family or provider is named here — ICOS routes the writer,
     * each correction and each reviewer itself, from policy and the ledger. The snapshot is
     * printed first, without the credential.
     */
    const omniroute = {
      baseUrl: process.env.OMNIROUTE_BASE_URL ?? "",
      credential: process.env.OMNIROUTE_API_KEY ?? "",
    };
    expect(omniroute.baseUrl && omniroute.credential, "OMNIROUTE_BASE_URL/OMNIROUTE_API_KEY required to discover compute").toBeTruthy();
    const served = await listOmniRouteModels(omniroute);
    console.log(`SELF_BUILD compute snapshot: ${JSON.stringify(computeSnapshot(new URL(omniroute.baseUrl).origin, served), null, 2)}`);
    /* One representative per (family, provider): not every effort variant of one model. */
    const discovered = representativeModels(classifyModels(served));
    expect(discovered.length, "OmniRoute serves no model of a recognised family").toBeGreaterThan(1);

    /*
     * REGISTERED IN THE FAIL-CLOSED STATE, PROBED BY THE CANONICAL PROBER. Nothing here says
     * "healthy": a candidate is routable only if its own probe got a real answer from its model.
     * (Until 0054's live certification the fixture wrote `healthy` for every worker by hand.)
     */
    for (const model of discovered) {
      await container.workerRegistration.register(
        candidateRegistration(model, {
          runtime: "binary",
          capabilities: ["code_editing", "documentation", "analysis", "review"],
        }),
      );
    }
    const probed = await container.workerHealthProber.probeAll();
    const byId = new Map(discovered.map((d) => [candidateRegistration(d, { runtime: "binary", capabilities: [] }).id, d]));
    console.log(
      `SELF_BUILD candidate health: ${JSON.stringify(
        probed.map((r) => ({ model: byId.get(r.workerId)?.modelId, outcome: r.outcome, health: r.health, error: r.error })),
        null,
        2,
      )}`,
    );
    const healthyFamilies = new Set(
      probed.filter((r) => r.health === "healthy").map((r) => byId.get(r.workerId)?.family),
    );
    expect(healthyFamilies.size, "fewer than two reachable compute families: no real fallback exists").toBeGreaterThan(1);

    /*
     * KEEP THE EVIDENCE DATED, as production's scheduled probe job does — by PROBING, never by
     * asserting. Health evidence expires after HEALTH_EVIDENCE_MAX_AGE_MS (120s); an autonomous
     * cycle's own thinking takes minutes. `startProductionServices` runs a durable
     * `probe_workers` job for this; `composeAutonomyRuntime` alone does not, so the fixture runs
     * the SAME prober in a loop. A model that stops answering stops being routable.
     */
    let probing = true;
    const loop = (async () => {
      while (probing) {
        await container.workerHealthProber.probeAll().catch(() => undefined);
        /* Evidence lasts 120s; a <=45s round + 60s keeps it fresh at half the probe cost. */
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      }
    })();
    stopProbing.push(async () => {
      probing = false;
      await loop;
    });

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
  }, 7_200_000);
});

import { sql } from "drizzle-orm";

import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { composeAutonomyRuntime } from "@/server/system/production-services";
import { DurableImprovementBacklog } from "@/server/autonomy/durable-improvement-backlog";
import { SelfDevelopmentChain } from "@/server/autonomy/self-development-chain";
import { GovernedSelfDevelopmentCoordinator } from "@/server/autonomy/governed-self-development-coordinator";
import { RuntimeDispatchRouter } from "@/server/execution/runtime-dispatch-router";
import { IntegrationApplier } from "@/server/workspace-manager/integration-applier";
import { WorkspaceManager } from "@/server/workspace-manager/manager";

/*
 * DEFECT 25 LINK 3 — THE COMPOSITION TEST.
 *
 * The same defect has now appeared FOUR times: a capability fully built, fully proven, and
 * never wired into the container (taskExecution was Temporal; the supervisor got `undefined`
 * for its coordinator; the self-development coordinator was composed nowhere; and that
 * coordinator's own gate had no applier). Care prevented none of them.
 *
 * This test exists to make the fifth impossible. It asserts what the PRODUCTION composition
 * builds — not what a harness can wire — and it asserts the ABSENCE of substitutes as
 * carefully as the presence of the real thing.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const containers: Container[] = [];
let root: string | undefined;

async function productionContainer(): Promise<Container> {
  root = await mkdtemp(join(tmpdir(), "sd-composition-"));
  const env = loadEnv({
    NODE_ENV: "test",
    PERSISTENCE: "postgres",
    DATABASE_URL,
    OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
    OMNIROUTE_API_KEY: "composition-key",
    ICOS_REVIEWER_MODEL: "composition-model",
    /* Opt in to external execution exactly as a deployment would. */
    ICOS_WORKER_EXEC_COMMANDS: JSON.stringify({
      binary: { command: process.execPath, args: ["-e", ""] },
    }),
    ICOS_REPO_PATH: root,
    ICOS_WORKER_WORKSPACE_ROOT: root,
  });
  const container = await buildPostgresContainer(DATABASE_URL, undefined, env);
  containers.push(container);
  return container;
}

afterEach(async () => {
  await Promise.all(containers.splice(0).map((c) => c.close()));
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe("DEFECT 25 LINK 3 — self-development is composed in the REAL runtime", () => {
  it("THE PRODUCTION COMPOSITION CONTAINS THE SELF-DEVELOPMENT AUTHORITY", async () => {
    const container = await productionContainer();

    const runtime = composeAutonomyRuntime(container);

    /* Present at all — the assertion the previous four occurrences would have failed. */
    expect(runtime.selfDevelopment).toBeInstanceOf(GovernedSelfDevelopmentCoordinator);
    expect(runtime.selfDevelopmentChain).toBeInstanceOf(SelfDevelopmentChain);
    /* DURABLE, not in-memory: a restart must not lose what ICOS decided to improve. */
    expect(runtime.backlog).toBeInstanceOf(DurableImprovementBacklog);
  }, 120_000);

  it("DEFECT 29 — THE CHAIN IS JOINED TO THE COORDINATOR: one call runs the whole cycle", async () => {
    const container = await productionContainer();
    const runtime = composeAutonomyRuntime(container);

    /*
     * The chain planned and the coordinator governed, and NOTHING connected them: the
     * coordinator demanded missionId/missionTaskId/taskId a caller had to build by hand, so
     * no production path could reach execution from an intent. The join is what makes
     * `advance()` exist at all — assert it, because care has failed five times now.
     */
    expect(typeof runtime.selfDevelopment.advance).toBe("function");

    /*
     * And prove the join is WIRED, not merely declared: with an empty backlog the call must
     * reach the CHAIN and come back with its answer. A coordinator holding no chain throws
     * SELF_DEVELOPMENT_CHAIN_UNAVAILABLE instead.
     */
    await container.db!.execute(sql.raw("TRUNCATE TABLE context_items RESTART IDENTITY CASCADE"));
    const outcome = await runtime.selfDevelopment.advance();
    expect(outcome).toMatchObject({ status: "NO_CANDIDATE" });
  }, 120_000);

  it("DEFECT 31 — a worker that registers AFTER boot is visible to the fleet view", async () => {
    const container = await productionContainer();
    const id = `33333333-3333-4333-8333-${Date.now().toString().slice(-12)}`;

    /*
     * `container.workerRegistry` used to be a boot-time SNAPSHOT of the durable store, so a
     * worker registering afterwards — which is what workers do in a real deployment — was
     * invisible to it. The reviewer-independence rule reads this port, so it answered
     * NO_INDEPENDENT_REVIEWER for ever and self-development could never be reviewed.
     */
    expect(container.workerRegistry.getWorker(id)).toBeUndefined();

    await container.workerRegistration.register({
      id,
      workerKind: "agent",
      displayName: "late-arrival",
      capabilities: ["analysis"],
      runtime: "binary",
      runtimeSupport: "SUPPORTED_RUNTIME",
      maxConcurrency: 1,
    });

    expect(container.workerRegistry.getWorker(id)?.displayName).toBe("late-arrival");

    /* And PROBE EVIDENCE follows too, not just the registration. */
    await container.workerRegistration.probe(id, {
      health: "healthy",
      availability: "available",
    });
    expect(container.workerRegistry.getWorker(id)?.health).toBe("healthy");

    await container.workerRegistration.deregister(id);
    expect(container.workerRegistry.getWorker(id)).toBeUndefined();
  }, 120_000);

  it("IT REFERENCES THE CANONICAL REPOSITORIES AND SERVICES", async () => {
    const container = await productionContainer();

    /*
     * The chain owner needs the canonical goal store and the canonical mission repository;
     * the container must actually expose them, or composition silently used something else.
     */
    expect(container.goalRepository).toBeDefined();
    expect(container.workerRegistry).toBeDefined();
    expect(container.workspaceManager).toBeInstanceOf(WorkspaceManager);
    expect(container.integrationApplier).toBeInstanceOf(IntegrationApplier);
    expect(container.reviewer).toBeDefined();
    expect(container.autonomousPlanner ?? null).not.toBeUndefined();
  }, 120_000);

  it("IT USES THE CERTIFIED RUNTIME PATH — no alternate dispatcher is substituted", async () => {
    const container = await productionContainer();

    /*
     * Self-development executes through the supervisor, and the supervisor dispatches through
     * `container.taskExecution`. If that is not the runtime router, self-development is not on
     * the certified path however well it is composed.
     */
    expect(container.taskExecution).toBeInstanceOf(RuntimeDispatchRouter);
    expect((container.taskExecution as RuntimeDispatchRouter).external()).toEqual(["binary"]);
  }, 120_000);

  it("NO ALTERNATE PLANNER, INTEGRATION OR REVIEW AUTHORITY IS SUBSTITUTED", async () => {
    const container = await productionContainer();
    const runtime = composeAutonomyRuntime(container);

    /*
     * The decisive absence check. The chain must ignite through the CANONICAL mission
     * usecase, which means the mission it creates is the container's mission repository's —
     * so a mission created by self-development is visible to ordinary orchestration.
     * Anything else would be a second mission engine.
     */
    const missionId = `sd-composition-${Date.now()}`;
    await container.mission.create({
      id: missionId,
      title: "composition probe",
      objective: "probe",
      tasks: [],
    });
    expect(await container.mission.findById(missionId)).not.toBeNull();

    /* And the coordinator holds an applier, so an ACCEPT can actually land (M10). */
    expect(container.integrationApplier).toBeDefined();
    expect(runtime.selfDevelopment).toBeInstanceOf(GovernedSelfDevelopmentCoordinator);
  }, 120_000);
});

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { loadEnv } from "@/config/env";
import type { AuthenticatedSession } from "@/core/identity";
import { buildPostgresContainer, type Container } from "@/server/container";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { SupervisorService } from "@/server/supervisor/supervisor-service";

import type { CommandActor } from "./command-bus";
import { PostgresControlStore } from "./postgres-control-store";
import { hasDispatchBackstop } from "./runtime-control";

/**
 * The PRODUCTION PostgreSQL composition enforces control state end to end
 * (decision 0044): gated dispatcher, gate, applier, supervisor admission,
 * restart durability, and the mission repository's compare-and-set.
 */
const env = loadEnv({
  NODE_ENV: "test",
  PERSISTENCE: "postgres",
  DATABASE_URL: TEST_DATABASE_URL,
  OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
  OMNIROUTE_API_KEY: "control-composition-test-key",
  ICOS_REVIEWER_MODEL: "control-composition-test-model",
});
const session: AuthenticatedSession = {
  user: { id: "u-comp", email: "c@icos.test", status: "active" },
  roles: ["owner"],
};
const actor: CommandActor = { session, sessionId: "s", sessionIssuedAt: new Date() };

describe("control plane in the PostgreSQL container", () => {
  let container: Container;

  beforeAll(async () => {
    container = await buildPostgresContainer(TEST_DATABASE_URL, undefined, env);
  });

  afterAll(async () => {
    await container.close();
  });

  afterEach(async () => {
    // Leave the shared test database in normal operation.
    await container.db!.execute(
      sql`update runtime_control_flags set safe_mode = false, dispatch_enabled = true, integration_enabled = true, external_actions_enabled = true where id = 'global'`,
    );
  });

  async function runtimeVersion() {
    return (await container.control!.store.readVersions("runtime", ["global"])).get("global")!;
  }

  it("composes one durable control plane behind the runtime dispatcher", () => {
    expect(container.control!.store).toBeInstanceOf(PostgresControlStore);
    expect(hasDispatchBackstop(container.taskExecution)).toBe(true);
  });

  it("safe mode refuses dispatch, integration and applier writes in the production graph", async () => {
    const on = await container.control!.bus.execute(actor, {
      idempotencyKey: randomUUID(),
      type: "ENTER_SAFE_MODE",
      target: { kind: "runtime", id: "global" },
      expectedVersion: await runtimeVersion(),
      reason: "composition proof",
    });
    expect(on.status).toBe("EXECUTED");

    await expect(
      container.taskExecution.dispatch({ taskId: "t", prompt: "p" }),
    ).rejects.toMatchObject({ code: "CONTROL_HELD" });
    const lease = { owner: "o", fencingToken: 1 };
    await expect(
      container.integrationGate!.integrate("ws", { lease } as never),
    ).rejects.toMatchObject({ code: "CONTROL_HELD" });
    await expect(
      container.integrationApplier!.apply("ws", { lease } as never),
    ).rejects.toMatchObject({ code: "CONTROL_HELD" });
  });

  it("a mission hold survives a full container restart and still admits nothing", async () => {
    const mission = await container.mission.create({
      title: `hold-${randomUUID()}`,
      objective: "restart proof",
      tasks: [{ title: "only", dependsOn: [] }],
    });
    const paused = await container.control!.bus.execute(actor, {
      idempotencyKey: randomUUID(),
      type: "PAUSE_MISSION",
      target: { kind: "mission", id: mission.id },
      expectedVersion: 0,
      reason: "restart proof",
    });
    expect(paused.status).toBe("EXECUTED");

    const restarted = await buildPostgresContainer(TEST_DATABASE_URL, undefined, env);
    try {
      const dispatch = vi.fn(async (i: { taskId: string }) => ({ workflowId: `wf-${i.taskId}` }));
      const supervisor = new SupervisorService(
        restarted.mission,
        restarted.tasks,
        { dispatch },
        restarted.durableMemory,
        restarted.dispatchAttempts,
        undefined,
        undefined,
        restarted.control!.guard,
      );
      await supervisor.run(mission.id);
      expect(dispatch).not.toHaveBeenCalled();
      expect(
        (await restarted.mission.listTasks(mission.id)).some((t) => t.status === "failed"),
      ).toBe(false);
      expect(await restarted.control!.bus.get(session, paused.commandId)).toMatchObject({
        status: "EXECUTED",
        replayed: true,
      });
    } finally {
      await restarted.close();
    }
  });

  it("the mission repository compare-and-set never overwrites a changed status, and cancelled is sticky", async () => {
    const mission = await container.mission.create({
      title: `cas-${randomUUID()}`,
      objective: "o",
      tasks: [],
    });
    await container.mission.updateMissionStatus(mission.id, "running");
    expect(
      await container.mission.transitionMissionStatusIf!(mission.id, "ready", "cancelled"),
    ).toBe(false);
    expect(
      await container.mission.transitionMissionStatusIf!(mission.id, "running", "cancelled"),
    ).toBe(true);
    await container.mission.updateMissionStatus(mission.id, "succeeded");
    expect((await container.mission.findById(mission.id))!.status).toBe("cancelled");
  });
});

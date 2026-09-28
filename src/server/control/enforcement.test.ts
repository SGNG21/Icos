import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { confirmationPhrase, type ControlCommandRequest } from "@/core/control/contracts";
import { evaluateWorkerEligibility } from "@/core/workers/worker-eligibility";
import type { AuthenticatedSession } from "@/core/identity";
import { buildMemoryContainer } from "@/server/container";
import { RuntimeRecoverySweeper } from "@/server/recovery/runtime-recovery-sweeper";
import { SupervisorService } from "@/server/supervisor/supervisor-service";

import type { CommandActor } from "./command-bus";
import { createControlEffects } from "./compose";
import type { InMemoryControlStore } from "./in-memory-control-store";
import { ReauthService } from "./reauth";

/**
 * Enforcement of control state at the REAL admission points of the memory
 * container (decision 0044): supervisor, prepared-dispatch reconciliation,
 * recovery, integration gate, applier, dispatcher backstop, mission cancel.
 */
const session: AuthenticatedSession = {
  user: { id: "u-owner", email: "o@icos.test", status: "active" },
  roles: ["owner"],
};
const actor: CommandActor = { session, sessionId: "s-1", sessionIssuedAt: new Date() };

async function setup() {
  const container = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
  const control = container.control!;
  const dispatched: string[] = [];
  const dispatcher = {
    dispatch: vi.fn(async (input: { taskId: string; workflowId?: string }) => {
      dispatched.push(input.taskId);
      return { workflowId: input.workflowId ?? `wf-${input.taskId}` };
    }),
  };
  const supervisor = new SupervisorService(
    container.mission,
    container.tasks,
    dispatcher,
    container.durableMemory,
    container.dispatchAttempts,
    undefined,
    undefined,
    control.guard,
  );
  const mission = await container.mission.create({
    title: "Held mission",
    objective: "prove holds",
    tasks: [{ title: "first", dependsOn: [] }],
  });
  const tasksBefore = await container.mission.listTasks(mission.id);
  let version = { mission: 0, runtime: 0 };
  const send = async (
    over: Partial<ControlCommandRequest> & Pick<ControlCommandRequest, "type" | "target">,
  ) => {
    const out = await control.bus.execute(actor, {
      idempotencyKey: randomUUID(),
      reason: "enforcement proof",
      expectedVersion: over.target.kind === "runtime" ? version.runtime : version.mission,
      ...over,
    });
    if (out.status === "EXECUTED") {
      if (over.target.kind === "runtime") version = { ...version, runtime: out.version! };
      else version = { ...version, mission: out.version! };
    }
    return out;
  };
  return { container, control, dispatcher, dispatched, supervisor, mission, tasksBefore, send };
}

/**
 * The memory container composes no human auth, so its own re-auth fails closed.
 * Proofs here come from a ReauthService over the SAME durable store with a
 * verifier that accepts: the bus still validates hash, binding, TTL, single use.
 */
async function proof(control: NonNullable<ReturnType<typeof buildMemoryContainer>["control"]>) {
  const r = await new ReauthService(control.store, { verifyPassword: async () => true }).issue({
    headers: new Headers(),
    userId: "u-owner",
    sessionId: "s-1",
    password: "x",
  });
  if (!r.ok) throw new Error("reauth");
  return r.proof;
}

describe("mission hold (PAUSE / RESUME)", () => {
  it("a held mission admits nothing and its ready work stays unfailed; resume restores admission", async () => {
    const t = await setup();
    const paused = await t.send({
      type: "PAUSE_MISSION",
      target: { kind: "mission", id: t.mission.id },
    });
    expect(paused.status).toBe("EXECUTED");

    await t.supervisor.run(t.mission.id);
    expect(t.dispatched).toEqual([]);
    const held = await t.container.mission.listTasks(t.mission.id);
    expect(held.map((x) => x.status)).toEqual(t.tasksBefore.map((x) => x.status));
    expect(held.some((x) => x.status === "failed")).toBe(false);

    const resumed = await t.send({
      type: "RESUME_MISSION",
      target: { kind: "mission", id: t.mission.id },
    });
    expect(resumed.status).toBe("EXECUTED");
    await t.supervisor.run(t.mission.id);
    expect(t.dispatched).toHaveLength(1);
  });

  it("PREPARED attempts of a held mission stay PREPARED during reconciliation", async () => {
    const t = await setup();
    const [task] = t.tasksBefore;
    await t.container.dispatchAttempts.prepare({
      missionId: t.mission.id,
      missionTaskId: task.id,
      taskId: task.taskId,
      attempt: 1,
      workflowId: `wf-${task.id}`,
      prompt: "p",
    });
    await t.send({ type: "PAUSE_MISSION", target: { kind: "mission", id: t.mission.id } });
    await t.supervisor.reconcilePreparedDispatches(t.mission.id);
    expect(t.dispatched).toEqual([]);
    expect(await t.container.dispatchAttempts.listPrepared(t.mission.id)).toHaveLength(1);
  });

  it("an unreadable hold/flag state blocks admission (fail closed)", async () => {
    const t = await setup();
    (t.control.store as InMemoryControlStore).failReads = true;
    await t.supervisor.run(t.mission.id);
    expect(t.dispatched).toEqual([]);
    expect(await t.control.guard.integration()).toEqual({
      allowed: false,
      reason: "CONTROL_STATE_UNAVAILABLE",
    });
    expect(await t.control.guard.externalAction()).toEqual({
      allowed: false,
      reason: "CONTROL_STATE_UNAVAILABLE",
    });
  });
});

describe("memory container re-auth", () => {
  it("fails closed without a composed auth gateway", async () => {
    const { control } = await setup();
    expect(
      await control.reauth.issue({
        headers: new Headers(),
        userId: "u-owner",
        sessionId: "s-1",
        password: "x",
      }),
    ).toEqual({ ok: false });
  });
});

describe("safe mode", () => {
  const runtime = { kind: "runtime", id: "global" } as const;

  it("blocks dispatch everywhere, and exit requires the governed CRITICAL command", async () => {
    const t = await setup();
    expect((await t.send({ type: "ENTER_SAFE_MODE", target: runtime })).status).toBe("EXECUTED");

    await t.supervisor.run(t.mission.id);
    expect(t.dispatched).toEqual([]);
    // Backstop: even a path with no admission guard cannot dispatch.
    await expect(
      t.container.taskExecution.dispatch({ taskId: "x", prompt: "p" }),
    ).rejects.toMatchObject({
      code: "CONTROL_HELD",
      reason: "SAFE_MODE",
    });

    // Without proof + typed confirmation, safe mode stays on.
    expect((await t.send({ type: "EXIT_SAFE_MODE", target: runtime })).rejection?.code).toBe(
      "REAUTH_REQUIRED",
    );
    expect((await t.control.guard.flags()).effective.safeMode).toBe(true);

    const exit = await t.send({
      type: "EXIT_SAFE_MODE",
      target: runtime,
      reauthProof: await proof(t.control),
      confirmation: confirmationPhrase("EXIT_SAFE_MODE", runtime),
    });
    expect(exit.status).toBe("EXECUTED");
    await t.supervisor.run(t.mission.id);
    expect(t.dispatched).toHaveLength(1);
  });

  it("refuses canonical integration and applier writes before touching the workspace", async () => {
    const t = await setup();
    await t.send({ type: "ENTER_SAFE_MODE", target: runtime });
    const get = vi.spyOn(t.container.workspaceManager!, "get");
    const lease = { owner: "o", fencingToken: 1 };
    await expect(
      t.container.integrationGate!.integrate("ws-1", { lease } as never),
    ).rejects.toMatchObject({
      code: "CONTROL_HELD",
      reason: "SAFE_MODE",
    });
    await expect(
      t.container.integrationApplier!.apply("ws-1", { lease } as never),
    ).rejects.toMatchObject({
      code: "CONTROL_HELD",
      reason: "SAFE_MODE",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("defers an orphan redispatch instead of dispatching or failing it", async () => {
    const t = await setup();
    await t.send({ type: "ENTER_SAFE_MODE", target: runtime });
    const actions = {
      wake: vi.fn(),
      reconcileDispatches: vi.fn(),
      redispatch: vi.fn(),
      recordLostExecution: vi.fn(),
      reclaimExpiredExecution: vi.fn(),
    };
    const ref = {
      id: "a1",
      missionId: t.mission.id,
      missionTaskId: "mt",
      taskId: "t",
      workflowId: "wf",
      attempt: 1,
    };
    const sweeper = new RuntimeRecoverySweeper(
      {} as never,
      {} as never,
      actions as never,
      { status: async () => "not_found" },
      {},
      t.control.guard,
    );
    const verdict = await (
      sweeper as unknown as { orphan(r: typeof ref): Promise<{ outcome: string; reason: string }> }
    ).orphan(ref);
    expect(verdict).toMatchObject({ outcome: "deferred", reason: "CONTROL_HELD" });
    expect(actions.redispatch).not.toHaveBeenCalled();
  });
});

describe("QC retry dispatch (production composition)", () => {
  it("a held retry is not dispatched and stays PREPARED", async () => {
    const t = await setup();
    const { composeAutonomyRuntime } = await import("@/server/system/production-services");
    const { qualityControl } = composeAutonomyRuntime(t.container);
    const dispatchPrepared = (
      qualityControl as unknown as { deps: { dispatchPrepared: (a: unknown) => Promise<void> } }
    ).deps.dispatchPrepared;
    const [task] = t.tasksBefore;
    const prepared = await t.container.dispatchAttempts.prepare({
      missionId: t.mission.id,
      missionTaskId: task.id,
      taskId: task.taskId,
      attempt: 2,
      workflowId: `wf-retry-${task.id}`,
      prompt: "retry",
    });
    await t.send({ type: "PAUSE_MISSION", target: { kind: "mission", id: t.mission.id } });
    const spy = vi.spyOn(t.container.taskExecution, "dispatch");
    await dispatchPrepared(prepared.attempt);
    expect(spy).not.toHaveBeenCalled();
    expect(
      (await t.container.dispatchAttempts.listPrepared(t.mission.id)).map((a) => a.workflowId),
    ).toContain(`wf-retry-${task.id}`);
  });
});

describe("cancel and workers go through canonical authorities", () => {
  it("cancel is compare-and-set and sticky: a late status write cannot undo it", async () => {
    const t = await setup();
    await t.container.mission.updateMissionStatus(t.mission.id, "running");
    const out = await t.send({
      type: "CANCEL_MISSION",
      target: { kind: "mission", id: t.mission.id },
      reauthProof: await proof(t.control),
    });
    expect(out.status).toBe("EXECUTED");
    await t.container.mission.updateMissionStatus(t.mission.id, "succeeded");
    expect((await t.container.mission.findById(t.mission.id))!.status).toBe("cancelled");
    await t.supervisor.run(t.mission.id);
    expect(t.dispatched).toEqual([]);
  });

  it("the real cancel effect never overwrites a status that changed after validation", async () => {
    const t = await setup();
    const effects = createControlEffects({
      missions: t.container.mission,
      tasks: t.container.tasks,
      workers: t.container.workerRegistryStore,
      registration: t.container.workerRegistration,
    });
    // The bus validated `running`, but the mission completed before the effect ran.
    await t.container.mission.updateMissionStatus(t.mission.id, "succeeded");
    expect(await effects.cancelMission(t.mission.id, "running")).toBe(false);
    expect((await t.container.mission.findById(t.mission.id))!.status).toBe("succeeded");
  });

  it("ENABLE_WORKER cannot route before a fresh successful probe", async () => {
    const t = await setup();
    const id = randomUUID();
    await t.container.workerRegistration.register({
      id,
      workerKind: "hermes",
      displayName: "w",
      runtime: "node",
      runtimeSupport: "SUPPORTED_RUNTIME",
    });
    await t.container.workerRegistration.probe(id, {
      health: "healthy",
      availability: "available",
    });
    expect(
      evaluateWorkerEligibility((await t.container.workerRegistryStore.get(id))!).reasons,
    ).toEqual([]);

    const w = { kind: "worker", id } as const;
    expect(
      (
        await t.control.bus.execute(actor, {
          idempotencyKey: randomUUID(),
          type: "DISABLE_WORKER",
          target: w,
          expectedVersion: 0,
          reason: "r",
        })
      ).status,
    ).toBe("EXECUTED");
    expect(
      evaluateWorkerEligibility((await t.container.workerRegistryStore.get(id))!).reasons,
    ).toContain("STATUS_NOT_ACTIVE");

    const enabled = await t.control.bus.execute(actor, {
      idempotencyKey: randomUUID(),
      type: "ENABLE_WORKER",
      target: w,
      expectedVersion: 1,
      reason: "r",
      reauthProof: await proof(t.control),
    });
    expect(enabled.status).toBe("EXECUTED");
    const after = evaluateWorkerEligibility((await t.container.workerRegistryStore.get(id))!);
    expect(after.reasons).toEqual(expect.arrayContaining(["HEALTH_NOT_HEALTHY", "NOT_AVAILABLE"]));
    expect(after.reasons).not.toContain("STATUS_NOT_ACTIVE");

    await t.container.workerRegistration.probe(id, {
      health: "healthy",
      availability: "available",
    });
    expect(
      evaluateWorkerEligibility((await t.container.workerRegistryStore.get(id))!).reasons,
    ).toEqual([]);
  });
});

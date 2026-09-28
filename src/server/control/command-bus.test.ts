import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { confirmationPhrase, type ControlCommandRequest } from "@/core/control/contracts";
import type { AuthenticatedSession, Role } from "@/core/identity";
import type { Mission } from "@/core/mission/contracts";

import { ControlCommandBus, deriveCommandId, type CommandActor } from "./command-bus";
import { InMemoryControlStore } from "./in-memory-control-store";
import type { ControlEffects } from "./ports";
import { ReauthService } from "./reauth";

const NOW = new Date("2026-09-28T12:00:00Z");
const WORKER_ID = "6f1c2a10-0000-4000-8000-000000000001";

function world() {
  const missions = new Map<string, Mission>([
    [
      "m1",
      { id: "m1", title: "M1", objective: "o", status: "running", createdAt: NOW, updatedAt: NOW },
    ],
    [
      "m-done",
      {
        id: "m-done",
        title: "Done",
        objective: "o",
        status: "succeeded",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  ]);
  const workers = new Map<string, WorkerRegistryEntry>([
    [
      WORKER_ID,
      {
        id: WORKER_ID,
        workerKind: "hermes",
        displayName: "w",
        capabilities: [],
        features: [],
        supportsTools: false,
        supportsStructuredOutput: false,
        status: "active",
        runtime: "node",
        runtimeSupport: "SUPPORTED_RUNTIME",
        health: "healthy",
        availability: "available",
        tags: [],
        metadata: {},
        lastProbeAt: NOW.toISOString(),
        lastProbeOutcome: "ok",
        maxConcurrency: 1,
        capacityPool: null,
        capacityPoolLimit: null,
        updatedAt: NOW.toISOString(),
      },
    ],
  ]);
  const outOfScope = new Set<string>();
  const effects: ControlEffects & { failNext?: boolean } = {
    readMission: async (id) => missions.get(id) ?? null,
    missionInScope: async (id) => !outOfScope.has(id),
    cancelMission: async (id, from) => {
      if (effects.failNext) {
        effects.failNext = false;
        throw new Error("connection lost");
      }
      const m = missions.get(id)!;
      if (m.status !== from) return false;
      missions.set(id, { ...m, status: "cancelled" });
      return true;
    },
    readWorker: async (id) => workers.get(id) ?? null,
    disableWorker: async (id) => void workers.set(id, { ...workers.get(id)!, status: "inactive" }),
    enableWorker: async (id) =>
      void workers.set(id, {
        ...workers.get(id)!,
        status: "active",
        health: "unknown",
        availability: "unknown",
        lastProbeOutcome: "never",
        lastProbeAt: null,
      }),
  };
  const store = new InMemoryControlStore();
  const now = { value: NOW };
  const bus = new ControlCommandBus({ store, effects, now: () => now.value });
  const reauth = new ReauthService(
    store,
    { verifyPassword: async (_h, p) => p === "correct horse" },
    () => now.value,
  );
  return { missions, workers, outOfScope, effects, store, bus, reauth, now };
}

function actor(roles: Role[] = ["owner"], issuedAgoMs = 60_000, userId = "u-owner"): CommandActor {
  const session: AuthenticatedSession = {
    user: { id: userId, email: `${userId}@icos.test`, status: "active" },
    roles,
  };
  return {
    session,
    sessionId: `s-${userId}`,
    sessionIssuedAt: new Date(NOW.getTime() - issuedAgoMs),
  };
}

const req = (
  over: Partial<ControlCommandRequest> & Pick<ControlCommandRequest, "type" | "target">,
): ControlCommandRequest => ({
  idempotencyKey: randomUUID(),
  expectedVersion: 0,
  reason: "operator decision",
  ...over,
});
const pause = (over: Partial<ControlCommandRequest> = {}) =>
  req({ type: "PAUSE_MISSION", target: { kind: "mission", id: "m1" }, ...over });

async function proofFor(w: ReturnType<typeof world>, a: CommandActor) {
  const r = await w.reauth.issue({
    headers: new Headers(),
    userId: a.session.user.id,
    sessionId: a.sessionId,
    password: "correct horse",
  });
  if (!r.ok) throw new Error("reauth failed");
  return r.proof;
}

describe("ControlCommandBus — authorization and validation", () => {
  it("rejects a caller without the permission and audits it", async () => {
    const w = world();
    const out = await w.bus.execute(actor(["viewer"]), pause());
    expect(out).toMatchObject({
      status: "REJECTED",
      rejection: { code: "FORBIDDEN" },
      version: null,
    });
    expect(w.store.audit.map((e) => e.eventType)).toEqual(["control.command.rejected"]);
    expect(await w.store.isHeld("m1")).toBe(false);
  });

  it("requires config.manage for runtime commands even for operators", async () => {
    const w = world();
    const out = await w.bus.execute(
      actor(["operator"]),
      req({ type: "ENTER_SAFE_MODE", target: { kind: "runtime", id: "global" } }),
    );
    expect(out.rejection?.code).toBe("FORBIDDEN");
  });

  it("treats an out-of-scope mission as not found", async () => {
    const w = world();
    w.outOfScope.add("m1");
    expect((await w.bus.execute(actor(["operator"]), pause())).rejection?.code).toBe(
      "TARGET_NOT_FOUND",
    );
  });

  it("refuses a target of the wrong kind", async () => {
    const w = world();
    const out = await w.bus.execute(
      actor(),
      req({ type: "PAUSE_MISSION", target: { kind: "worker", id: WORKER_ID } }),
    );
    expect(out.rejection?.code).toBe("TARGET_KIND_MISMATCH");
  });
});

describe("BR-11 state versions", () => {
  it("rejects a stale expectedVersion with a typed conflict and changes nothing", async () => {
    const w = world();
    expect((await w.bus.execute(actor(), pause())).status).toBe("EXECUTED");
    const stale = await w.bus.execute(
      actor(),
      req({ type: "RESUME_MISSION", target: { kind: "mission", id: "m1" }, expectedVersion: 0 }),
    );
    expect(stale).toMatchObject({
      status: "REJECTED",
      rejection: { code: "VERSION_CONFLICT" },
      version: 1,
    });
    expect(await w.store.isHeld("m1")).toBe(true);
  });

  it("lets exactly one of two concurrent commands on the same version win", async () => {
    const w = world();
    const [a, b] = await Promise.all([
      w.bus.execute(actor(), pause()),
      w.bus.execute(actor(), pause()),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["EXECUTED", "REJECTED"]);
    expect([a, b].find((r) => r.status === "REJECTED")!.rejection!.code).toBe("VERSION_CONFLICT");
    expect((await w.store.readVersions("mission", ["m1"])).get("m1")).toBe(1);
  });

  it("bumps the version on every admitted command", async () => {
    const w = world();
    await w.bus.execute(actor(), pause());
    const out = await w.bus.execute(
      actor(),
      req({ type: "RESUME_MISSION", target: { kind: "mission", id: "m1" }, expectedVersion: 1 }),
    );
    expect(out).toMatchObject({ status: "EXECUTED", version: 2 });
    expect(await w.store.isHeld("m1")).toBe(false);
  });
});

describe("idempotency", () => {
  it("derives a deterministic command id per actor + key", () => {
    const k = randomUUID();
    expect(deriveCommandId("u1", k)).toBe(deriveCommandId("u1", k));
    expect(deriveCommandId("u1", k)).not.toBe(deriveCommandId("u2", k));
  });

  it("replays the stored result for a duplicate request without re-executing", async () => {
    const w = world();
    const r = pause();
    const first = await w.bus.execute(actor(), r);
    const again = await w.bus.execute(actor(), r);
    expect(again).toMatchObject({ ...first, replayed: true });
    expect((await w.store.readVersions("mission", ["m1"])).get("m1")).toBe(1);
    expect(w.store.audit.length).toBe(1);
  });

  it("refuses the same key with a different payload and keeps the original", async () => {
    const w = world();
    const r = pause();
    await w.bus.execute(actor(), r);
    const other = await w.bus.execute(actor(), { ...r, reason: "something else" });
    expect(other).toMatchObject({
      status: "REJECTED",
      rejection: { code: "IDEMPOTENCY_KEY_REUSED" },
    });
    expect(w.store.audit.at(-1)!.eventType).toBe("control.command.rejected");
    expect((await w.store.getCommand(first(r)))!.status).toBe("EXECUTED");
  });
});
const first = (r: ControlCommandRequest) => deriveCommandId("u-owner", r.idempotencyKey);

describe("BR-18 authentication freshness", () => {
  const disable = () => req({ type: "DISABLE_WORKER", target: { kind: "worker", id: WORKER_ID } });
  const enable = (over: Partial<ControlCommandRequest> = {}) =>
    req({
      type: "ENABLE_WORKER",
      target: { kind: "worker", id: WORKER_ID },
      expectedVersion: 1,
      ...over,
    });

  it("MEDIUM requires a session younger than 12h", async () => {
    const w = world();
    const old = await w.bus.execute(actor(["owner"], 13 * 3600_000), disable());
    expect(old.rejection?.code).toBe("SESSION_TOO_OLD");
    expect((await w.bus.execute(actor(), disable())).status).toBe("EXECUTED");
  });

  it("HIGH requires a re-auth proof", async () => {
    const w = world();
    await w.bus.execute(actor(), disable());
    const out = await w.bus.execute(actor(), enable());
    expect(out).toMatchObject({ rejection: { code: "REAUTH_REQUIRED" }, reauth: "REQUIRED" });
  });

  it("rejects a wrong password, an expired proof, a foreign session's proof and a reused proof", async () => {
    const w = world();
    const a = actor();
    await w.bus.execute(a, disable());
    expect(
      (
        await w.reauth.issue({
          headers: new Headers(),
          userId: "u-owner",
          sessionId: a.sessionId,
          password: "nope",
        })
      ).ok,
    ).toBe(false);

    const expired = await proofFor(w, a);
    w.now.value = new Date(NOW.getTime() + 5 * 60_000 + 1);
    expect(
      (
        await w.bus.execute(
          { ...a, sessionIssuedAt: w.now.value },
          enable({ reauthProof: expired }),
        )
      ).rejection?.code,
    ).toBe("REAUTH_EXPIRED");
    w.now.value = NOW;

    const foreign = await proofFor(w, { ...a, sessionId: "another-session" });
    expect((await w.bus.execute(a, enable({ reauthProof: foreign }))).rejection?.code).toBe(
      "REAUTH_INVALID",
    );

    const good = await proofFor(w, a);
    expect((await w.bus.execute(a, enable({ reauthProof: good }))).status).toBe("EXECUTED");
    const reuse = await w.bus.execute(
      a,
      req({
        type: "DISABLE_WORKER",
        target: { kind: "worker", id: WORKER_ID },
        expectedVersion: 2,
      }),
    );
    expect(reuse.status).toBe("EXECUTED");
    expect(
      (await w.bus.execute(a, enable({ expectedVersion: 3, reauthProof: good }))).rejection?.code,
    ).toBe("REAUTH_INVALID");
  });

  it("CRITICAL requires re-auth AND the typed confirmation", async () => {
    const w = world();
    const a = actor();
    const rt = { kind: "runtime", id: "global" } as const;
    await w.bus.execute(a, req({ type: "ENTER_SAFE_MODE", target: rt }));
    const proof = await proofFor(w, a);
    const noConfirm = await w.bus.execute(
      a,
      req({ type: "EXIT_SAFE_MODE", target: rt, expectedVersion: 1, reauthProof: proof }),
    );
    expect(noConfirm).toMatchObject({
      rejection: { code: "CONFIRMATION_REQUIRED" },
      reauth: "SATISFIED",
    });
    // Rejection did not consume the proof: it can be used once, with the phrase.
    const ok = await w.bus.execute(
      a,
      req({
        type: "EXIT_SAFE_MODE",
        target: rt,
        expectedVersion: 1,
        reauthProof: proof,
        confirmation: confirmationPhrase("EXIT_SAFE_MODE", rt),
      }),
    );
    expect(ok.status).toBe("EXECUTED");
    expect((await w.store.readFlags()).safeMode).toBe(false);
  });

  it("never writes the proof, the password or the confirmation into the audit log", async () => {
    const w = world();
    const a = actor();
    await w.bus.execute(a, disable());
    const proof = await proofFor(w, a);
    await w.bus.execute(a, enable({ reauthProof: proof }));
    const dump = JSON.stringify(w.store.audit);
    expect(dump).not.toContain(proof);
    expect(dump).not.toContain("correct horse");
  });
});

describe("mission commands", () => {
  it("refuses to pause a terminal mission or pause twice", async () => {
    const w = world();
    expect(
      (
        await w.bus.execute(
          actor(),
          req({ type: "PAUSE_MISSION", target: { kind: "mission", id: "m-done" } }),
        )
      ).rejection?.code,
    ).toBe("INVALID_TRANSITION");
    await w.bus.execute(actor(), pause());
    expect((await w.bus.execute(actor(), pause({ expectedVersion: 1 }))).rejection?.code).toBe(
      "INVALID_TRANSITION",
    );
  });

  it("cancels through the canonical machine with compare-and-set", async () => {
    const w = world();
    const a = actor();
    const out = await w.bus.execute(
      a,
      req({
        type: "CANCEL_MISSION",
        target: { kind: "mission", id: "m1" },
        reauthProof: await proofFor(w, a),
      }),
    );
    expect(out).toMatchObject({ status: "EXECUTED", version: 1 });
    expect(w.missions.get("m1")!.status).toBe("cancelled");
    expect(w.store.audit.map((e) => e.eventType)).toEqual([
      "control.command.admitted",
      "control.command.executed",
    ]);
  });

  it("refuses to cancel a mission the machine does not allow", async () => {
    const w = world();
    const a = actor();
    const out = await w.bus.execute(
      a,
      req({
        type: "CANCEL_MISSION",
        target: { kind: "mission", id: "m-done" },
        reauthProof: await proofFor(w, a),
      }),
    );
    expect(out.rejection?.code).toBe("INVALID_TRANSITION");
  });

  it("reports FAILED, not success, when the mission changed state underneath", async () => {
    const w = world();
    const a = actor();
    const proof = await proofFor(w, a);
    const original = w.effects.cancelMission;
    w.effects.cancelMission = async (id, from) => {
      w.missions.set(id, { ...w.missions.get(id)!, status: "succeeded" });
      return original(id, from);
    };
    const out = await w.bus.execute(
      a,
      req({ type: "CANCEL_MISSION", target: { kind: "mission", id: "m1" }, reauthProof: proof }),
    );
    expect(out.status).toBe("FAILED");
    expect(w.missions.get("m1")!.status).toBe("succeeded");
  });
});

describe("worker commands", () => {
  it("ENABLE resets probe evidence so the worker cannot route before a fresh probe", async () => {
    const w = world();
    const a = actor();
    await w.bus.execute(
      a,
      req({ type: "DISABLE_WORKER", target: { kind: "worker", id: WORKER_ID } }),
    );
    expect(w.workers.get(WORKER_ID)!.status).toBe("inactive");
    await w.bus.execute(
      a,
      req({
        type: "ENABLE_WORKER",
        target: { kind: "worker", id: WORKER_ID },
        expectedVersion: 1,
        reauthProof: await proofFor(w, a),
      }),
    );
    expect(w.workers.get(WORKER_ID)).toMatchObject({
      status: "active",
      health: "unknown",
      lastProbeOutcome: "never",
      lastProbeAt: null,
    });
  });
});

describe("crash between admission and outcome (restart)", () => {
  it("reports UNKNOWN_EXECUTION_STATE, never retries implicitly, and reconciles from canonical state", async () => {
    const w = world();
    const a = actor();
    w.effects.failNext = true;
    const r = req({
      type: "CANCEL_MISSION",
      target: { kind: "mission", id: "m1" },
      reauthProof: await proofFor(w, a),
    });
    const out = await w.bus.execute(a, r);
    expect(out.status).toBe("UNKNOWN_EXECUTION_STATE");
    expect(w.missions.get("m1")!.status).toBe("running");

    // A new bus over the same durable store (= process restart).
    const restarted = new ControlCommandBus({ store: w.store, effects: w.effects, now: () => NOW });
    expect((await restarted.get(a.session, out.commandId))!.status).toBe("UNKNOWN_EXECUTION_STATE");
    // Replaying the same request does NOT execute it again.
    expect((await restarted.execute(a, r)).status).toBe("UNKNOWN_EXECUTION_STATE");
    expect(w.missions.get("m1")!.status).toBe("running");

    // Once canonical state shows the effect, reading the command settles it.
    w.missions.set("m1", { ...w.missions.get("m1")!, status: "cancelled" });
    const settled = await restarted.get(a.session, out.commandId);
    expect(settled).toMatchObject({ status: "EXECUTED", replayed: true });
    expect(w.store.audit.at(-1)!.eventType).toBe("control.command.executed");
  });

  it("does not show one actor's command to another non-admin", async () => {
    const w = world();
    const out = await w.bus.execute(actor(["owner"]), pause());
    expect(await w.bus.get(actor(["operator"], 0, "u-other").session, out.commandId)).toBeNull();
  });
});

describe("audit", () => {
  it("records every accepted and rejected authenticated attempt", async () => {
    const w = world();
    await w.bus.execute(actor(["viewer"]), pause());
    await w.bus.execute(actor(), pause());
    await w.bus.execute(actor(), pause());
    expect(w.store.audit.map((e) => e.eventType)).toEqual([
      "control.command.rejected",
      "control.command.executed",
      "control.command.rejected",
    ]);
    expect(w.store.audit.every((e) => e.actor.kind === "human")).toBe(true);
  });
});

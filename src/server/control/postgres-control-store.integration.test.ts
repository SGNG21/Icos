import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ControlCommandRequest } from "@/core/control/contracts";
import type { AuthenticatedSession } from "@/core/identity";
import type { Mission } from "@/core/mission/contracts";
import { user } from "@/server/database/auth-schema";
import { createDatabase } from "@/server/database/client";
import {
  auditEntries,
  controlCommands,
  missions,
  runtimeControlFlags,
} from "@/server/database/schema";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";

import { ControlCommandBus, type CommandActor } from "./command-bus";
import type { ControlEffects } from "./ports";
import { PostgresControlStore } from "./postgres-control-store";
import { ReauthService } from "./reauth";
import { RuntimeControlGuard } from "./runtime-control";

/**
 * Real PostgreSQL proofs for the control plane (decision 0044): row-lock
 * concurrency across two independent connection pools, restart durability,
 * audit atomicity and fail-closed reads.
 */
describe("PostgresControlStore (BR-10/11/12/18)", () => {
  const a = createDatabase(TEST_DATABASE_URL);
  const b = createDatabase(TEST_DATABASE_URL); // a second "process"
  const USER = "u-control-owner";
  const session: AuthenticatedSession = {
    user: { id: USER, email: "owner@icos.test", status: "active" },
    roles: ["owner"],
  };
  const actor: CommandActor = { session, sessionId: "sess-1", sessionIssuedAt: new Date() };

  const missionStatus = new Map<string, Mission["status"]>();
  const effects: ControlEffects = {
    readMission: async (id) => {
      const [row] = await a.db.select().from(missions).where(eq(missions.id, id));
      return row
        ? ({
            id: row.id,
            title: row.title,
            objective: "o",
            status: missionStatus.get(id) ?? "running",
            createdAt: new Date(),
            updatedAt: new Date(),
          } as Mission)
        : null;
    },
    missionInScope: async () => true,
    cancelMission: async (id, from) => {
      if ((missionStatus.get(id) ?? "running") !== from) return false;
      missionStatus.set(id, "cancelled");
      return true;
    },
    readWorker: async () => null,
    disableWorker: async () => {},
    enableWorker: async () => {},
  };

  const pause = (over: Partial<ControlCommandRequest> = {}): ControlCommandRequest => ({
    idempotencyKey: randomUUID(),
    type: "PAUSE_MISSION",
    target: { kind: "mission", id: "mission-ctl" },
    expectedVersion: 0,
    reason: "integration proof",
    ...over,
  });

  beforeAll(async () => {
    await a.db.select().from(missions).limit(1);
    await b.db.select().from(missions).limit(1);
  });

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  beforeEach(async () => {
    await a.db.execute(
      sql.raw(
        "TRUNCATE TABLE control_commands, control_state_versions, mission_control_holds, control_reauth_proofs RESTART IDENTITY CASCADE",
      ),
    );
    // audit_entries is append-only (trigger): assertions are scoped by command id instead.
    await a.db.execute(sql.raw("TRUNCATE TABLE missions RESTART IDENTITY CASCADE"));
    await a.db.execute(sql`DELETE FROM "user" WHERE id = ${USER}`);
    await a.db
      .insert(runtimeControlFlags)
      .values({
        id: "global",
        safeMode: false,
        dispatchEnabled: true,
        integrationEnabled: true,
        externalActionsEnabled: true,
      })
      .onConflictDoUpdate({
        target: runtimeControlFlags.id,
        set: {
          safeMode: false,
          dispatchEnabled: true,
          integrationEnabled: true,
          externalActionsEnabled: true,
        },
      });
    await a.db.insert(user).values({ id: USER, name: "Owner", email: "owner@icos.test" });
    const now = new Date();
    await a.db
      .insert(missions)
      .values({
        id: "mission-ctl",
        title: "Control",
        objective: "o",
        status: "running",
        createdAt: now,
        updatedAt: now,
      } as never);
    missionStatus.clear();
  });

  it("serializes conflicting commands from two independent connections: exactly one wins", async () => {
    const busA = new ControlCommandBus({ store: new PostgresControlStore(a.db), effects });
    const busB = new ControlCommandBus({ store: new PostgresControlStore(b.db), effects });
    const results = await Promise.all([busA.execute(actor, pause()), busB.execute(actor, pause())]);
    expect(results.map((r) => r.status).sort()).toEqual(["EXECUTED", "REJECTED"]);
    expect(results.find((r) => r.status === "REJECTED")!.rejection!.code).toBe("VERSION_CONFLICT");
    const rows = await a.db.select().from(controlCommands);
    expect(rows.map((r) => r.status).sort()).toEqual(["EXECUTED", "REJECTED"]);
  });

  it("dedupes the same command id racing on two connections", async () => {
    const r = pause();
    const [x, y] = await Promise.all([
      new ControlCommandBus({ store: new PostgresControlStore(a.db), effects }).execute(actor, r),
      new ControlCommandBus({ store: new PostgresControlStore(b.db), effects }).execute(actor, r),
    ]);
    expect(x.commandId).toBe(y.commandId);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    expect(await a.db.select().from(controlCommands)).toHaveLength(1);
    const audit = await a.db
      .select()
      .from(auditEntries)
      .where(sql`details->>'commandId' = ${x.commandId}`);
    expect(audit).toHaveLength(1);
  });

  it("persists holds, versions and results across a restart (new pool, new store, new bus)", async () => {
    const first = await new ControlCommandBus({
      store: new PostgresControlStore(a.db),
      effects,
    }).execute(actor, pause());
    expect(first.status).toBe("EXECUTED");

    const reborn = createDatabase(TEST_DATABASE_URL);
    try {
      const store = new PostgresControlStore(reborn.db);
      expect(await store.isHeld("mission-ctl")).toBe(true);
      expect((await store.readVersions("mission", ["mission-ctl"])).get("mission-ctl")).toBe(1);
      expect(await new RuntimeControlGuard(store).dispatch("mission-ctl")).toEqual({
        allowed: false,
        reason: "MISSION_HELD",
      });
      const bus = new ControlCommandBus({ store, effects });
      expect(await bus.get(session, first.commandId)).toMatchObject({
        status: "EXECUTED",
        replayed: true,
        version: 1,
      });
      const resumed = await bus.execute(
        actor,
        pause({ type: "RESUME_MISSION", expectedVersion: 1 }),
      );
      expect(resumed).toMatchObject({ status: "EXECUTED", version: 2 });
      expect(await store.isHeld("mission-ctl")).toBe(false);
    } finally {
      await reborn.close();
    }
  });

  it("writes the audit entry in the same transaction as the command record", async () => {
    const out = await new ControlCommandBus({
      store: new PostgresControlStore(a.db),
      effects,
    }).execute(actor, pause());
    const [row] = await a.db
      .select()
      .from(auditEntries)
      .where(eq(auditEntries.id, out.auditEntryId!));
    expect(row).toMatchObject({
      eventType: "control.command.executed",
      actorType: "human",
      actorLabel: USER,
    });
    expect(row.details).toMatchObject({ commandId: out.commandId, status: "EXECUTED", version: 1 });

    // A failure after the audit insert rolls BOTH back.
    const store = new PostgresControlStore(a.db);
    const rollbackId = `ctl-rollback-${randomUUID()}`;
    await expect(
      store.transaction("rollback-proof", async (tx) => {
        await tx.appendAudit({
          id: rollbackId,
          eventType: "control.command.rejected",
          actor: { kind: "human", id: USER },
          details: {},
          occurredAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(
      await a.db.select().from(auditEntries).where(eq(auditEntries.id, rollbackId)),
    ).toHaveLength(0);
  });

  it("consumes a re-auth proof exactly once, even under concurrency", async () => {
    const store = new PostgresControlStore(a.db);
    const reauth = new ReauthService(store, { verifyPassword: async () => true });
    const issued = await reauth.issue({
      headers: new Headers(),
      userId: USER,
      sessionId: actor.sessionId,
      password: "x",
    });
    if (!issued.ok) throw new Error("issue");
    const cancel = (key = randomUUID()): ControlCommandRequest => ({
      idempotencyKey: key,
      type: "CANCEL_MISSION",
      target: { kind: "mission", id: "mission-ctl" },
      expectedVersion: 0,
      reason: "integration proof",
      reauthProof: issued.proof,
    });
    const [x, y] = await Promise.all([
      new ControlCommandBus({ store, effects }).execute(actor, cancel()),
      new ControlCommandBus({ store: new PostgresControlStore(b.db), effects }).execute(
        actor,
        cancel(),
      ),
    ]);
    expect([x.status, y.status].sort()).toEqual(["EXECUTED", "REJECTED"]);
    const rows = await a.db.execute(sql`select token_hash, consumed_at from control_reauth_proofs`);
    expect(rows).toHaveLength(1);
    // Only the hash is stored, never the token.
    expect(JSON.stringify(rows)).not.toContain(issued.proof);
  });

  it("fails closed when the flags row is missing", async () => {
    await a.db.delete(runtimeControlFlags);
    const guard = new RuntimeControlGuard(new PostgresControlStore(a.db));
    expect(await guard.dispatch()).toEqual({ allowed: false, reason: "CONTROL_STATE_UNAVAILABLE" });
    expect(await guard.integration()).toEqual({
      allowed: false,
      reason: "CONTROL_STATE_UNAVAILABLE",
    });
    expect(await guard.externalAction()).toEqual({
      allowed: false,
      reason: "CONTROL_STATE_UNAVAILABLE",
    });
  });

  it("enters and leaves safe mode durably", async () => {
    const store = new PostgresControlStore(a.db);
    const bus = new ControlCommandBus({ store, effects });
    const on = await bus.execute(actor, {
      idempotencyKey: randomUUID(),
      type: "ENTER_SAFE_MODE",
      target: { kind: "runtime", id: "global" },
      expectedVersion: 0,
      reason: "incident",
    });
    expect(on.status).toBe("EXECUTED");
    const guard = new RuntimeControlGuard(new PostgresControlStore(b.db));
    expect(await guard.dispatch()).toEqual({ allowed: false, reason: "SAFE_MODE" });
    expect(await guard.integration()).toEqual({ allowed: false, reason: "SAFE_MODE" });
    const [flags] = await a.db.select().from(runtimeControlFlags);
    expect(flags).toMatchObject({ safeMode: true, updatedByCommandId: on.commandId });
  });
});

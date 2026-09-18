import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  sql,
} from "drizzle-orm";

import {
  createDatabase,
} from "@/server/database/client";

import {
  missions,
} from "@/server/database/schema";

import {
  PostgresAutonomousMissionRuntimeRepository,
} from "@/server/repositories/postgres/autonomous-mission-runtime-repository";

const DATABASE_URL =
  TEST_DATABASE_URL;

describe(
  "N2.7 durable autonomous runtime",
  () => {
    const handleA =
      createDatabase(DATABASE_URL);

    const handleB =
      createDatabase(DATABASE_URL);

    const handleC =
      createDatabase(DATABASE_URL);

    beforeAll(async () => {
      await handleA.db
        .select()
        .from(missions)
        .limit(1);

      await handleB.db
        .select()
        .from(missions)
        .limit(1);

      await handleC.db
        .select()
        .from(missions)
        .limit(1);
    });

    afterAll(async () => {
      await handleA.close();
      await handleB.close();
      await handleC.close();
    });

    beforeEach(async () => {
      await handleA.db.execute(
        sql.raw(
          "TRUNCATE TABLE missions, tasks " +
            "RESTART IDENTITY CASCADE",
        ),
      );

      const now =
        new Date(
          "2026-09-13T17:10:00.000Z",
        );

      await handleA.db
        .insert(missions)
        .values({
          id:
            "autonomous-runtime-mission",
          title:
            "Autonomous Runtime",
          objective:
            "Persist autonomous state",
          status: "draft",
          createdAt: now,
          updatedAt: now,
        });
    });

    it(
      "persists and restores runtime from a new repository process",
      async () => {
        const repoA =
          new PostgresAutonomousMissionRuntimeRepository(
            handleA.db,
          );

        const startedAt =
          new Date(
            "2026-09-13T17:10:00.000Z",
          );

        await repoA.create({
          missionId:
            "autonomous-runtime-mission",

          state: "running",

          startedAt,
          updatedAt: startedAt,

          lastHeartbeatAt:
            startedAt,

          lastProgressAt:
            startedAt,

          cycleCount: 0,
          replanCount: 0,
          stagnationCount: 0,

          maxCycles: 100,
          maxReplans: 5,
          maxRuntimeMs:
            3_600_000,
          maxStagnationCycles: 3,

          lastFingerprint:
            "initial",
          lastReason:
            "AUTONOMY_STARTED",
        });

        const repoB =
          new PostgresAutonomousMissionRuntimeRepository(
            handleB.db,
          );

        const restored =
          await repoB.get(
            "autonomous-runtime-mission",
          );

        expect(restored).not.toBeNull();

        expect(
          restored?.state,
        ).toBe("running");

        expect(
          restored?.cycleCount,
        ).toBe(0);

        expect(
          restored?.maxCycles,
        ).toBe(100);

        expect(
          restored?.lastFingerprint,
        ).toBe("initial");
      },
    );

    it(
      "persists heartbeat, progress counters and waiting state",
      async () => {
        const repo =
          new PostgresAutonomousMissionRuntimeRepository(
            handleA.db,
          );

        const startedAt =
          new Date(
            "2026-09-13T17:10:00.000Z",
          );

        await repo.create({
          missionId:
            "autonomous-runtime-mission",
          state: "running",

          startedAt,
          updatedAt: startedAt,

          lastHeartbeatAt:
            startedAt,

          lastProgressAt:
            startedAt,

          cycleCount: 0,
          replanCount: 0,
          stagnationCount: 0,

          maxCycles: 100,
          maxReplans: 5,
          maxRuntimeMs:
            3_600_000,
          maxStagnationCycles: 3,
        });

        const heartbeat =
          new Date(
            "2026-09-13T17:11:00.000Z",
          );

        const progress =
          new Date(
            "2026-09-13T17:10:30.000Z",
          );

        await repo.save({
          missionId:
            "autonomous-runtime-mission",

          state: "waiting",

          startedAt,
          updatedAt: heartbeat,

          lastHeartbeatAt:
            heartbeat,

          lastProgressAt:
            progress,

          cycleCount: 7,
          replanCount: 1,
          stagnationCount: 2,

          maxCycles: 100,
          maxReplans: 5,
          maxRuntimeMs:
            3_600_000,
          maxStagnationCycles: 3,

          lastFingerprint:
            "fp-7",

          lastReason:
            "AUTONOMY_EXTERNAL_WORK_PENDING",
        });

        const restored =
          await repo.get(
            "autonomous-runtime-mission",
          );

        expect(
          restored?.state,
        ).toBe("waiting");

        expect(
          restored?.cycleCount,
        ).toBe(7);

        expect(
          restored?.replanCount,
        ).toBe(1);

        expect(
          restored?.stagnationCount,
        ).toBe(2);

        expect(
          restored?.lastHeartbeatAt
            .toISOString(),
        ).toBe(
          heartbeat.toISOString(),
        );

        expect(
          restored?.lastProgressAt
            .toISOString(),
        ).toBe(
          progress.toISOString(),
        );
      },
    );

    it(
      "fails closed when save targets a missing runtime",
      async () => {
        const repo =
          new PostgresAutonomousMissionRuntimeRepository(
            handleA.db,
          );

        const now = new Date();

        await expect(
          repo.save({
            missionId:
              "missing-runtime",
            state: "running",

            startedAt: now,
            updatedAt: now,

            lastHeartbeatAt: now,
            lastProgressAt: now,

            cycleCount: 0,
            replanCount: 0,
            stagnationCount: 0,

            maxCycles: 1,
            maxReplans: 0,
            maxRuntimeMs: 1,
            maxStagnationCycles: 1,
          }),
        ).rejects.toThrow(
          "AUTONOMOUS_RUNTIME_NOT_FOUND",
        );
      },
    );

    it(
      "allows exactly one concurrent owner and supports lease-expiry takeover without stale release",
      async () => {
        const repoA =
          new PostgresAutonomousMissionRuntimeRepository(
            handleA.db,
          );

        const repoB =
          new PostgresAutonomousMissionRuntimeRepository(
            handleB.db,
          );

        const repoC =
          new PostgresAutonomousMissionRuntimeRepository(
            handleC.db,
          );

        const now =
          new Date(
            "2026-09-13T17:10:00.000Z",
          );

        await repoA.create({
          missionId:
            "autonomous-runtime-mission",
          state: "waiting",
          startedAt: now,
          updatedAt: now,
          lastHeartbeatAt: now,
          lastProgressAt: now,
          cycleCount: 0,
          replanCount: 0,
          stagnationCount: 0,
          maxCycles: 100,
          maxReplans: 5,
          maxRuntimeMs:
            3_600_000,
          maxStagnationCycles: 3,
          lastReason:
            "AUTONOMY_EXTERNAL_WORK_PENDING",
        });

        const owners = [
          {
            name: "owner-a",
            repo: repoA,
          },
          {
            name: "owner-b",
            repo: repoB,
          },
          {
            name: "owner-c",
            repo: repoC,
          },
        ];

        const concurrent =
          await Promise.all(
            owners.map(
              async ({ name, repo }) => ({
                name,
                claimed:
                  await repo.claim(
                    "autonomous-runtime-mission",
                    name,
                    5_000,
                  ),
              }),
            ),
          );

        const winners =
          concurrent.filter(
            (entry) =>
              entry.claimed,
          );

        expect(
          winners,
        ).toHaveLength(1);

        const winner =
          winners[0];

        const winnerRepo =
          owners.find(
            (entry) =>
              entry.name ===
              winner.name,
          )?.repo;

        expect(
          winnerRepo,
        ).toBeDefined();

        await winnerRepo!.release(
          "autonomous-runtime-mission",
          winner.name,
        );

        // Fresh short lease owned by A.
        expect(
          await repoA.claim(
            "autonomous-runtime-mission",
            "lease-owner-a",
            120,
          ),
        ).toBe(true);

        // B cannot steal an active lease.
        expect(
          await repoB.claim(
            "autonomous-runtime-mission",
            "lease-owner-b",
            5_000,
          ),
        ).toBe(false);

        // Let A expire.
        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              200,
            ),
        );

        // B can take over after expiry.
        expect(
          await repoB.claim(
            "autonomous-runtime-mission",
            "lease-owner-b",
            5_000,
          ),
        ).toBe(true);

        // Stale A must not release B's lease.
        await repoA.release(
          "autonomous-runtime-mission",
          "lease-owner-a",
        );

        // C must still be unable to claim,
        // proving B retained ownership.
        expect(
          await repoC.claim(
            "autonomous-runtime-mission",
            "lease-owner-c",
            5_000,
          ),
        ).toBe(false);
      },
    );


    it(
      "rejects stale owner save after lease takeover",
      async () => {
        const repoA =
          new PostgresAutonomousMissionRuntimeRepository(
            handleA.db,
          );

        const repoB =
          new PostgresAutonomousMissionRuntimeRepository(
            handleB.db,
          );

        const startedAt =
          new Date(
            "2026-09-13T17:10:00.000Z",
          );

        await repoA.create({
          missionId:
            "autonomous-runtime-mission",
          state: "waiting",
          startedAt,
          updatedAt: startedAt,
          lastHeartbeatAt:
            startedAt,
          lastProgressAt:
            startedAt,
          cycleCount: 0,
          replanCount: 0,
          stagnationCount: 0,
          maxCycles: 100,
          maxReplans: 5,
          maxRuntimeMs:
            3_600_000,
          maxStagnationCycles: 3,
        });

        expect(
          await repoA.claim(
            "autonomous-runtime-mission",
            "owner-a",
            120,
          ),
        ).toBe(true);

        const staleRuntime =
          await repoA.get(
            "autonomous-runtime-mission",
          );

        expect(
          staleRuntime,
        ).not.toBeNull();

        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              200,
            ),
        );

        expect(
          await repoB.claim(
            "autonomous-runtime-mission",
            "owner-b",
            5_000,
          ),
        ).toBe(true);

        const freshRuntime =
          await repoB.get(
            "autonomous-runtime-mission",
          );

        expect(
          freshRuntime,
        ).not.toBeNull();

        await repoB.saveOwned(
          {
            ...freshRuntime!,
            state: "running",
            cycleCount: 10,
            updatedAt:
              new Date(),
            lastHeartbeatAt:
              new Date(),
          },
          "owner-b",
        );

        await expect(
          repoA.saveOwned(
            {
              ...staleRuntime!,
              state: "failed",
              cycleCount: 999,
              updatedAt:
                new Date(),
              lastHeartbeatAt:
                new Date(),
            },
            "owner-a",
          ),
        ).rejects.toThrow(
          "AUTONOMOUS_RUNTIME_OWNERSHIP_LOST",
        );

        const finalRuntime =
          await repoB.get(
            "autonomous-runtime-mission",
          );

        expect(
          finalRuntime?.state,
        ).toBe("running");

        expect(
          finalRuntime?.cycleCount,
        ).toBe(10);
      },
    );


    it(
      "lists only abandoned running or replanning runtimes as recoverable",
      async () => {
        const repository =
          new PostgresAutonomousMissionRuntimeRepository(
            handleA.db,
          );

        const base =
          new Date(
            "2026-09-13T18:40:00.000Z",
          );

        const old =
          new Date(
            base.getTime() -
              60_000,
          );

        const future =
          new Date(
            Date.now() +
              60_000,
          );

        const expired =
          new Date(
            Date.now() -
              60_000,
          );

        const missionIds = [
          "recover-running-expired",
          "recover-running-owner-null",
          "recover-replanning-expired",
          "ignore-running-active",
          "ignore-waiting-null",
          "ignore-waiting-expired",
          "ignore-succeeded",
          "ignore-failed",
          "ignore-blocked",
          "ignore-cancelled",
          "ignore-escalated",
        ];

        for (
          const missionId
          of missionIds
        ) {
          await handleA.db
            .insert(missions)
            .values({
              id: missionId,
              title: missionId,
              objective: missionId,
              status: "draft",
              createdAt: base,
              updatedAt: base,
            });
        }

        const createRuntime = async (
          missionId: string,
          state:
            | "running"
            | "waiting"
            | "replanning"
            | "succeeded"
            | "failed"
            | "blocked"
            | "cancelled"
            | "escalated",
          ownerToken:
            string | null,
          leaseUntil:
            Date | null,
          heartbeat:
            Date = old,
        ) => {
          await repository.create({
            missionId,
            state,
            startedAt: base,
            updatedAt: heartbeat,
            lastHeartbeatAt:
              heartbeat,
            lastProgressAt:
              heartbeat,
            cycleCount: 1,
            replanCount: 0,
            stagnationCount: 0,
            maxCycles: 10,
            maxReplans: 5,
            maxRuntimeMs:
              3_600_000,
            maxStagnationCycles: 3,
            lastReason:
              "RECOVERY_SELECTION_TEST",
            ownerToken,
            leaseUntil,
          });
        };

        await createRuntime(
          "recover-running-expired",
          "running",
          "dead-owner",
          expired,
          new Date(
            old.getTime() -
              30_000,
          ),
        );

        await createRuntime(
          "recover-running-owner-null",
          "running",
          null,
          future,
          new Date(
            old.getTime() -
              20_000,
          ),
        );

        await createRuntime(
          "recover-replanning-expired",
          "replanning",
          "dead-replanner",
          expired,
          new Date(
            old.getTime() -
              10_000,
          ),
        );

        await createRuntime(
          "ignore-running-active",
          "running",
          "live-owner",
          future,
        );

        await createRuntime(
          "ignore-waiting-null",
          "waiting",
          null,
          null,
        );

        await createRuntime(
          "ignore-waiting-expired",
          "waiting",
          "waiting-owner",
          expired,
        );

        await createRuntime(
          "ignore-succeeded",
          "succeeded",
          null,
          null,
        );

        await createRuntime(
          "ignore-failed",
          "failed",
          null,
          null,
        );

        await createRuntime(
          "ignore-blocked",
          "blocked",
          null,
          null,
        );

        await createRuntime(
          "ignore-cancelled",
          "cancelled",
          null,
          null,
        );

        await createRuntime(
          "ignore-escalated",
          "escalated",
          null,
          null,
        );

        const recoverable =
          await repository
            .listRecoverable();

        expect(
          recoverable.map(
            (runtime) =>
              runtime.missionId,
          ),
        ).toEqual([
          "recover-running-expired",
          "recover-running-owner-null",
          "recover-replanning-expired",
        ]);

        expect(
          recoverable.every(
            (runtime) =>
              runtime.state ===
                "running" ||
              runtime.state ===
                "replanning",
          ),
        ).toBe(true);

        const limited =
          await repository
            .listRecoverable(2);

        expect(
          limited,
        ).toHaveLength(2);

        await expect(
          repository
            .listRecoverable(0),
        ).rejects.toThrow(
          "AUTONOMOUS_RUNTIME_INVALID_RECOVERY_LIMIT",
        );
    });

    it("renews lease for valid owner and updates leaseUntil using database time", async () => {
      const repoA = new PostgresAutonomousMissionRuntimeRepository(handleA.db);
      const repoB = new PostgresAutonomousMissionRuntimeRepository(handleB.db);

      const now = new Date("2026-09-13T17:10:00.000Z");
      await repoA.create({
        missionId: "autonomous-runtime-mission",
        state: "running",
        startedAt: now,
        updatedAt: now,
        lastHeartbeatAt: now,
        lastProgressAt: now,
        cycleCount: 0,
        replanCount: 0,
        stagnationCount: 0,
        maxCycles: 100,
        maxReplans: 5,
        maxRuntimeMs: 3_600_000,
        maxStagnationCycles: 3,
        lastReason: "AUTONOMY_STARTED",
        ownerToken: null,
        leaseUntil: null,
      });

      // Claim ownership with token A and a short lease
      const tokenA = "token-a";
      const leaseMs = 100; // 100 ms
      const claimed = await repoA.claim("autonomous-runtime-mission", tokenA, leaseMs);
      expect(claimed).toBe(true);

      const runtimeAfterClaim = await repoA.get("autonomous-runtime-mission");
      expect(runtimeAfterClaim).not.toBeNull();
      const leaseUntilAfterClaim = runtimeAfterClaim!.leaseUntil!;

      // Wait a bit but not exceed lease (e.g., 50 ms)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Renew claim with same token
      const renewed = await repoA.renewClaim("autonomous-runtime-mission", tokenA, leaseMs);
      expect(renewed).toBe(true);

      const runtimeAfterRenew = await repoA.get("autonomous-runtime-mission");
      expect(runtimeAfterRenew).not.toBeNull();
      const leaseUntilAfterRenew = runtimeAfterRenew!.leaseUntil!;
      // leaseUntil should have increased (by approximately leaseMs, using DB time)
      expect(leaseUntilAfterRenew.getTime()).toBeGreaterThan(leaseUntilAfterClaim.getTime());

      // Renewal is based on current PostgreSQL DB time.
      // Because renewal happens part-way through the original lease,
      // the new leaseUntil should move forward by approximately the
      // elapsed time since the original claim, not by a full leaseMs.
      const extension =
        leaseUntilAfterRenew.getTime() -
        leaseUntilAfterClaim.getTime();

      expect(extension).toBeGreaterThan(0);
      expect(extension).toBeLessThan(leaseMs);

      // Wrong owner cannot renew
      const tokenB = "token-b";
      const renewedByWrong = await repoA.renewClaim("autonomous-runtime-mission", tokenB, leaseMs);
      expect(renewedByWrong).toBe(false);

      // Let lease expire
      await new Promise((resolve) => setTimeout(resolve, leaseMs + 20));

      // Expired owner cannot renew
      const renewedExpired = await repoA.renewClaim("autonomous-runtime-mission", tokenA, leaseMs);
      expect(renewedExpired).toBe(false);

      // Stale owner after takeover: B claims after expiry
      const claimedByB = await repoB.claim("autonomous-runtime-mission", tokenB, leaseMs);
      expect(claimedByB).toBe(true);

      // A's renewal attempt after B took over should fail
      const renewedAfterTakeover = await repoA.renewClaim("autonomous-runtime-mission", tokenA, leaseMs);
      expect(renewedAfterTakeover).toBe(false);

      // New owner can still take over after abandonment (i.e., after B's lease expires, C can claim)
      await new Promise((resolve) => setTimeout(resolve, leaseMs + 20));
      const repoC = new PostgresAutonomousMissionRuntimeRepository(handleC.db);
      const tokenC = "token-c";
      const claimedByC = await repoC.claim("autonomous-runtime-mission", tokenC, leaseMs);
      expect(claimedByC).toBe(true);

      // Stale saveOwned remains rejected (sanity)
      const staleRuntime = await repoA.get("autonomous-runtime-mission");
      expect(staleRuntime).not.toBeNull();
      await expect(
        repoA.saveOwned(
          {
            ...staleRuntime!,
            state: "failed",
            cycleCount: 999,
            updatedAt: new Date(),
            lastHeartbeatAt: new Date(),
          },
          tokenA,
        )
      ).rejects.toThrow("AUTONOMOUS_RUNTIME_OWNERSHIP_LOST");
    });
  });

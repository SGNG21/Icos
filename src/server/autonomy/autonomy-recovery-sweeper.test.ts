import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  AutonomyRecoverySweeper,
} from "@/server/autonomy/autonomy-recovery-sweeper";

import type {
  AutonomousMissionRuntime,
} from "@/server/autonomy/runtime";

function runtime(
  missionId: string,
): AutonomousMissionRuntime {
  const now =
    new Date(
      "2026-09-13T19:00:00.000Z",
    );

  return {
    missionId,
    state: "running",
    startedAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
    lastProgressAt: now,
    cycleCount: 1,
    replanCount: 0,
    stagnationCount: 0,
    maxCycles: 10,
    maxReplans: 5,
    maxRuntimeMs:
      3_600_000,
    maxStagnationCycles: 3,
    lastReason:
      "AUTONOMY_RECOVERY_TEST",
    ownerToken: null,
    leaseUntil: null,
  };
}

describe(
  "N2.7 autonomy recovery sweeper",
  () => {
    it(
      "wakes every recoverable runtime",
      async () => {
        const listRecoverable =
          vi.fn()
            .mockResolvedValue([
              runtime("mission-a"),
              runtime("mission-b"),
            ]);

        const wake =
          vi.fn()
            .mockResolvedValue(
              undefined,
            );

        const sweeper =
          new AutonomyRecoverySweeper(
            {
              listRecoverable,
            },
            {
              wake,
            },
          );

        const result =
          await sweeper.sweep(25);

        expect(
          listRecoverable,
        ).toHaveBeenCalledTimes(1);

        expect(
          listRecoverable,
        ).toHaveBeenCalledWith(25);

        expect(
          wake,
        ).toHaveBeenCalledTimes(2);

        expect(
          wake,
        ).toHaveBeenNthCalledWith(
          1,
          "mission-a",
        );

        expect(
          wake,
        ).toHaveBeenNthCalledWith(
          2,
          "mission-b",
        );

        expect(
          result,
        ).toEqual({
          discovered: 2,
          attempted: 2,
          succeeded: 2,
          failed: 0,
          failures: [],
        });
      },
    );

    it(
      "isolates one wake failure and continues with later missions",
      async () => {
        const listRecoverable =
          vi.fn()
            .mockResolvedValue([
              runtime("mission-a"),
              runtime("mission-b"),
              runtime("mission-c"),
            ]);

        const failure =
          new Error(
            "RECOVERY_WAKE_FAILED",
          );

        const wake =
          vi.fn()
            .mockImplementation(
              async (
                missionId: string,
              ) => {
                if (
                  missionId ===
                  "mission-b"
                ) {
                  throw failure;
                }
              },
            );

        const sweeper =
          new AutonomyRecoverySweeper(
            {
              listRecoverable,
            },
            {
              wake,
            },
          );

        const result =
          await sweeper.sweep();

        expect(
          wake,
        ).toHaveBeenCalledTimes(3);

        expect(
          wake,
        ).toHaveBeenNthCalledWith(
          3,
          "mission-c",
        );

        expect(
          result.discovered,
        ).toBe(3);

        expect(
          result.attempted,
        ).toBe(3);

        expect(
          result.succeeded,
        ).toBe(2);

        expect(
          result.failed,
        ).toBe(1);

        expect(
          result.failures,
        ).toEqual([
          {
            missionId:
              "mission-b",
            error:
              failure,
          },
        ]);
      },
    );

    it(
      "does nothing when no runtime is recoverable",
      async () => {
        const listRecoverable =
          vi.fn()
            .mockResolvedValue(
              [],
            );

        const wake =
          vi.fn();

        const sweeper =
          new AutonomyRecoverySweeper(
            {
              listRecoverable,
            },
            {
              wake,
            },
          );

        const result =
          await sweeper.sweep();

        expect(
          wake,
        ).not.toHaveBeenCalled();

        expect(
          result,
        ).toEqual({
          discovered: 0,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          failures: [],
        });
      },
    );

    it(
      "fails closed when candidate discovery fails",
      async () => {
        const listRecoverable =
          vi.fn()
            .mockRejectedValue(
              new Error(
                "RECOVERY_DISCOVERY_FAILED",
              ),
            );

        const wake =
          vi.fn();

        const sweeper =
          new AutonomyRecoverySweeper(
            {
              listRecoverable,
            },
            {
              wake,
            },
          );

        await expect(
          sweeper.sweep(),
        ).rejects.toThrow(
          "RECOVERY_DISCOVERY_FAILED",
        );

        expect(
          wake,
        ).not.toHaveBeenCalled();
      },
    );
  },
);

import { describe, expect, it } from "vitest";

import { sweepAll } from "@/server/recovery/sweep-all";

const ok = (n: number) => ({
  async sweep() {
    return { discovered: n, attempted: n, succeeded: n, failed: 0, failures: [] };
  },
});

describe("sweepAll", () => {
  it("aggregates results and isolates a throwing sweeper under its own name", async () => {
    const boom = {
      async sweep(): Promise<never> {
        throw new Error("BOOM");
      },
    };
    const result = await sweepAll([
      ["a", ok(1)],
      ["runtime-recovery", boom],
      ["c", ok(2)],
    ]).sweep();

    expect(result).toMatchObject({ discovered: 3, attempted: 3, succeeded: 3, failed: 1 });
    expect(result.failures).toEqual([{ missionId: "runtime-recovery", error: expect.any(Error) }]);
  });
});

import { describe, expect, it, vi } from "vitest";

import { createSelfDevelopmentScheduler } from "./production-services";
import type { GovernedSelfDevelopmentCoordinator } from "@/server/autonomy/governed-self-development-coordinator";

const coordinator = (advance: () => Promise<unknown>) =>
  ({ advance }) as unknown as GovernedSelfDevelopmentCoordinator;

describe("self-development runs on its own timer", () => {
  it("never starts a second advance while one is in flight", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const advance = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const scheduler = createSelfDevelopmentScheduler(coordinator(advance), 1_000);
    scheduler.start();

    // Trois ticks pendant qu'une avancée est bloquée : une seule doit avoir démarré.
    await vi.advanceTimersByTimeAsync(3_500);
    expect(advance).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(advance).toHaveBeenCalledTimes(2);

    await scheduler.stop();
    vi.useRealTimers();
  });

  it("stop() does not wait for an advance that may run for an hour", async () => {
    vi.useFakeTimers();
    /* Une avancée qui ne se résout jamais : stop() doit malgré tout rendre la main. */
    const scheduler = createSelfDevelopmentScheduler(
      coordinator(() => new Promise<unknown>(() => {})),
      1_000,
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(scheduler.stop()).resolves.toBeUndefined();

    vi.useRealTimers();
  });

  it("a failing advance never stops later ticks", async () => {
    vi.useFakeTimers();
    const advance = vi
      .fn()
      .mockRejectedValueOnce(new Error("PLANNER_DOWN"))
      .mockResolvedValue(undefined);
    const scheduler = createSelfDevelopmentScheduler(coordinator(advance), 1_000);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(advance).toHaveBeenCalledTimes(2);

    await scheduler.stop();
    vi.useRealTimers();
  });

  it("stops ticking after stop()", async () => {
    vi.useFakeTimers();
    const advance = vi.fn().mockResolvedValue(undefined);
    const scheduler = createSelfDevelopmentScheduler(coordinator(advance), 1_000);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(advance).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

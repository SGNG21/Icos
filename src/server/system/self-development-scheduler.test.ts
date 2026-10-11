import { describe, expect, it, vi } from "vitest";

import { createSelfDevelopmentScheduler } from "./production-services";
import type { GovernedSelfDevelopmentCoordinator } from "@/server/autonomy/governed-self-development-coordinator";

const coordinator = (advance: () => Promise<unknown>) =>
  ({ advance }) as unknown as GovernedSelfDevelopmentCoordinator;

describe("self-development runs on its own timer", () => {
  it("starts nothing — no detection, no advance — while no worker is routable", async () => {
    vi.useFakeTimers();
    const advance = vi.fn(async () => undefined);
    const maybePropose = vi.fn(async () => undefined);
    let routable = false;
    const scheduler = createSelfDevelopmentScheduler(
      coordinator(advance),
      1_000,
      { maybePropose } as never,
      async () => routable,
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(maybePropose).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();

    routable = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(maybePropose).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledTimes(1);
    await scheduler.stop();
    vi.useRealTimers();
  });

  it("an unreadable fleet counts as not ready (fail closed)", async () => {
    vi.useFakeTimers();
    const advance = vi.fn(async () => undefined);
    const scheduler = createSelfDevelopmentScheduler(coordinator(advance), 1_000, undefined, () =>
      Promise.reject(new Error("db down")),
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(advance).not.toHaveBeenCalled();
    await scheduler.stop();
    vi.useRealTimers();
  });

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

  it("DETECTS BEFORE IT ADVANCES, inside the same in-flight guard (decision 0076)", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let release!: () => void;
    const maybePropose = vi.fn(
      () =>
        new Promise<never>((resolve) => {
          order.push("detect");
          release = () => resolve(undefined as never);
        }),
    );
    const advance = vi.fn(async () => {
      order.push("advance");
    });
    const scheduler = createSelfDevelopmentScheduler(coordinator(advance), 1_000, { maybePropose });
    scheduler.start();

    /* A slow detection blocks the tick: no second detection, no advance overlapping it. */
    await vi.advanceTimersByTimeAsync(3_500);
    expect(maybePropose).toHaveBeenCalledTimes(1);
    expect(advance).not.toHaveBeenCalled();

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["detect", "advance"]);

    await scheduler.stop();
    vi.useRealTimers();
  });

  it("a failing detection still advances what the backlog already holds", async () => {
    vi.useFakeTimers();
    const advance = vi.fn().mockResolvedValue(undefined);
    const scheduler = createSelfDevelopmentScheduler(coordinator(advance), 1_000, {
      maybePropose: vi.fn().mockRejectedValue(new Error("QUALITY_PROBE_TIMEOUT")),
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(advance).toHaveBeenCalledTimes(1);
    await scheduler.stop();
    vi.useRealTimers();
  });
});

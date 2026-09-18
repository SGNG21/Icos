import { describe, expect, it, vi } from "vitest";

import type { Env } from "@/config/env";
import type { Container } from "@/server/container";
import { startProductionServices } from "@/server/system/production-services";

function env(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "production",
    PERSISTENCE: "postgres",
    DATABASE_URL: "postgres://localhost/icos",
    AUTONOMY_RECOVERY_INTERVAL_MS: 5_000,
    ...overrides,
  };
}

describe("production services bootstrap", () => {
  const signals = {
    onSignal: vi.fn(),
    removeSignal: vi.fn(),
    exit: vi.fn(),
  };

  it("starts PostgreSQL recovery scheduling and stops it before the container", async () => {
    const start = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const schedulerFactory = vi.fn().mockReturnValue({ start, stop });
    const container = {
      autonomousRuntime: {},
      close,
    } as unknown as Container;

    const services = await startProductionServices({
      env: env(),
      createContainer: vi.fn().mockResolvedValue(container),
      schedulerFactory,
      signals,
    });

    expect(schedulerFactory).toHaveBeenCalledTimes(1);
    expect(schedulerFactory).toHaveBeenCalledWith(container, {
      intervalMs: 5_000,
    });
    expect(start).toHaveBeenCalledTimes(1);

    await services.stop();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);

    await services.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("fails closed and closes the container if scheduler startup fails", async () => {
    const failure = new Error("SCHEDULER_START_FAILED");
    const close = vi.fn().mockResolvedValue(undefined);
    const container = {
      autonomousRuntime: {},
      close,
    } as unknown as Container;

    await expect(
      startProductionServices({
        env: env(),
        createContainer: vi.fn().mockResolvedValue(container),
        schedulerFactory: vi.fn().mockReturnValue({
          start: vi.fn(() => {
            throw failure;
          }),
          stop: vi.fn(),
        }),
        signals,
      }),
    ).rejects.toBe(failure);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not start durable recovery outside PostgreSQL production", async () => {
    const schedulerFactory = vi.fn();
    const memoryContainer = {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Container;
    const developmentContainer = {
      autonomousRuntime: {},
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Container;

    const memoryServices = await startProductionServices({
      env: env({ NODE_ENV: "development", PERSISTENCE: "memory" }),
      createContainer: vi.fn().mockResolvedValue(memoryContainer),
      schedulerFactory,
      signals,
    });
    const developmentServices = await startProductionServices({
      env: env({ NODE_ENV: "development" }),
      createContainer: vi.fn().mockResolvedValue(developmentContainer),
      schedulerFactory,
      signals,
    });

    expect(schedulerFactory).not.toHaveBeenCalled();

    await memoryServices.stop();
    await developmentServices.stop();
  });

  it("fails closed if production PostgreSQL composition lacks a durable runtime", async () => {
    const close = vi.fn().mockResolvedValue(undefined);

    await expect(
      startProductionServices({
        env: env(),
        createContainer: vi.fn().mockResolvedValue({ close } as unknown as Container),
        schedulerFactory: vi.fn(),
        signals,
      }),
    ).rejects.toThrow("AUTONOMY_RECOVERY_RUNTIME_UNAVAILABLE");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stops on a process signal and removes both shutdown handlers", async () => {
    const start = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const testSignals = {
      onSignal: vi.fn(),
      removeSignal: vi.fn(),
      exit: vi.fn(),
    };
    const services = await startProductionServices({
      env: env(),
      createContainer: vi.fn().mockResolvedValue({
        autonomousRuntime: {},
        close,
      } as unknown as Container),
      schedulerFactory: vi.fn().mockReturnValue({ start, stop }),
      signals: testSignals,
    });
    const handlers = new Map(
      testSignals.onSignal.mock.calls as Array<["SIGINT" | "SIGTERM", () => void]>,
    );

    handlers.get("SIGTERM")?.();
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(testSignals.exit).toHaveBeenCalledWith(143);
    });

    expect(testSignals.removeSignal).toHaveBeenCalledTimes(2);

    await services.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

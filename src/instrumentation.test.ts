import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@/config/env";
import type { Container } from "@/server/container";
import type {
  ProductionServices,
  ProductionServiceSignals,
  StartProductionServicesOptions,
} from "@/server/system/production-services";

const PRODUCTION_SERVICES_KEY = "__icosProductionServicesPromise__";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function env(): Env {
  return {
    NODE_ENV: "production",
    PERSISTENCE: "postgres",
    DATABASE_URL: "postgres://localhost/icos",
    AUTONOMY_RECOVERY_INTERVAL_MS: 5_000,
  };
}

function clearProductionServices(): void {
  delete (globalThis as Record<string, unknown>)[PRODUCTION_SERVICES_KEY];
}

function retainedProductionServices(): Promise<ProductionServices> | undefined {
  return (globalThis as Record<string, unknown>)[PRODUCTION_SERVICES_KEY] as
    Promise<ProductionServices> | undefined;
}

describe("Next.js server instrumentation", () => {
  const originalRuntime = process.env.NEXT_RUNTIME;

  afterEach(() => {
    vi.resetModules();
    clearProductionServices();

    if (originalRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = originalRuntime;
    }
  });

  it("owns one lifecycle-managed production service through startup and shutdown", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const schedulerStop = deferred<void>();
    const events: string[] = [];
    const start = vi.fn(() => {
      events.push("scheduler:start");
    });
    const stop = vi.fn(async () => {
      events.push("scheduler:stop:start");
      await schedulerStop.promise;
      events.push("scheduler:stop:end");
    });
    const close = vi.fn(async () => {
      events.push("container:close");
    });
    const createContainer = vi.fn().mockResolvedValue({
      autonomousRuntime: {},
      close,
    } as unknown as Container);
    const schedulerFactory = vi.fn().mockReturnValue({ start, stop });
    const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
    const exit = vi.fn((code: number) => {
      events.push(`process:exit:${code}`);
    });
    const signals: ProductionServiceSignals = {
      onSignal: (signal, listener) => {
        signalHandlers.set(signal, listener);
      },
      removeSignal: (signal, listener) => {
        if (signalHandlers.get(signal) === listener) {
          signalHandlers.delete(signal);
        }
      },
      exit,
    };
    const options: StartProductionServicesOptions = {
      env: env(),
      createContainer,
      schedulerFactory,
      signals,
    };
    const { register } = await import("./instrumentation");

    await Promise.all([register(options), register(options)]);
    const services = await retainedProductionServices();

    expect(services).toBeDefined();
    expect(createContainer).toHaveBeenCalledTimes(1);
    expect(schedulerFactory).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(signalHandlers.has("SIGINT")).toBe(true);
    expect(signalHandlers.has("SIGTERM")).toBe(true);

    signalHandlers.get("SIGTERM")?.();
    const firstExplicitShutdown = services?.stop();
    const duplicateExplicitShutdown = services?.stop();
    await Promise.resolve();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    schedulerStop.resolve();
    await Promise.all([firstExplicitShutdown, duplicateExplicitShutdown]);
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(143);
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "scheduler:start",
      "scheduler:stop:start",
      "scheduler:stop:end",
      "container:close",
      "process:exit:143",
    ]);

    vi.resetModules();
    const reloadedInstrumentation = await import("./instrumentation");
    await reloadedInstrumentation.register(options);
    await services?.stop();

    expect(createContainer).toHaveBeenCalledTimes(1);
    expect(schedulerFactory).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(signalHandlers.size).toBe(0);
  });

  it("does not start Node.js services in the Edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const { register } = await import("./instrumentation");

    await register();

    expect((globalThis as Record<string, unknown>)[PRODUCTION_SERVICES_KEY]).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity";
import type { Database } from "@/server/database/client";
import type { Container } from "@/server/container";

import { CognitiveRuntime, cognitiveRuntimeFor } from "./index";
import { cognitiveLaunchRecoverySweeper } from "./launch-recovery-sweeper";
import { withCognitive } from "./http";

/**
 * A READ MUST NOT EXECUTE ANYTHING.
 *
 * `cognitiveRuntimeFor(...)` used to fire `recoverLaunches(tenant)` while COMPOSING the
 * runtime. Every cognitive surface goes through that composition, so
 * `GET /api/cognitive/conversations`, a cockpit read model or a page render could relaunch an
 * approved goal proposal — `launch()` → `scheduler.enqueue("start_mission")`. Opening or
 * refreshing a page started missions.
 *
 * These tests pin both halves of the fix: reads compose nothing executable, and recovery
 * still happens — only from the one explicit path that is allowed to execute.
 */

/** A db that FAILS if anything queries it: composition must not touch the database either. */
const forbiddenDb = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`composition queried the database: ${String(prop)}`);
    },
  },
) as Database;

function containerWith(scheduler: { enqueue: ReturnType<typeof vi.fn> }): Container {
  return {
    db: forbiddenDb,
    goalNormalizer: {},
    goalPlanner: {},
    goalPreviewStore: {},
    goalRepository: {},
    scheduler,
  } as unknown as Container;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("COGNITIVE_GET_NO_SIDE_EFFECTS", () => {
  it("composing the runtime never recovers launches and never enqueues a mission", () => {
    const recover = vi.spyOn(CognitiveRuntime.prototype, "recoverLaunches");
    const enqueue = vi.fn();

    const runtime = cognitiveRuntimeFor(containerWith({ enqueue }));

    expect(runtime).not.toBeNull();
    expect(recover).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  /*
   * Exercised through `withCognitive`, the shared guard EVERY /api/cognitive/* route goes
   * through (src/server/cognitive/http.ts): authorize and handler are stubbed, so what this
   * pins is that the shared composition step executes nothing — not each individual handler.
   */
  it("a GET read surface enqueues no launch and no start_mission", async () => {
    const recover = vi.spyOn(CognitiveRuntime.prototype, "recoverLaunches");
    const enqueue = vi.fn();
    const container = containerWith({ enqueue });
    const getContainerSpy = vi
      .spyOn(await import("@/server/container"), "getContainer")
      .mockResolvedValue(container);

    // The exact shape of GET /api/cognitive/conversations: authorize, compose, read.
    const response = await withCognitive(
      new Request("http://localhost/api/cognitive/conversations"),
      async () => ({
        ok: true,
        session: {
          user: { id: "human-1", email: "h@icos.test", status: "active" as const },
          roles: ["operator" as const],
        },
      }),
      async () => new Response(JSON.stringify({ conversations: [] }), { status: 200 }),
    );

    expect(response.status).toBe(200);
    expect(recover).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    getContainerSpy.mockRestore();
  });

  /** NO_DIRECT_CORE3_FROM_READ_PATH: the read path holds no mission-execution call. */
  it("repeated reads stay side-effect free (no interval-based recovery left)", () => {
    const recover = vi.spyOn(CognitiveRuntime.prototype, "recoverLaunches");
    const enqueue = vi.fn();
    const container = containerWith({ enqueue });

    for (let i = 0; i < 5; i++) cognitiveRuntimeFor(container);

    expect(recover).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("RECOVERY_EXPLICIT_ONLY", () => {
  it("the explicit sweeper is what recovers launches", async () => {
    const recover = vi
      .spyOn(CognitiveRuntime.prototype, "recoverLaunches")
      .mockResolvedValue({ recovered: 2, failed: 1 });

    const result = await cognitiveLaunchRecoverySweeper(
      containerWith({ enqueue: vi.fn() }),
    ).sweep();

    expect(recover).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      discovered: 3,
      attempted: 3,
      succeeded: 2,
      failed: 1,
      failures: [],
    });
  });

  /** TENANT_ISOLATION: the tenant comes from the canonical identity, never from a caller. */
  it("recovers under the canonical tenant only", async () => {
    const recover = vi
      .spyOn(CognitiveRuntime.prototype, "recoverLaunches")
      .mockResolvedValue({ recovered: 0, failed: 0 });

    await cognitiveLaunchRecoverySweeper(containerWith({ enqueue: vi.fn() })).sweep();

    // The tenant is the canonical constant; no request, body or caller argument can change it.
    expect(recover).toHaveBeenCalledWith(CURRENT_SINGLE_TENANT_ID);
    expect(recover.mock.calls).toEqual([[CURRENT_SINGLE_TENANT_ID]]);
  });

  it("is a no-op without PostgreSQL rather than a second recovery engine", async () => {
    const recover = vi.spyOn(CognitiveRuntime.prototype, "recoverLaunches");

    const result = await cognitiveLaunchRecoverySweeper({} as Container).sweep();

    expect(recover).not.toHaveBeenCalled();
    expect(result).toEqual({
      discovered: 0,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      failures: [],
    });
  });
});

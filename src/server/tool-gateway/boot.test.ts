import { describe, expect, it, vi } from "vitest";

import type { Container } from "@/server/container";
import { InMemoryAgentRepository } from "@/server/services/in-memory/agent-repository";

import { bootToolGateway, toolReconciliationSweeper } from "./boot";
import type { ToolGatewayRuntime } from "./composition";
import { RUNTIME_AGENT, RUNTIME_AGENT_ID } from "./runtime-agent";

const runtimeWith = (runOnce: () => Promise<unknown>) =>
  ({ reconciliation: { runOnce } }) as unknown as ToolGatewayRuntime;

describe("Tool Gateway production boot", () => {
  it("registers the runtime identity (level 0, no grant) and builds the shared runtime", async () => {
    const agents = new InMemoryAgentRepository([]);
    const getRuntime = vi.fn().mockResolvedValue(runtimeWith(async () => ({})));
    const container = { agents } as unknown as Container;

    expect(await bootToolGateway(container, getRuntime)).toEqual({
      runtimeAgent: "created",
      reconciled: true,
    });
    expect(getRuntime).toHaveBeenCalledWith(container);
    expect(await agents.getById(RUNTIME_AGENT_ID)).toMatchObject({ authorizationLevel: 0 });
    // Idempotent: a second boot (or replica) creates nothing.
    expect((await bootToolGateway(container, getRuntime)).runtimeAgent).toBe("present");
  });

  it("never rewrites an existing identity (registration cannot elevate or reset)", async () => {
    const agents = new InMemoryAgentRepository([{ ...RUNTIME_AGENT, status: "offline" }]);
    await bootToolGateway({ agents } as unknown as Container, async () =>
      runtimeWith(async () => ({})),
    );
    expect((await agents.getById(RUNTIME_AGENT_ID))!.status).toBe("offline");
  });

  it("is fail-soft and names the cause when the runtime cannot be composed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const report = await bootToolGateway({} as Container, async () => {
      throw new Error("ICOS_TOOL_GATEWAY_CONFIG is not valid JSON");
    });
    expect(report).toMatchObject({ runtimeAgent: "unavailable", reconciled: false });
    expect(report.error).toContain("ICOS_TOOL_GATEWAY_CONFIG is not valid JSON");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("TOOL_GATEWAY_BOOT_FAILED"));
    error.mockRestore();
  });
});

describe("periodic tool reconciliation on the production tick", () => {
  it("runs at most once per interval, starting one interval after boot", async () => {
    let t = 0;
    const runOnce = vi.fn().mockResolvedValue({
      ranAt: "x",
      tenants: [{ tenantId: "default", health: [], settledExecutions: 2 }],
    });
    const sweeper = toolReconciliationSweeper({} as Container, {
      intervalMs: 1_000,
      now: () => t,
      getRuntime: async () => runtimeWith(runOnce),
    });
    await sweeper.sweep();
    expect(runOnce).not.toHaveBeenCalled(); // boot already reconciled
    t = 1_000;
    expect(await sweeper.sweep()).toMatchObject({ discovered: 1, succeeded: 2, failed: 0 });
    t = 1_500;
    await sweeper.sweep();
    expect(runOnce).toHaveBeenCalledTimes(1);
    t = 2_000;
    await sweeper.sweep();
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("a failing pass throws, so sweepAll reports it under its name", async () => {
    let t = 0;
    const sweeper = toolReconciliationSweeper({} as Container, {
      intervalMs: 1,
      now: () => t,
      getRuntime: async () =>
        runtimeWith(async () => {
          throw new Error("db down");
        }),
    });
    t = 5;
    await expect(sweeper.sweep()).rejects.toThrow("db down");
  });
});

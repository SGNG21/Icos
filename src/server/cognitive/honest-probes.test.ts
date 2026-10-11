import { afterEach, describe, expect, it } from "vitest";

import { decideExecutable, type ExecutableDecision } from "@/core/execution/executable-policy";
import type { Database } from "@/server/database/client";
import type { SandboxBackendDetection } from "@/server/workers/process/sandbox-backend";

import {
  countLaunchableExecutors,
  markRealtimeCallerWired,
  measureRealtime,
  resetRealtimeCallerWiredForTests,
} from "./honest-probes";

const SANDBOX: SandboxBackendDetection = {
  backend: { mechanism: "bubblewrap", executable: "/usr/bin/bwrap" },
};
const NO_SANDBOX: SandboxBackendDetection = { backend: null, reason: "/usr/bin/bwrap absent" };
const allowOnly =
  (...names: string[]) =>
  (command: string, args: readonly string[]): ExecutableDecision =>
    names.includes(command) && !args.includes("-c")
      ? { allowed: true, reason: "EXECUTABLE_ALLOWED" }
      : { allowed: false, reason: "EXECUTABLE_NOT_ALLOWED" };

const commands = JSON.stringify({
  node: { command: "hermes", args: ["run", "{{prompt}}"] },
  binary: { command: "codex", args: ["exec"] },
  docker: { command: "bash", args: ["-c", "{{prompt}}"] },
});

describe("countLaunchableExecutors: declared is not launchable", () => {
  it("counts only runtimes whose command passes the executable policy", () => {
    const env = { ICOS_WORKER_EXEC_COMMANDS: commands };
    expect(countLaunchableExecutors(env, SANDBOX, allowOnly("hermes"))).toBe(1);
    expect(countLaunchableExecutors(env, SANDBOX, allowOnly("hermes", "codex", "bash"))).toBe(2);
  });

  it("is zero without a proven sandbox backend, whatever is allowed", () => {
    const env = { ICOS_WORKER_EXEC_COMMANDS: commands };
    expect(countLaunchableExecutors(env, NO_SANDBOX, allowOnly("hermes", "codex"))).toBe(0);
  });

  it("default policy is the frozen allowlist, empty in tests → nothing launchable", () => {
    expect(
      countLaunchableExecutors({ ICOS_WORKER_EXEC_COMMANDS: commands }, SANDBOX, decideExecutable),
    ).toBe(0);
  });

  it("nothing declared is 0; malformed declaration is unmeasurable (undefined)", () => {
    expect(countLaunchableExecutors({}, SANDBOX, allowOnly("hermes"))).toBe(0);
    expect(
      countLaunchableExecutors({ ICOS_WORKER_EXEC_COMMANDS: "{nope" }, SANDBOX, allowOnly()),
    ).toBeUndefined();
  });
});

describe("measureRealtime: fail closed", () => {
  afterEach(() => resetRealtimeCallerWiredForTests());
  const failingDb = {
    select: () => {
      throw new Error("db down");
    },
  } as unknown as Database;
  const config = JSON.stringify({
    instances: [{ instanceId: "search-main", connectorId: "search" }],
  });

  it("a failing database yields unmeasured health and no grant, never optimism", async () => {
    expect(await measureRealtime(failingDb, { ICOS_TOOL_GATEWAY_CONFIG: config })).toEqual({
      declared: 1,
      healthy: undefined,
      runtimeAgentGranted: false,
      callerWired: false,
    });
  });

  it("an unreadable config is undefined; nothing declared is 0; callerWired reflects wiring", async () => {
    expect(
      (await measureRealtime(failingDb, { ICOS_TOOL_GATEWAY_CONFIG: "{bad" })).declared,
    ).toBeUndefined();
    markRealtimeCallerWired();
    expect(await measureRealtime(failingDb, {})).toMatchObject({
      declared: 0,
      healthy: 0,
      callerWired: true,
    });
  });
});

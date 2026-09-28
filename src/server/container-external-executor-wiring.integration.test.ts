import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { RuntimeDispatchRouter } from "@/server/execution/runtime-dispatch-router";
import { TemporalTaskExecutionDispatcher } from "@/server/execution/temporal-task-execution-dispatcher";

/*
 * REAL_RUNTIME_EXTERNAL_EXECUTOR_WIRED — DEFECT 22.
 *
 * Every M6.3/M7 proof composed the external executor BY HAND in a test. The real
 * container did not, so a production process started then would never have launched an
 * external worker, however green those suites were. These assertions are deliberately
 * about the CONTAINER — the thing production actually builds — and not about a
 * composition a test assembled.
 */

const DATABASE_URL = TEST_DATABASE_URL;

const baseEnv = {
  NODE_ENV: "test" as const,
  PERSISTENCE: "postgres" as const,
  DATABASE_URL,
  OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
  OMNIROUTE_API_KEY: "wiring-test-key",
  ICOS_REVIEWER_MODEL: "wiring-test-model",
};

const containers: Container[] = [];
let root: string | undefined;

async function build(extra: Record<string, string> = {}): Promise<Container> {
  const env = loadEnv({ ...baseEnv, ...extra });
  const container = await buildPostgresContainer(DATABASE_URL, undefined, env);
  containers.push(container);
  return container;
}

afterEach(async () => {
  await Promise.all(containers.splice(0).map((c) => c.close()));
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe("DEFECT 22 — external execution is wired into the REAL container", () => {
  it("WITH NO CONFIGURATION the dispatcher is UNCHANGED (Temporal)", async () => {
    const container = await build();

    /*
     * The safety property. A deployment that has not opted in must be bit-for-bit what it
     * was before this wiring existed — otherwise the fix is itself a regression.
     */
    expect(container.taskExecution).toBeInstanceOf(TemporalTaskExecutionDispatcher);
  });

  it("REAL_RUNTIME_EXTERNAL_EXECUTOR_WIRED: configuration makes the container route by runtime", async () => {
    root = await mkdtemp(join(tmpdir(), "icos-wiring-"));
    const container = await build({
      ICOS_WORKER_EXEC_COMMANDS: JSON.stringify({
        binary: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      }),
      ICOS_REPO_PATH: root,
    });

    /* The production object is the router, not Temporal. This is the defect, closed. */
    expect(container.taskExecution).toBeInstanceOf(RuntimeDispatchRouter);
    /* And it will execute exactly the runtime that was configured — no more. */
    expect((container.taskExecution as RuntimeDispatchRouter).external()).toEqual(["binary"]);
  });

  it("CONFIGURING EXECUTION WITHOUT A CANONICAL REPO REFUSES TO BOOT", async () => {
    /*
     * A writer worker needs a repository to branch a worktree from. Defaulting to
     * `process.cwd()` would point an autonomous agent at whatever directory the server
     * happened to start in — a silent, and potentially destructive, guess.
     */
    await expect(
      build({
        ICOS_WORKER_EXEC_COMMANDS: JSON.stringify({
          binary: { command: process.execPath, args: [] },
        }),
      }),
    ).rejects.toThrow(/ICOS_REPO_PATH_REQUIRED/);
  });

  it("MALFORMED EXECUTION CONFIGURATION REFUSES TO BOOT rather than executing nothing", async () => {
    /*
     * Same rule as ICOS_WORKER_PROBE_COMMANDS (0036): a silently ignored configuration
     * means the fleet accepts tasks and completes none, with nothing saying why.
     */
    await expect(
      build({ ICOS_WORKER_EXEC_COMMANDS: "{not json", ICOS_REPO_PATH: "/tmp" }),
    ).rejects.toThrow(/WORKER_EXEC_COMMANDS_INVALID/);
  });
});

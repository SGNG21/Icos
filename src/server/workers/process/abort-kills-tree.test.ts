import { describe, expect, it } from "vitest";

import { processIsAlive, waitForProcessExit } from "@/test/process-liveness";

import { runNonInteractive } from "./run-process";

/**
 * REVOKING AUTHORITY STOPS THE WORK, not just its result.
 *
 * A writer that loses its workspace lease kept running: the only consequence was that
 * its result would be refused afterwards. Refusing a result does not unwrite files —
 * the process was still writing into a worktree another owner may already hold. So the
 * abort kills the process GROUP, which is what `detached: true` and the negative signal
 * exist for; a grandchild the worker spawned must not outlive the revocation.
 *
 * Real processes here on purpose. A mocked runner cannot prove a descendant died.
 */
describe("an aborted run dies, with its descendants", () => {
  /** Parent spawns a child that would outlive it, then both sleep well past the test. */
  const SPAWNS_A_CHILD = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
      stdio: "ignore", detached: false,
    });
    process.stdout.write(String(child.pid) + "\\n");
    setTimeout(() => {}, 60000);
  `;

  /*
   * A ZOMBIE IS NOT A SURVIVOR. `process.kill(pid, 0)` was the probe here and cannot tell
   * the two apart: a killed grandchild whose parent died first is reparented to pid 1 and
   * stays addressable until pid 1 reaps it, so the signal probe answered "alive" for a
   * process that held no memory and ran no code. Under a container pid 1 that never reaps
   * orphans that window never closes, and the proof failed where the behaviour was right.
   */
  const alive = processIsAlive;

  it("kills the worker and the grandchild it spawned", async () => {
    const controller = new AbortController();
    const started = Date.now();

    const run = runNonInteractive({
      command: process.execPath,
      args: ["-e", SPAWNS_A_CHILD],
      cwd: process.cwd(),
      env: {},
      /* Far longer than the test: only the abort can end this. */
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    });

    /* Let the tree come up and report the grandchild's pid. */
    await new Promise((resolve) => setTimeout(resolve, 600));
    controller.abort();

    const result = await run;
    const grandchildPid = Number(result.stdout.trim().split("\n")[0]);

    expect(result.aborted).toBe(true);
    /* It ended because it was killed, not because the timeout elapsed. */
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(20_000);

    /* DESCENDANTS_KILLED_ON_LEASE_LOSS — a kill is asynchronous, so poll for the teardown. */
    expect(Number.isFinite(grandchildPid)).toBe(true);
    expect(await waitForProcessExit(grandchildPid, 5_000)).toBe(true);
    expect(alive(grandchildPid)).toBe(false);
  }, 40_000);

  it("refuses to start work whose authority is already gone", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runNonInteractive({
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{}, 60000)"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 20_000);

  it("a run nobody revokes is unaffected", async () => {
    const result = await runNonInteractive({
      command: process.execPath,
      args: ["-e", "process.stdout.write('done')"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 20_000,
      abortSignal: new AbortController().signal,
    });

    expect(result.aborted).toBe(false);
    expect(result.stdout).toBe("done");
    expect(result.exitCode).toBe(0);
  }, 20_000);
});

import { request as httpRequest } from "node:http";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST = JSON.stringify([
    "icos-claude-worker.mjs",
    process.execPath,
  ]);
});

import { BudgetDeniedError } from "@/server/budget/metered-fetch";
import { currentAttribution } from "@/server/budget/attribution-context";

import { runGovernedWorker } from "./activities";

/**
 * THE ACTIVITY WIRES METERED EGRESS (ADR 0075 amendment A) — what the sandbox is ASKED for
 * is the security decision, so that is what these pin: no network, the socket directory and
 * the adapter read-only, the socket path in the worker's env, the routed model in argv, the
 * grant's attribution on every call, and a budget DENY failing the run.
 */

const ADAPTER = resolve(__dirname, "../../../../bin/icos-claude-worker.mjs");

type RunOptions = Parameters<
  typeof import("@/server/workers/process/run-process").runNonInteractive
>[0];
let runs: RunOptions[] = [];
let workerCalls: { status: number; body: string }[] = [];

vi.mock("@/server/workers/process/run-process", () => ({
  runNonInteractive: vi.fn(async (options: RunOptions) => {
    runs.push(options);
    const socketPath = options.env?.ICOS_EGRESS_SOCKET;
    if (socketPath) {
      /* What the adapter does inside the sandbox: one model call over the socket. */
      workerCalls.push(
        await new Promise((done, fail) => {
          const req = httpRequest(
            { socketPath, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" } },
            (res) => {
              let body = "";
              res.on("data", (c: Buffer) => (body += c.toString()));
              res.on("end", () => done({ status: res.statusCode ?? 0, body }));
            },
          );
          req.on("error", fail);
          req.end(JSON.stringify({ model: "routed/model", max_tokens: 10, messages: [] }));
        }),
      );
    }
    if (options.env?.ICOS_WORKER_STATUS_FILE) {
      writeFileSync(options.env.ICOS_WORKER_STATUS_FILE, JSON.stringify({ completed: true, failed: false }));
    }
    return { stdout: "RESULT", stderr: "", timedOut: false, aborted: false, exitCode: 0, confinement: "bubblewrap" };
  }),
}));

let meterMode: "allow" | "deny" = "allow";
const meterAttributions: unknown[] = [];
vi.mock("@/server/workers/metered-egress", () => ({
  workerEgressUpstream: () => ({ baseUrl: "http://gateway.invalid" }),
  workerEgressFetch: () => async () => {
    meterAttributions.push(currentAttribution());
    if (meterMode === "deny") {
      throw new BudgetDeniedError({ kind: "DENY", reason: "TOKEN_CAP_REACHED", detail: "cap" });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  },
}));

const grant = (over: Record<string, unknown> = {}) => ({
  taskId: "task-1",
  missionId: "mission-1",
  workflowId: "wf-1",
  goalId: "goal-1",
  credentialScope: [],
  writeAllowed: false,
  workspace: null,
  model: "routed/model",
  provider: "nvidia",
  ...over,
});

describe("runGovernedWorker — metered egress executor", () => {
  beforeEach(() => {
    runs = [];
    workerCalls = [];
    meterMode = "allow";
    meterAttributions.length = 0;
    process.env.ICOS_BASE_URL = "http://127.0.0.1:1";
    process.env.ICOS_EXECUTION_CALLBACK_SECRET = "a".repeat(48);
    process.env.ICOS_WORKSPACE_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "icos-canon-")));
    process.env.ICOS_WORKER_EXEC_COMMANDS = JSON.stringify({
      binary: { command: ADAPTER, args: ["--prompt", "{{prompt}}", "--model", "{{model}}"], timeoutMs: 5_000 },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const answer = (g: Record<string, unknown>) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ grant: g }) }) as unknown as Response));

  it("no network, socket + adapter read-only, routed model in argv, calls attributed to the goal", async () => {
    answer(grant());
    const result = await runGovernedWorker({ taskId: "task-1", workflowId: "wf-1" }, "do it");
    expect(result.result).toBe("RESULT");

    const [options] = runs;
    expect(options!.sandbox?.allowNetwork).toBe(false);
    const socket = options!.env!.ICOS_EGRESS_SOCKET!;
    expect(socket).toMatch(/gateway\.sock$/);
    expect(options!.sandbox?.readOnlyPaths).toEqual(
      expect.arrayContaining([realpathSync(ADAPTER), resolve(socket, "..")]),
    );
    expect(options!.sandbox?.readWritePaths).not.toContain(resolve(socket, ".."));
    expect(options!.args).toEqual(["--prompt", "do it", "--model", "routed/model"]);

    expect(workerCalls).toEqual([{ status: 200, body: "{}" }]);
    expect(meterAttributions).toEqual([{ missionId: "mission-1", goalId: "goal-1" }]);
  });

  it("a budget DENY fails the run WORKER_BUDGET_DENIED, whatever the worker printed", async () => {
    meterMode = "deny";
    answer(grant());
    await expect(runGovernedWorker({ taskId: "task-1", workflowId: "wf-1" }, "do it")).rejects.toThrow(
      /^WORKER_BUDGET_DENIED: BUDGET_DENIED:TOKEN_CAP_REACHED/,
    );
    expect(workerCalls[0]!.status).toBe(402);
  });

  it("a launch command naming {{model}} with no routed model is refused before anything runs", async () => {
    answer(grant({ model: null }));
    await expect(runGovernedWorker({ taskId: "task-1", workflowId: "wf-1" }, "do it")).rejects.toThrow(
      "WORKER_EXEC_UNROUTABLE",
    );
    expect(runs).toHaveLength(0);
  });

  it("other executors keep their network semantics", async () => {
    process.env.ICOS_WORKER_EXEC_COMMANDS = JSON.stringify({
      binary: { command: process.execPath, args: ["-e", ""], timeoutMs: 5_000 },
    });
    answer(grant());
    await runGovernedWorker({ taskId: "task-1", workflowId: "wf-1" }, "do it");
    expect(runs[0]!.sandbox?.allowNetwork).toBe(true);
    expect(runs[0]!.env?.ICOS_EGRESS_SOCKET).toBeUndefined();
  });
});

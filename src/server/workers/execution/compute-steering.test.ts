import { describe, expect, it, vi } from "vitest";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { workerTaskContractSchema } from "@/core/contracts/worker-execution";
import { CommandReviewer } from "@/server/review/command-reviewer";
import type { ReviewInput } from "@/server/review/ports";
import type { NonInteractiveProcessResult } from "@/server/workers/process/run-process";
import { createWorkerProbeResolver } from "@/server/workers/probes/probe-command-config";
import { CommandWorkerExecutor } from "./command-worker-executor";
import { createWorkerExecResolver, parseWorkerExecCommands } from "./exec-command-config";

/*
 * Decision 0054 — a routing decision is only real if the ROUTED model is the one that runs.
 * Before this, every worker on a runtime launched the CLI's default model and `metadata.model`
 * was a label. These prove the model reaches the process, and that a template needing a model
 * refuses to run without one rather than silently using a default.
 */

function worker(metadata: Record<string, string>): WorkerRegistryEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workerKind: "agent",
    displayName: "w",
    capabilities: [],
    features: [],
    supportsTools: false,
    supportsStructuredOutput: false,
    status: "active",
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
    health: "healthy",
    availability: "available",
    tags: [],
    metadata,
    maxConcurrency: 1,
    capacityPool: null,
    capacityPoolLimit: null,
    lastProbeAt: null,
    lastProbeOutcome: "never",
    updatedAt: new Date().toISOString(),
  };
}

const contract = workerTaskContractSchema.parse({
  missionId: "m",
  missionTaskId: "mt",
  taskId: "t",
  attempt: 1,
  workflowId: "wf",
  objective: "o",
  instructions: "i",
  workspacePath: process.cwd(),
});
const workspace = {
  path: process.cwd(),
  mode: "reader" as const,
  branch: null,
  baseCommit: null,
  dispose: async () => {},
};

const echoArgv = (timeoutMs = 20_000) =>
  createWorkerExecResolver(
    parseWorkerExecCommands(
      JSON.stringify({
        node: {
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write(process.argv.slice(1).join('|'))",
            "{{model}}",
            "{{provider}}",
          ],
          timeoutMs,
        },
      }),
    ),
  );

describe("decision 0054 — the routed model is the model that runs", () => {
  it("the executor passes the candidate's model and provider into argv", async () => {
    const outcome = await new CommandWorkerExecutor(echoArgv()).execute({
      worker: worker({ model: "vendor/model-x", provider: "vendor" }),
      contract,
      workspace,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.process?.stdout).toBe("vendor/model-x|vendor");
    expect(outcome.identity).toMatchObject({ model: "vendor/model-x", provider: "vendor" });
  });

  it("a template that needs a model REFUSES a worker that declares none — nothing runs", async () => {
    const run = vi.fn();
    const outcome = await new CommandWorkerExecutor(echoArgv(), { run: run as never }).execute({
      worker: worker({}),
      contract,
      workspace,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failureClass).toBe("MODEL_UNAVAILABLE");
    expect(outcome.message).toMatch(/WORKER_EXEC_UNROUTABLE/);
    expect(run).not.toHaveBeenCalled();
  });

  it("the ROUTED budget overrides the runtime timeout, and a kill is EXECUTION_TIMEOUT", async () => {
    const hang = createWorkerExecResolver(
      parseWorkerExecCommands(
        JSON.stringify({
          node: {
            command: process.execPath,
            args: ["-e", "setTimeout(()=>{}, 60000)"],
            timeoutMs: 60_000,
          },
        }),
      ),
    );
    const started = Date.now();
    const outcome = await new CommandWorkerExecutor(hang).execute({
      worker: worker({ model: "m" }),
      contract,
      workspace,
      timeoutMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failureClass).toBe("EXECUTION_TIMEOUT");
  });

  it("the probe asks about THIS candidate's model, and cannot be resolved without one", () => {
    const resolve = createWorkerProbeResolver({
      node: { command: "agent", args: ["--check", "{{model}}"] },
    });
    expect(resolve(worker({ model: "vendor/model-x" }))?.args).toEqual([
      "--check",
      "vendor/model-x",
    ]);
    expect(resolve(worker({}))).toBeNull();
  });
});

describe("decision 0054 — the routed reviewer model is the one that reviews", () => {
  const ran = (stdout: string): NonInteractiveProcessResult => ({
    stdout,
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
    truncated: false,
  });
  const input = (reviewerCompute?: ReviewInput["reviewerCompute"]) =>
    ({
      mission: { id: "m1", title: "t", objective: "o", status: "running" },
      missionTask: {
        id: "mt1",
        missionId: "m1",
        title: "t",
        dependsOn: [],
        status: "running",
        taskId: "task-1",
      },
      task: { id: "task-1", title: "t", description: undefined },
      executionResult: { taskId: "task-1", workflowId: "wf-1", outcome: "success" },
      artifacts: [],
      evidence: [],
      findings: [],
      reviewerCompute,
    }) as unknown as ReviewInput;
  const approve = JSON.stringify({ decision: "APPROVE", reasons: ["ok"] });

  it("steers the model, and the durable metadata names the model that actually reviewed", async () => {
    const run = vi.fn<(spec: { args: string[] }) => Promise<NonInteractiveProcessResult>>(
      async () => ran(approve),
    );
    const reviewer = new CommandReviewer({
      command: "agent",
      args: ["-p", "{{prompt}}", "-m", "{{model}}"],
      timeoutMs: 1000,
      run: run as never,
    });
    const decision = await reviewer.review(
      input({
        workerId: "r",
        model: "vendor/reviewer-y",
        provider: "vendor",
        routing: { kind: "ROUTING_DECISION" },
      }),
    );
    expect(run.mock.calls[0]![0].args.slice(-2)).toEqual(["-m", "vendor/reviewer-y"]);
    expect(decision.providerMetadata).toMatchObject({
      provider: "vendor",
      model: "vendor/reviewer-y",
      routing: { kind: "ROUTING_DECISION" },
    });
  });

  it("a steering command with NO routed reviewer refuses (no unattributable review)", async () => {
    const run = vi.fn(async () => ran(approve));
    const reviewer = new CommandReviewer({
      command: "agent",
      args: ["-p", "{{prompt}}", "-m", "{{model}}"],
      timeoutMs: 1000,
      run: run as never,
    });
    await expect(reviewer.review(input())).rejects.toThrow(/QUALITY_REVIEWER_COMPUTE_UNROUTED/);
    expect(run).not.toHaveBeenCalled();
  });

  it("a command that cannot steer ignores the routed model and reports its own identity", async () => {
    const run = vi.fn(async () => ran(approve));
    const reviewer = new CommandReviewer({
      command: "/usr/bin/agent",
      args: ["-p", "{{prompt}}"],
      timeoutMs: 1000,
      run: run as never,
    });
    const decision = await reviewer.review(input({ workerId: "r", model: "vendor/reviewer-y" }));
    expect(decision.providerMetadata).toMatchObject({ provider: "command", model: "agent" });
  });
});

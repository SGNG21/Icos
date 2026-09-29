import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import {
  workerTaskContractSchema,
  type WorkerExecutionOutcome,
} from "@/core/contracts/worker-execution";
import { CommandWorkerExecutor, RESULT_SENTINEL_END, RESULT_SENTINEL_START, composeWorkerPrompt, parseStructuredResult } from "./command-worker-executor";
import { parseWorkerExecCommands, createWorkerExecResolver, substituteArgs } from "./exec-command-config";
import { WorkerExecutor } from "./worker-executor";
import type { WorkerWorkspace } from "./writer-workspace";

/*
 * M6.3 — REAL external worker execution.
 *
 * These launch ACTUAL processes. The runtime used is this process's own Node
 * (`process.execPath`), which is not a provider hardwire: it is the runtime the
 * server already runs in, so no product name or path is committed. The real
 * Hermes proof lives in the integration suite, where a missing binary can skip
 * rather than break the unit gate.
 */

const WORKER_ID = "11111111-1111-4111-8111-111111111111";

function worker(over: Partial<WorkerRegistryEntry> = {}): WorkerRegistryEntry {
  return {
    id: WORKER_ID,
    workerKind: "agent",
    displayName: "w",
    capabilities: ["code-generation"],
    features: [],
    supportsTools: false,
    supportsStructuredOutput: false,
    status: "active",
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
    health: "healthy",
    availability: "available",
    tags: [],
    metadata: {},
    maxConcurrency: 1,
    updatedAt: new Date(),
    ...over,
  } as WorkerRegistryEntry;
}

/** A reader workspace: no branch, no isolation needed, nothing to dispose. */
const readerWorkspace = (path: string): WorkerWorkspace => ({
  path,
  mode: "reader",
  branch: null,
  baseCommit: null,
  dispose: async () => {},
});

/**
 * Narrows to the failure arm. An `expect(outcome.ok).toBe(false)` alone leaves the
 * union unnarrowed, so the compiler cannot check that the assertions below are even
 * reachable — which is how a test quietly asserts against `undefined`.
 */
function asFailure(outcome: WorkerExecutionOutcome) {
  if (outcome.ok) throw new Error(`expected a failure, got success`);
  return outcome;
}

function contract(over: Record<string, unknown> = {}) {
  return workerTaskContractSchema.parse({
    goalId: "goal-7",
    missionId: "mission-1",
    planId: "plan-3",
    missionTaskId: "mt-1",
    taskId: "task-1",
    attempt: 2,
    workflowId: "wf-1",
    objective: "Prove execution",
    instructions: "Do the thing",
    successCriteria: ["it is done"],
    allowedFileScope: [],
    workspacePath: process.cwd(),
    ...over,
  });
}

/** Runs real Node with an inline script. The launch is genuine, the work is trivial. */
const nodeCommands = (script: string, extra: Record<string, unknown> = {}) =>
  createWorkerExecResolver(
    parseWorkerExecCommands(
      JSON.stringify({
        node: { command: process.execPath, args: ["-e", script], timeoutMs: 20_000, ...extra },
      }),
    ),
  );

describe("M6.3 command worker executor", () => {
  it("WORKER_PROCESS_LAUNCH: a REAL process runs and its exit code is captured", async () => {
    const executor = new CommandWorkerExecutor(
      nodeCommands("process.stdout.write('did work'); process.exit(0)"),
    );

    const outcome = await executor.execute({
      worker: worker(),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.process?.exitCode).toBe(0);
    expect(outcome.process?.stdout).toContain("did work");
    // A real process takes real time; a stub would not.
    expect(outcome.process?.durationMs).toBeGreaterThan(0);
  });

  it("STDOUT_STDERR_CAPTURE: both streams and the exit code are captured separately", async () => {
    const executor = new CommandWorkerExecutor(
      nodeCommands(
        "process.stdout.write('OUT-MARK'); process.stderr.write('ERR-MARK'); process.exit(3)",
      ),
    );

    const outcome = await executor.execute({
      worker: worker(),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.process?.stdout).toContain("OUT-MARK");
    expect(outcome.process?.stderr).toContain("ERR-MARK");
    // Not merged: a classifier that cannot tell them apart cannot prioritise stderr.
    expect(outcome.process?.stdout).not.toContain("ERR-MARK");
    expect(outcome.process?.exitCode).toBe(3);
  });

  it("TASK_CONTRACT_INJECTION: identity reaches the worker through env AND a file", async () => {
    /*
     * The worker ECHOES BACK what it received. This is the proof that injection is
     * real: the assertions read the child's own view of its contract, not ours.
     */
    const script = `
      const fs = require('fs');
      const contract = JSON.parse(fs.readFileSync(process.env.ICOS_TASK_CONTRACT_PATH, 'utf8'));
      process.stdout.write(JSON.stringify({
        env: {
          goalId: process.env.ICOS_GOAL_ID,
          missionId: process.env.ICOS_MISSION_ID,
          planId: process.env.ICOS_PLAN_ID,
          missionTaskId: process.env.ICOS_MISSION_TASK_ID,
          taskId: process.env.ICOS_TASK_ID,
          attempt: process.env.ICOS_ATTEMPT,
          workflowId: process.env.ICOS_WORKFLOW_ID,
        },
        file: contract,
        cwd: process.cwd(),
      }));
    `;

    const executor = new CommandWorkerExecutor(nodeCommands(script));
    const outcome = await executor.execute({
      worker: worker(),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    expect(outcome.ok).toBe(true);
    const seen = JSON.parse(outcome.process!.stdout) as {
      env: Record<string, string>;
      file: Record<string, unknown>;
      cwd: string;
    };

    // Every identity axis survives the boundary intact.
    expect(seen.env).toEqual({
      goalId: "goal-7",
      missionId: "mission-1",
      planId: "plan-3",
      missionTaskId: "mt-1",
      taskId: "task-1",
      attempt: "2",
      workflowId: "wf-1",
    });
    expect(seen.file.taskId).toBe("task-1");
    expect(seen.file.attempt).toBe(2);
    expect(seen.file.instructions).toBe("Do the thing");
    // The worker runs IN its workspace, not wherever the server happens to be.
    expect(seen.cwd).toBe(process.cwd());
  });

  it("THE CONTRACT FILE IS NOT INSIDE THE WORKSPACE, so it cannot pollute the evidence", async () => {
    const script =
      "process.stdout.write(process.env.ICOS_TASK_CONTRACT_PATH + '|' + process.env.ICOS_WORKSPACE)";
    const executor = new CommandWorkerExecutor(nodeCommands(script));

    const outcome = await executor.execute({
      worker: worker(),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    const [contractPath, workspacePath] = outcome.process!.stdout.split("|");
    /*
     * Written into the workspace it would appear in `git status` and be reported as
     * a file the worker changed — the observation corrupting the observed.
     */
    expect(contractPath!.startsWith(workspacePath!)).toBe(false);
  });

  it("THE CONTRACT FILE IS REMOVED after the run", async () => {
    const executor = new CommandWorkerExecutor(
      nodeCommands("process.stdout.write(process.env.ICOS_TASK_CONTRACT_PATH)"),
    );
    const outcome = await executor.execute({
      worker: worker(),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    await expect(readFile(outcome.process!.stdout, "utf8")).rejects.toThrow();
  });

  it("A READER IS TOLD IT MAY NOT WRITE, and a writer is given its scope", () => {
    expect(composeWorkerPrompt(contract({ allowedFileScope: [] }))).toContain("READ-ONLY");
    const writer = composeWorkerPrompt(contract({ allowedFileScope: ["src/"] }));
    expect(writer).toContain("You may write ONLY these paths");
    expect(writer).toContain("- src/");
    /* The fence is not advice: a file outside it rejects the whole run, after paying for it. */
    expect(writer).toContain("reject this entire run");
  });

  it("DEFECT 33 — A WRITER IS TOLD TO COMMIT; a reader is not", () => {
    /*
     * The contract described the work, the workspace and the scope, and never asked for the
     * one act that makes the work exist outside the worktree. A real agent edited files and
     * stopped, so the reviewer had nothing to review and the gate had nothing to integrate.
     */
    const writer = composeWorkerPrompt(contract({ allowedFileScope: ["src/"] }));
    expect(writer).toContain("COMMITTING your work");
    expect(writer).toContain("Uncommitted work cannot be");

    const reader = composeWorkerPrompt(contract({ allowedFileScope: [] }));
    expect(reader).not.toContain("COMMITTING your work");
  });

  it("RESUME IS A CONTINUATION: handoff is injected and the worker is told not to restart", () => {
    const prompt = composeWorkerPrompt(
      contract({ resumeToken: "sess-9", handoff: { done: ["step A"] } }),
    );
    // Without this the next attempt cheerfully redoes completed work.
    expect(prompt).toContain("CONTINUATION");
    expect(prompt).toContain("Do not start over");
    expect(prompt).toContain("step A");
  });

  it("RESUMING USES A DIFFERENT INVOCATION SHAPE when one is configured", async () => {
    const resolver = createWorkerExecResolver(
      parseWorkerExecCommands(
        JSON.stringify({
          node: {
            command: process.execPath,
            args: ["-e", "process.stdout.write('FRESH')"],
            resumeArgs: ["-e", "process.stdout.write('RESUMED:' + process.env.ICOS_RESUME_TOKEN)"],
            timeoutMs: 20_000,
          },
        }),
      ),
    );
    const executor = new CommandWorkerExecutor(resolver);

    const fresh = await executor.execute({
      worker: worker(),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });
    const resumed = await executor.execute({
      worker: worker(),
      contract: contract({ resumeToken: "sess-9" }),
      workspace: readerWorkspace(process.cwd()),
    });

    expect(fresh.process!.stdout).toBe("FRESH");
    // The token reaches the worker, so it can rejoin its own session.
    expect(resumed.process!.stdout).toBe("RESUMED:sess-9");
  });

  it("A STRUCTURED VERDICT is read from the sentinel block", async () => {
    const verdict = JSON.stringify({
      status: "succeeded",
      summary: "built it",
      testsRun: ["unit"],
      resumeToken: "sess-42",
    });
    const executor = new CommandWorkerExecutor(
      nodeCommands(
        `process.stdout.write('chatter\\n${RESULT_SENTINEL_START}${verdict}${RESULT_SENTINEL_END}')`,
      ),
    );

    const outcome = await executor.execute({
      worker: worker(),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.structured?.summary).toBe("built it");
    expect(outcome.resumeToken).toBe("sess-42");
  });

  it("EXIT 0 WITH A FAILURE VERDICT IS A FAILURE: the verdict outranks the exit code", async () => {
    /*
     * The common real shape: an agent wrapper exits 0 after reporting that it could
     * not do the job. Trusting the exit code here would mark the task succeeded.
     */
    const verdict = JSON.stringify({ status: "failed", failureClass: "FAILED_TERMINAL" });
    const executor = new CommandWorkerExecutor(
      nodeCommands(
        `process.stdout.write('${RESULT_SENTINEL_START}${verdict}${RESULT_SENTINEL_END}'); process.exit(0)`,
      ),
    );

    const outcome = await executor.execute({
      worker: worker(),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    const failure = asFailure(outcome);
    expect(failure.process?.exitCode).toBe(0);
    expect(failure.failureClass).toBe("FAILED_TERMINAL");
    expect(failure.retryable).toBe(false);
  });

  it("A MALFORMED VERDICT IS NOT A SUCCESS", async () => {
    const executor = new CommandWorkerExecutor(
      nodeCommands(
        `process.stdout.write('${RESULT_SENTINEL_START}{not json${RESULT_SENTINEL_END}')`,
      ),
    );

    const outcome = await executor.execute({
      worker: worker(),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    // Claimed the protocol and broke it: not trustworthy enough to call success.
    expect(asFailure(outcome).failureClass).toBe("FAILED_RETRYABLE");
  });

  it("SILENCE IS NOT A VIOLATION: no sentinel at all still succeeds on a clean exit", () => {
    expect(parseStructuredResult("just some output")).toEqual({ ok: true, value: undefined });
  });

  it("THE LAST verdict wins, so an internally-retrying worker concludes once", () => {
    const first = JSON.stringify({ status: "failed" });
    const last = JSON.stringify({ status: "succeeded", summary: "second try" });
    const parsed = parseStructuredResult(
      `${RESULT_SENTINEL_START}${first}${RESULT_SENTINEL_END}\n${RESULT_SENTINEL_START}${last}${RESULT_SENTINEL_END}`,
    );
    expect(parsed).toEqual({ ok: true, value: { status: "succeeded", summary: "second try" } });
  });

  it("NOTHING BLOCKS ON STDIN: a worker that reads stdin gets EOF instead of hanging", async () => {
    /*
     * The failure this prevents is the worst kind: a hang holds a capacity slot and
     * never yields a verdict, so it looks like work in progress forever.
     */
    const executor = new CommandWorkerExecutor(
      nodeCommands(
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write('EOF:'+d.length);process.exit(0)});process.stdin.resume()",
      ),
    );

    const outcome = await executor.execute({
      worker: worker(),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.process?.stdout).toBe("EOF:0");
  });

  it("A TIMEOUT KILLS and is classified as an UNKNOWN effect, not a failed task", async () => {
    const executor = new CommandWorkerExecutor(
      createWorkerExecResolver(
        parseWorkerExecCommands(
          JSON.stringify({
            node: { command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"], timeoutMs: 300 },
          }),
        ),
      ),
    );

    const outcome = await executor.execute({
      worker: worker(),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    const failure = asFailure(outcome);
    expect(failure.process?.timedOut).toBe(true);
    // We killed it, so we do NOT know what it had already written.
    expect(failure.failureClass).toBe("STREAM_FAILED");
    expect(failure.retryable).toBe(true);
  });

  it("A MISSING EXECUTABLE IS PROVIDER_UNAVAILABLE, and the task is untouched", async () => {
    const executor = new CommandWorkerExecutor(
      createWorkerExecResolver(
        parseWorkerExecCommands(
          JSON.stringify({
            node: { command: "icos-no-such-binary-6f3a", args: [], timeoutMs: 5_000 },
          }),
        ),
      ),
    );

    const outcome = await executor.execute({
      worker: worker(),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    const failure = asFailure(outcome);
    expect(failure.failureClass).toBe("PROVIDER_UNAVAILABLE");
    expect(failure.retryable).toBe(true);
  });

  it("NO PROVIDER HARDWIRE: an unconfigured runtime gets no adapter and nothing is invented", async () => {
    const executor = new WorkerExecutor({});
    const outcome = await executor.execute({
      worker: worker({ runtime: "binary" }),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    const failure = asFailure(outcome);
    expect(failure.message).toContain("WORKER_EXECUTOR_UNSUPPORTED_RUNTIME");
    // Retryable on purpose: an operator's missing config must not fail the task forever.
    expect(failure.retryable).toBe(true);
  });

  it("ADAPTERS ARE KEYED BY RUNTIME, so a novel worker KIND needs no adapter", async () => {
    const executor = new WorkerExecutor({
      node: new CommandWorkerExecutor(nodeCommands("process.stdout.write('ran')")),
    });

    const outcome = await executor.execute({
      // A worker kind nothing has ever heard of, on a runtime we support.
      worker: worker({ workerKind: "other", runtime: "node" }),
      contract: contract(),
      workspace: readerWorkspace(process.cwd()),
    });

    expect(outcome.ok).toBe(true);
    expect(executor.supportedRuntimes()).toEqual(["node"]);
  });

  it("SUBSTITUTION IS LITERAL and an absent value does not leak a placeholder", () => {
    expect(substituteArgs(["-p", "{{prompt}}", "--s", "{{resumeToken}}"], { prompt: "hi" })).toEqual(
      ["-p", "hi", "--s", ""],
    );
  });
});

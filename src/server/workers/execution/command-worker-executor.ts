import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isRetryableFailure,
  workerStructuredResultSchema,
  type WorkerExecutionOutcome,
  type WorkerProcessObservation,
  type WorkerStructuredResult,
  type WorkerTaskContract,
} from "@/core/contracts/worker-execution";
import {
  runNonInteractive,
  type NonInteractiveRunner,
} from "@/server/workers/process/run-process";
import {
  substituteArgs,
  type WorkerExecCommandResolver,
} from "./exec-command-config";
import { classifyWorkerFailure, type WorkerFailureConfig } from "./failure-classifier";
import { identityOf, type WorkerExecutorPort, type WorkerExecutionRequest } from "./worker-executor";
import { collectCommitEvidence } from "./writer-workspace";

/**
 * The REAL external worker launcher (M6.3).
 *
 * This is the file where ICOS stops simulating and starts a process that is an
 * autonomous agent. Everything here exists because of that.
 *
 * NO HUMAN IN THE LOOP, BY CONSTRUCTION
 * The task contract is injected two ways at once, because real CLIs disagree about
 * how they want it: as a JSON FILE whose path is passed in argv and env, and as a
 * composed PROMPT string. stdin stays closed (see run-process), so a worker that
 * tries to ask a question gets EOF and fails instead of hanging forever.
 *
 * THE CONTRACT FILE LIVES OUTSIDE THE WORKSPACE
 * Writing it into the worker's worktree would make it show up in `git status` and
 * become part of the "changed files" evidence — the observation would pollute the
 * thing being observed. It goes in its own temp directory, which is removed after
 * the run.
 *
 * EVIDENCE OVER CLAIMS
 * A worker's structured result is a CLAIM. Commit evidence is read from git in the
 * workspace afterwards, and both are recorded. When they disagree, git is what
 * happened.
 */

/**
 * Sentinel delimiting the worker's machine-readable verdict on stdout.
 *
 * A sentinel rather than "parse the whole of stdout as JSON" because a real agent
 * narrates: it prints progress, tool calls and warnings around its answer. The LAST
 * block wins, so a worker that retries internally and emits twice is read as having
 * concluded once.
 */
export const RESULT_SENTINEL_START = "<<<ICOS_RESULT>>>";
export const RESULT_SENTINEL_END = "<<<END_ICOS_RESULT>>>";

export const DEFAULT_EXECUTION_TIMEOUT_MS = 15 * 60_000;

export interface CommandWorkerExecutorOptions {
  defaultTimeoutMs?: number;
  failureConfig?: WorkerFailureConfig;
  run?: NonInteractiveRunner;
  /** Where the contract file is written. Defaults to the OS temp directory. */
  contractDir?: string;
}

/**
 * Composes the contract into one prompt.
 *
 * Structured, labelled and explicit about what is NOT finished. The `handoff` and
 * `unresolved` sections are what make a retry a CONTINUATION instead of a restart:
 * without them the next attempt cheerfully redoes work the previous one completed.
 */
export function composeWorkerPrompt(contract: WorkerTaskContract): string {
  const lines: string[] = [
    `# ICOS TASK ${contract.taskId} (attempt ${contract.attempt})`,
    "",
    "## Identity",
    `mission: ${contract.missionId}`,
    `missionTask: ${contract.missionTaskId}`,
    `task: ${contract.taskId}`,
    `workflow: ${contract.workflowId}`,
  ];

  /* Absent rather than faked: a mission with no goal is generic, not autonomous. */
  if (contract.goalId) lines.push(`goal: ${contract.goalId}`);
  if (contract.planId) lines.push(`plan: ${contract.planId}`);

  lines.push("", "## Objective", contract.objective, "", "## Instructions", contract.instructions);

  if (contract.successCriteria.length) {
    lines.push("", "## Success criteria");
    for (const criterion of contract.successCriteria) lines.push(`- ${criterion}`);
  }

  lines.push("", "## Workspace", contract.workspacePath);

  if (contract.allowedFileScope.length) {
    lines.push("", "## You may write ONLY these paths");
    for (const scope of contract.allowedFileScope) lines.push(`- ${scope}`);
  } else {
    lines.push("", "## READ-ONLY", "Do not modify any file.");
  }

  if (contract.handoff && Object.keys(contract.handoff).length > 0) {
    lines.push(
      "",
      "## CONTINUATION — a previous attempt already did work",
      "Continue it. Do not start over, and do not redo what is listed as done.",
      JSON.stringify(contract.handoff, null, 2),
    );
  }

  lines.push(
    "",
    "## Required final output",
    "End your output with exactly this block, and nothing after it:",
    RESULT_SENTINEL_START,
    JSON.stringify(
      {
        status: "succeeded",
        summary: "what you did",
        unresolved: [],
        testsRun: [],
      },
      null,
      2,
    ),
    RESULT_SENTINEL_END,
  );

  return lines.join("\n");
}

/**
 * Extracts the worker's verdict from stdout.
 *
 * Returns `undefined` when there is no sentinel at all — many workers legitimately
 * do not speak this protocol, and silence is not a violation. Returns an ERROR when
 * a sentinel IS present but its content is not a valid verdict: a worker that
 * claims to speak the protocol and does not is untrustworthy, and quietly ignoring
 * that would let a malformed failure read as a success.
 */
export function parseStructuredResult(
  stdout: string,
): { ok: true; value?: WorkerStructuredResult } | { ok: false; message: string } {
  const start = stdout.lastIndexOf(RESULT_SENTINEL_START);
  if (start === -1) return { ok: true, value: undefined };

  const from = start + RESULT_SENTINEL_START.length;
  const end = stdout.indexOf(RESULT_SENTINEL_END, from);
  const body = (end === -1 ? stdout.slice(from) : stdout.slice(from, end)).trim();

  if (end === -1) {
    /* Truncated mid-verdict: the run did not finish telling us what it did. */
    return { ok: false, message: "structured result block was never closed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return {
      ok: false,
      message: `structured result is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const result = workerStructuredResultSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, message: `structured result is invalid: ${result.error.message}` };
  }

  return { ok: true, value: result.data };
}

/** Environment injected into every worker. Identity, never secrets. */
export function contractEnv(
  contract: WorkerTaskContract,
  contractPath: string,
): Record<string, string> {
  const env: Record<string, string> = {
    ICOS_MISSION_ID: contract.missionId,
    ICOS_MISSION_TASK_ID: contract.missionTaskId,
    ICOS_TASK_ID: contract.taskId,
    ICOS_ATTEMPT: String(contract.attempt),
    ICOS_WORKFLOW_ID: contract.workflowId,
    ICOS_WORKSPACE: contract.workspacePath,
    ICOS_TASK_CONTRACT_PATH: contractPath,
    /* So a worker can emit the verdict without the prompt having to teach it. */
    ICOS_RESULT_SENTINEL_START: RESULT_SENTINEL_START,
    ICOS_RESULT_SENTINEL_END: RESULT_SENTINEL_END,
  };

  if (contract.goalId) env.ICOS_GOAL_ID = contract.goalId;
  if (contract.planId) env.ICOS_PLAN_ID = contract.planId;
  if (contract.resumeToken) env.ICOS_RESUME_TOKEN = contract.resumeToken;

  return env;
}

export class CommandWorkerExecutor implements WorkerExecutorPort {
  private readonly defaultTimeoutMs: number;
  private readonly run: NonInteractiveRunner;
  private readonly failureConfig: WorkerFailureConfig;

  constructor(
    private readonly resolve: WorkerExecCommandResolver,
    private readonly options: CommandWorkerExecutorOptions = {},
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.run = options.run ?? runNonInteractive;
    this.failureConfig = options.failureConfig ?? {};
  }

  async execute(request: WorkerExecutionRequest): Promise<WorkerExecutionOutcome> {
    const identity = identityOf(request.worker);
    const command = this.resolve(request.worker);

    if (!command) {
      return {
        ok: false,
        identity,
        failureClass: "PROVIDER_UNAVAILABLE",
        retryable: isRetryableFailure("PROVIDER_UNAVAILABLE"),
        message: `WORKER_EXEC_UNRESOLVED: no launch command configured for runtime '${request.worker.runtime}'`,
      };
    }

    const { contract, workspace } = request;
    const dir = await mkdtemp(join(this.options.contractDir ?? tmpdir(), "icos-contract-"));
    const contractPath = join(dir, "task-contract.json");
    const prompt = composeWorkerPrompt(contract);

    try {
      await writeFile(contractPath, JSON.stringify(contract, null, 2), "utf8");

      /* Resuming is a different invocation shape, not the same one with a flag. */
      const template =
        contract.resumeToken && command.resumeArgs ? command.resumeArgs : command.args;

      const args = substituteArgs(template, {
        prompt,
        contractPath,
        workspace: workspace.path,
        resumeToken: contract.resumeToken ?? undefined,
      });

      const result = await this.run({
        command: command.command,
        args,
        /* The worker runs IN its workspace. For a writer that is its own worktree. */
        cwd: workspace.path,
        env: contractEnv(contract, contractPath),
        timeoutMs: command.timeoutMs ?? this.defaultTimeoutMs,
      });

      const process: WorkerProcessObservation = {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      };

      const parsed = parseStructuredResult(result.stdout);

      /*
       * Evidence is collected WHATEVER the outcome. A failed or killed run may
       * still have committed work, and discarding that would make the next attempt
       * redo it — the opposite of resuming.
       */
      const evidence = await collectCommitEvidence(workspace, { run: this.run }).catch(
        () => undefined,
      );

      if (!parsed.ok) {
        /* Claimed the protocol, broke it. Not trustworthy enough to call success. */
        return {
          ok: false,
          identity,
          failureClass: "FAILED_RETRYABLE",
          retryable: isRetryableFailure("FAILED_RETRYABLE"),
          message: `WORKER_RESULT_MALFORMED: ${parsed.message}`,
          process,
          evidence,
        };
      }

      const structured = parsed.value;
      const successExit = command.successExitCodes ?? [0];
      const exitedWell = result.exitCode !== null && successExit.includes(result.exitCode);

      /*
       * BOTH must agree for a success: a clean exit code AND no failure verdict.
       * A worker that exits 0 while reporting `status: "failed"` has failed — the
       * exit code is the weaker signal, because an agent wrapper commonly exits 0
       * after reporting that it could not do the job.
       */
      if (exitedWell && structured?.status !== "failed") {
        return {
          ok: true,
          identity,
          process,
          structured,
          evidence,
          resumeToken: structured?.resumeToken,
        };
      }

      const classification = classifyWorkerFailure(
        { process, structured },
        this.failureConfig,
      );

      return {
        ok: false,
        identity,
        failureClass: classification.failureClass,
        retryable: classification.retryable,
        message: `${classification.failureClass}: ${classification.reason}`,
        process,
        structured,
        evidence,
        /* Carried forward so the NEXT attempt continues this same logical task. */
        resumeToken: structured?.resumeToken,
        handoff: structured?.handoff,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

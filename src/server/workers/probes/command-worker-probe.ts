import { spawn } from "node:child_process";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type {
  WorkerHealthObservation,
  WorkerHealthProbePort,
} from "@/server/services/worker-registry/worker-health-prober";

/**
 * A REAL worker health probe: it runs the worker's runtime, non-interactively,
 * and reports what actually happened (M6, defect 16).
 *
 * Everything before this was proven against fake adapters. This is the first
 * probe that touches the outside world, so it is where the outside world's
 * failure modes have to be handled honestly rather than optimistically.
 *
 * WHAT "NON-INTERACTIVE" MEANS HERE, CONCRETELY
 *   - stdin is `ignore`. A process that tries to prompt gets EOF immediately
 *     instead of blocking forever. This is not a detail: a probe that hangs
 *     waiting for a human holds a capacity slot and never yields a verdict, and
 *     a never-answered probe is indistinguishable from a healthy one unless the
 *     evidence expires (decision 0033).
 *   - there is ALWAYS a timeout, and it kills the process. A slow probe is a
 *     failed probe; we do not wait to find out.
 *   - no shell. The command and its arguments are passed as an argv array, so
 *     nothing in a worker's declaration can be interpolated into a shell.
 *
 * WHAT IT DOES NOT DECIDE
 * A Worker is an execution unit. This probe answers "can this worker's RUNTIME
 * execute here, right now" and nothing else. It does not choose a model, does not
 * authenticate a provider, does not check an account quota and does not reserve a
 * capacity slot — those are separate axes (decisions 0031, 0034) owned elsewhere.
 * Keeping the probe this narrow is what stops "health" from quietly becoming
 * "everything is configured correctly".
 *
 * NO PROVIDER, NO BINARY NAME, NO PATH IN THIS FILE
 * The command comes from an injected resolver. This file names no executable and
 * no provider; a deployment decides what "running" means for its runtimes. A
 * worker the resolver cannot map is NOT probed and NOT assumed fine: the adapter
 * throws, the prober records `failed`, and routing refuses the worker.
 */

/** One resolved, non-interactive command. No shell, argv only. */
export interface WorkerProbeCommand {
  command: string;
  args?: readonly string[];
  /** Milliseconds before the probe is killed and counted as failed. */
  timeoutMs?: number;
  /**
   * Exit codes that mean "healthy". Defaults to [0]. Some runtimes report
   * readiness with a non-zero code, so this is configuration, not a guess.
   */
  healthyExitCodes?: readonly number[];
}

/** Derives the probe command for one worker, or null when it cannot. */
export type WorkerProbeCommandResolver = (
  worker: WorkerRegistryEntry,
) => WorkerProbeCommand | null;

export interface CommandWorkerProbeOptions {
  /** Default timeout for a resolved command that does not set its own. */
  defaultTimeoutMs?: number;
  /** Injected for tests. Defaults to a real child process. */
  run?: CommandRunner;
}

export interface CommandRunResult {
  exitCode: number | null;
  /** True when the process was killed for exceeding the timeout. */
  timedOut: boolean;
  stderr: string;
}

export type CommandRunner = (
  command: WorkerProbeCommand,
  timeoutMs: number,
) => Promise<CommandRunResult>;

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export class CommandWorkerProbe implements WorkerHealthProbePort {
  private readonly defaultTimeoutMs: number;
  private readonly run: CommandRunner;

  constructor(
    private readonly resolve: WorkerProbeCommandResolver,
    options: CommandWorkerProbeOptions = {},
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.run = options.run ?? runCommand;
  }

  async probe(worker: WorkerRegistryEntry): Promise<WorkerHealthObservation> {
    const command = this.resolve(worker);

    if (!command) {
      /*
       * Throwing, rather than returning `unknown`, is deliberate. The prober
       * records a thrown probe as `failed` — an explicit, dated negative — while
       * `unknown` would look like "not looked at yet". A worker we are not
       * configured to verify is a configuration DEFECT that must be visible, not
       * a worker in an innocent initial state.
       */
      throw new Error(
        `WORKER_PROBE_UNRESOLVED: no probe command configured for worker ${worker.id} (runtime ${worker.runtime})`,
      );
    }

    const timeoutMs = command.timeoutMs ?? this.defaultTimeoutMs;
    const result = await this.run(command, timeoutMs);

    if (result.timedOut) {
      // A runtime that did not answer in time is unhealthy AND unavailable: we
      // have no evidence it can take work, and every reason to think it cannot.
      throw new Error(
        `WORKER_PROBE_TIMEOUT: ${command.command} did not answer within ${timeoutMs}ms`,
      );
    }

    const healthy = (command.healthyExitCodes ?? [0]).includes(result.exitCode ?? -1);

    if (!healthy) {
      throw new Error(
        `WORKER_PROBE_EXIT_${result.exitCode}: ${command.command}${
          result.stderr ? ` — ${firstLine(result.stderr)}` : ""
        }`,
      );
    }

    return { health: "healthy", availability: "available" };
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0]!.slice(0, 200);
}

/**
 * Runs one command with no stdin, no shell and a hard timeout.
 *
 * Never rejects: a spawn failure (missing executable, EACCES) is returned as a
 * non-zero exit so the caller has ONE shape to interpret. A probe helper that
 * both rejects and resolves is a probe helper with two failure paths, and one of
 * them always ends up unhandled.
 */
export const runCommand: CommandRunner = (command, timeoutMs) =>
  new Promise<CommandRunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stderr = "";

    const child = spawn(command.command, [...(command.args ?? [])], {
      // No stdin: nothing can block waiting for a human.
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, stderr });
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      // Bounded: a chatty runtime must not be able to grow this without limit.
      if (stderr.length < 4_096) stderr += chunk.toString("utf8");
    });

    child.on("error", (error: Error) => {
      stderr = stderr || error.message;
      finish(null);
    });

    child.on("close", (code) => finish(code));
  });

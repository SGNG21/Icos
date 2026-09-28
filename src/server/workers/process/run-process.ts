import { spawn } from "node:child_process";

/**
 * THE non-interactive process runner (M6.3).
 *
 * M6.1 established this discipline inside the health probe. M6.3 needs the same
 * guarantees for EXECUTION, so the implementation moved here rather than being
 * copied: two runners would drift, and the one that drifted would be the one that
 * forgot to close stdin.
 *
 * THE GUARANTEES, AND WHY EACH ONE IS LOAD-BEARING
 *   - stdin is `ignore`. A worker that tries to prompt gets EOF instead of
 *     blocking forever. A hang is worse than a failure: it holds a capacity slot
 *     and never yields a verdict, so it looks like work in progress indefinitely.
 *   - there is ALWAYS a timeout and it KILLS. SIGTERM first so a worker can flush
 *     a partial result, then SIGKILL if it ignores that.
 *   - no shell. argv only, so nothing in a worker declaration or a task contract
 *     can be interpolated into a shell command.
 *   - output is BOUNDED. A chatty worker must not be able to exhaust memory.
 *     Truncation is recorded, never silent.
 *   - it NEVER REJECTS. A spawn failure (missing executable, EACCES) comes back as
 *     a result with a null exit code, so callers have exactly one shape to
 *     interpret. A helper with two failure paths always has one that is unhandled.
 */

export interface NonInteractiveProcessSpec {
  /** Executable. Resolved by the OS, never expanded by a shell. */
  command: string;
  args?: readonly string[];
  /** Working directory. For a writer this is its ISOLATED workspace. */
  cwd?: string;
  /**
   * Variables overlaid on the inherited environment.
   *
   * Inheriting is required, not lazy: a real CLI worker needs HOME and PATH to
   * find its own configuration and credentials. The consequence is that the child
   * can see this process's secrets, so a worker command is as trusted as the
   * server — and neither the spec nor the captured output may ever be logged
   * wholesale.
   */
  env?: Record<string, string>;
  timeoutMs: number;
  /** Per-stream cap. Default 1 MiB. */
  maxOutputBytes?: number;
}

export interface NonInteractiveProcessResult {
  stdout: string;
  stderr: string;
  /** Null when the process never ran, or died by signal. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** True when either stream hit `maxOutputBytes`. Evidence, not a verdict. */
  truncated: boolean;
}

export type NonInteractiveRunner = (
  spec: NonInteractiveProcessSpec,
) => Promise<NonInteractiveProcessResult>;

export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
/** Grace between SIGTERM and SIGKILL: a chance to flush, not a chance to linger. */
export const KILL_GRACE_MS = 2_000;

export const runNonInteractive: NonInteractiveRunner = (spec) =>
  new Promise<NonInteractiveProcessResult>((resolve) => {
    const startedAt = Date.now();
    const limit = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(spec.command, [...(spec.args ?? [])], {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      // No stdin: nothing can block waiting for a human.
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      // Ask first, insist second: a worker may still flush a partial verdict.
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, spec.timeoutMs);

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated,
      });
    };

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= limit) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length <= limit) return next;
      truncated = true;
      return next.slice(0, limit);
    };

    child.stdout?.on("data", (chunk: Buffer) => void (stdout = append(stdout, chunk)));
    child.stderr?.on("data", (chunk: Buffer) => void (stderr = append(stderr, chunk)));

    child.on("error", (error: Error) => {
      // Spawn failure is a RESULT, not a rejection. One shape to interpret.
      stderr = stderr || error.message;
      finish(null, null);
    });

    child.on("close", (code, signal) => finish(code, signal ?? null));
  });

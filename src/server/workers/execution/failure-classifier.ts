import { z } from "zod";

import {
  isRetryableFailure,
  workerFailureClassSchema,
  type WorkerFailureClass,
  type WorkerProcessObservation,
  type WorkerStructuredResult,
} from "@/core/contracts/worker-execution";

/**
 * Turns "what the process did" into "what we should do about it" (M6.3).
 *
 * WHY THIS IS CONFIGURATION AND NOT CODE
 * Every signal that distinguishes "the provider is throttling us" from "this task
 * is impossible" arrives as a provider-shaped string on stderr. Hardcoding those
 * strings would put provider names into the core and make adding a provider a code
 * change — exactly what decision 0036 refused for probing. So the patterns are
 * DATA: a deployment declares, per failure class, the regexes that identify it.
 * This file names no provider, no product and no model.
 *
 * WHY THE DEFAULT IS RETRYABLE
 * An unrecognised non-zero exit becomes FAILED_RETRYABLE. That is not optimism:
 * retries are bounded by the task's attempt budget, so defaulting to retryable
 * risks a few wasted attempts, while defaulting to terminal risks ABANDONING
 * recoverable work permanently. Only an explicit verdict — from the worker itself
 * or from configuration — may declare something terminal.
 */

const patternListSchema = z.array(z.string().min(1)).nonempty();

/*
 * partialRecord, not record: an enum-keyed `z.record` is exhaustive in Zod 4 and
 * would demand patterns for every class. Declaring one class is the normal case.
 * An unknown key is still rejected, so a typo'd class name cannot silently
 * configure nothing.
 */
export const workerFailurePatternsSchema = z.partialRecord(
  workerFailureClassSchema,
  patternListSchema,
);

export type WorkerFailurePatterns = Partial<Record<WorkerFailureClass, string[]>>;

/** Exit code -> class, for runtimes that report a specific code per condition. */
export const workerExitCodeClassesSchema = z.record(
  z.string().regex(/^-?\d+$/, "an exit code"),
  workerFailureClassSchema,
);

export type WorkerExitCodeClasses = Record<string, WorkerFailureClass>;

export const workerFailureConfigSchema = z
  .object({
    patterns: workerFailurePatternsSchema.optional(),
    exitCodes: workerExitCodeClassesSchema.optional(),
  })
  .strict();

export type WorkerFailureConfig = z.infer<typeof workerFailureConfigSchema>;

/**
 * Parses the configured taxonomy. THROWS on malformed configuration.
 *
 * A silently ignored classification config means every failure degrades to the
 * catch-all: session exhaustion looks like a broken task, retries burn the budget,
 * and nothing says why. Refusing to boot is louder and kinder (same rule as
 * ICOS_WORKER_PROBE_COMMANDS in decision 0036).
 */
export function parseWorkerFailureConfig(raw?: string | null): WorkerFailureConfig {
  if (!raw || raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `WORKER_FAILURE_CONFIG_INVALID_JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = workerFailureConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`WORKER_FAILURE_CONFIG_INVALID: ${result.error.message}`);
  }

  /* Compile now, so a bad regex fails at boot and not mid-incident. */
  for (const [cls, patterns] of Object.entries(result.data.patterns ?? {})) {
    for (const pattern of patterns as string[]) {
      try {
        new RegExp(pattern, "i");
      } catch (error) {
        throw new Error(
          `WORKER_FAILURE_PATTERN_INVALID: ${cls} /${pattern}/ — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return result.data;
}

export interface ClassifyInput {
  process: WorkerProcessObservation;
  /** The worker's own report, when it produced one. */
  structured?: WorkerStructuredResult;
  /** True when this attempt no longer owns its execution lease. */
  leaseLost?: boolean;
}

export interface Classification {
  failureClass: WorkerFailureClass;
  retryable: boolean;
  /** Why this class was chosen. Durable, so a triage never has to guess. */
  reason: string;
}

/**
 * PRECEDENCE, highest first. The order is the decision.
 *
 * 1. LEASE LOST. If this runner no longer owns the attempt, nothing else it
 *    observed is authoritative — another runner may already have redone the work.
 * 2. THE WORKER'S OWN EXPLICIT CLASS. A worker that says "this is impossible"
 *    knows something no exit code conveys, and it is the only way to reach
 *    FAILED_TERMINAL without explicit configuration. A classless "I failed" does
 *    NOT belong here: it explains nothing, so it falls through to the recognisers.
 * 3. CONFIGURED EXIT CODE. Precise, deployment-declared.
 * 4. CONFIGURED PATTERNS, over stderr then stdout.
 * 5. TIMEOUT.
 * 6. SIGNAL.
 * 7. A classless failure verdict, then the catch-all.
 */
export function classifyWorkerFailure(
  input: ClassifyInput,
  config: WorkerFailureConfig = {},
): Classification {
  const decide = (failureClass: WorkerFailureClass, reason: string): Classification => ({
    failureClass,
    retryable: isRetryableFailure(failureClass),
    reason,
  });

  if (input.leaseLost) {
    return decide("LEASE_EXPIRED", "this runner no longer owns the attempt's execution lease");
  }

  /*
   * Only an EXPLICIT class from the worker outranks configuration. A worker that
   * merely said "I failed" has reached a verdict but explained nothing, so its
   * report must NOT short-circuit the recognisers below — the stderr it also
   * produced ("context window exceeded") is strictly more informative than the
   * catch-all, and discarding it would silently downgrade a diagnosable session
   * exhaustion into an anonymous retry.
   */
  const declared = input.structured?.status === "failed" ? input.structured.failureClass : undefined;
  if (declared) {
    return decide(declared, `the worker classified its own failure as ${declared}`);
  }

  const exitKey = String(input.process.exitCode);
  const byExit = config.exitCodes?.[exitKey];
  if (byExit && input.process.exitCode !== 0) {
    return decide(byExit, `configured classification for exit code ${exitKey}`);
  }

  for (const stream of ["stderr", "stdout"] as const) {
    const text = input.process[stream];
    if (!text) continue;
    for (const [cls, patterns] of Object.entries(config.patterns ?? {})) {
      for (const pattern of patterns as string[]) {
        if (new RegExp(pattern, "i").test(text)) {
          return decide(
            cls as WorkerFailureClass,
            `${stream} matched the configured /${pattern}/ pattern for ${cls}`,
          );
        }
      }
    }
  }

  if (input.process.timedOut) {
    /*
     * We killed it for exceeding its budget. What it had already written is unknown
     * (UNKNOWN_EFFECT, like STREAM_FAILED), but the CAUSE is known and it is not the
     * transport: the compute did not finish in time. Recording it as STREAM_FAILED — as
     * this did until decision 0054 — made self-build run 5's two budget timeouts
     * indistinguishable from a dropped connection, so nothing could route away from them.
     */
    return decide(
      "EXECUTION_TIMEOUT",
      `killed after exceeding its timeout (${input.process.durationMs}ms)`,
    );
  }

  if (input.process.signal) {
    return decide("WORKER_CRASHED", `died on signal ${input.process.signal}`);
  }

  if (input.process.exitCode === null) {
    /* Never started: a missing executable or EACCES. The task is untouched. */
    return decide("PROVIDER_UNAVAILABLE", "the worker process could not be started");
  }

  if (input.structured?.status === "failed") {
    /*
     * A verdict was reached and nothing recognised it. Still a real failure — the
     * worker ran and knows it did not succeed — but an unclassified one, so it stays
     * retryable rather than burning the task.
     */
    return decide("FAILED_RETRYABLE", "the worker reported failure with no classification");
  }

  return decide("FAILED_RETRYABLE", `exited ${input.process.exitCode} with no recognised signal`);
}

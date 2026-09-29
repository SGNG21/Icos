import { z } from "zod";

import {
  workerRuntimeDescriptorSchema,
  type WorkerRegistryEntry,
  type WorkerRuntimeDescriptor,
} from "@/core/contracts/worker-registry";

/**
 * Where WORKER LAUNCH COMMANDS come from (M6.3).
 *
 * A deployment declares, per RUNTIME, the non-interactive command that makes a
 * worker do work. Nothing here names an executable, a product, a model or a
 * provider — that is the whole point, and it is the same rule decision 0036 set
 * for probe commands. Adding Hermes, Codex or anything else is CONFIGURATION.
 *
 * THERE IS DELIBERATELY NO BUILT-IN DEFAULT.
 * The probe could default the `node` runtime to `process.execPath --version`,
 * because "can Node run" is answerable with no deployment knowledge. "Do this
 * task" is not: there is no universal way to ask a runtime to perform work. An
 * unconfigured runtime therefore gets NO adapter, and the executor reports
 * PROVIDER_UNAVAILABLE rather than inventing a command.
 */

/** Placeholders substituted into argv. Substitution is literal, never a shell. */
export const EXEC_PLACEHOLDERS = {
  /** The composed task contract, as one prompt string. */
  prompt: "{{prompt}}",
  /** Absolute path of the JSON task contract file. */
  contractPath: "{{contractPath}}",
  /** The worker's own prior session handle, when resuming. */
  resumeToken: "{{resumeToken}}",
  /** Absolute path of the isolated workspace. */
  workspace: "{{workspace}}",
  /**
   * The ROUTED candidate's model and provider (decision 0054), from its registration. This is
   * what makes a routing decision real: without it every worker on a runtime runs whatever the
   * CLI defaults to, and `metadata.model` is only a label.
   */
  model: "{{model}}",
  provider: "{{provider}}",
} as const;

const execCommandSchema = z
  .object({
    /** Executable, resolved by the OS. Never expanded by a shell. */
    command: z.string().min(1),
    /** argv, with placeholders. */
    args: z.array(z.string()).default([]),
    /**
     * Extra argv used INSTEAD of `args` when the attempt carries a resume token.
     * Separate because resuming is usually a different invocation shape, not the
     * same one with a flag appended.
     */
    resumeArgs: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
    /** Exit codes meaning success. Defaults to [0]. */
    successExitCodes: z.array(z.number().int()).nonempty().optional(),
  })
  .strict();

export type WorkerExecCommand = z.infer<typeof execCommandSchema>;

/*
 * partialRecord, not record: an enum-keyed `z.record` is exhaustive in Zod 4 and
 * would demand a command for every runtime. An unknown key is still rejected, so a
 * typo'd runtime cannot silently configure nothing.
 */
export const workerExecCommandsSchema = z.partialRecord(
  workerRuntimeDescriptorSchema,
  execCommandSchema,
);

export type WorkerExecCommands = Partial<Record<WorkerRuntimeDescriptor, WorkerExecCommand>>;

/**
 * Parses configured launch commands. THROWS on malformed configuration.
 *
 * Silently ignoring it would mean every worker reports "runtime unsupported", the
 * fleet accepts tasks and completes none, and nothing says why. Refusing to boot is
 * louder and kinder.
 */
export function parseWorkerExecCommands(raw?: string | null): WorkerExecCommands {
  if (!raw || raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `WORKER_EXEC_COMMANDS_INVALID_JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = workerExecCommandsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`WORKER_EXEC_COMMANDS_INVALID: ${result.error.message}`);
  }

  return result.data as WorkerExecCommands;
}

/** Resolves the launch command for one worker, or null when it cannot. */
export type WorkerExecCommandResolver = (
  worker: WorkerRegistryEntry,
) => WorkerExecCommand | null;

export function createWorkerExecResolver(
  configured: WorkerExecCommands,
): WorkerExecCommandResolver {
  return (worker) => configured[worker.runtime] ?? null;
}

/** The runtimes this process can actually execute work on. */
export function executableRuntimes(
  configured: WorkerExecCommands,
): WorkerRuntimeDescriptor[] {
  return (Object.keys(configured) as WorkerRuntimeDescriptor[]).sort();
}

/**
 * Literal placeholder substitution over argv.
 *
 * A placeholder whose value is absent yields an EMPTY string rather than being
 * left as `{{resumeToken}}`, because passing the literal text to a real CLI is a
 * confusing failure. Callers that must not pass an empty argument use
 * `resumeArgs` only when a token exists.
 */
export function substituteArgs(
  args: readonly string[],
  values: Partial<Record<keyof typeof EXEC_PLACEHOLDERS, string>>,
): string[] {
  return args.map((arg) => {
    let out = arg;
    for (const [key, token] of Object.entries(EXEC_PLACEHOLDERS)) {
      out = out.split(token).join(values[key as keyof typeof EXEC_PLACEHOLDERS] ?? "");
    }
    return out;
  });
}

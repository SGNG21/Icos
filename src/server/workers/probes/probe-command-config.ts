import { z } from "zod";

import {
  workerRuntimeDescriptorSchema,
  type WorkerRuntimeDescriptor,
} from "@/core/contracts/worker-registry";
import type {
  WorkerProbeCommand,
  WorkerProbeCommandResolver,
} from "./command-worker-probe";

/**
 * Where probe commands come from (M6, defect 16).
 *
 * A deployment declares, per RUNTIME, the non-interactive command that proves the
 * runtime can execute. Nothing here names an executable, a provider or a path:
 * that is the whole point. Adding a runtime is configuration; it is not a code
 * change, and it cannot become a list of provider names in the repository.
 *
 * Keyed by runtime rather than by worker kind because the runtime is what
 * determines HOW to check. Twenty worker kinds on one runtime need one entry.
 */

const probeCommandSchema = z.object({
  /** Executable, resolved by the OS. Run with no shell, so it is never expanded. */
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  healthyExitCodes: z.array(z.number().int()).nonempty().optional(),
});

/*
 * partialRecord, not record: an enum-keyed `z.record` in Zod 4 is EXHAUSTIVE, so
 * it would demand a command for every runtime and reject a configuration that
 * declares one. Declaring one runtime is the normal case.
 *
 * An unknown key is still rejected — a typo'd runtime name must not silently
 * configure nothing.
 */
export const workerProbeCommandsSchema = z.partialRecord(
  workerRuntimeDescriptorSchema,
  probeCommandSchema,
);

export type WorkerProbeCommands = Partial<Record<WorkerRuntimeDescriptor, WorkerProbeCommand>>;

/**
 * Parses the configured probe commands.
 *
 * THROWS on malformed configuration rather than falling back to "no commands".
 * A silently ignored probe configuration means nothing is ever probed, every
 * worker stays ineligible, and the whole fleet looks mysteriously idle — a
 * failure that is technically fail-closed and practically undiagnosable. Refusing
 * to boot is louder and kinder.
 */
export function parseWorkerProbeCommands(raw?: string | null): WorkerProbeCommands {
  if (!raw || raw.trim() === "") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `WORKER_PROBE_COMMANDS_INVALID_JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = workerProbeCommandsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`WORKER_PROBE_COMMANDS_INVALID: ${result.error.message}`);
  }

  return result.data as WorkerProbeCommands;
}

/**
 * The runtimes this process can actually probe.
 *
 * `node` is always included, and NOT as a hardwire: a worker declaring the `node`
 * runtime runs on the same runtime this server is running on, so "is Node
 * executable here" is answerable from `process.execPath` without naming any path
 * or product. Every other runtime must be configured — an unconfigured runtime
 * gets no adapter at all and is recorded `unsupported`, which is the honest
 * "we have no way to check this" verdict rather than a failure to check.
 */
export function probeableRuntimes(configured: WorkerProbeCommands): WorkerRuntimeDescriptor[] {
  const runtimes = new Set<WorkerRuntimeDescriptor>(["node"]);
  for (const runtime of Object.keys(configured) as WorkerRuntimeDescriptor[]) {
    runtimes.add(runtime);
  }
  return [...runtimes].sort();
}

/**
 * Builds the resolver the probe adapter uses.
 *
 * Configuration wins over the built-in `node` answer, so a deployment can always
 * override it. A runtime with neither is unresolvable, and the adapter treats that
 * as an explicit, dated failure — never as a pass.
 */
export function createWorkerProbeResolver(
  configured: WorkerProbeCommands,
): WorkerProbeCommandResolver {
  return (worker) => {
    const declared = configured[worker.runtime];
    if (declared) {
      /*
       * `{{model}}` / `{{provider}}` make the probe ask about THIS candidate's model, not just
       * whether the runtime starts (decision 0054): "Sonnet is unavailable" is per candidate.
       * A template that needs a value the worker does not declare is unresolvable — which the
       * prober records as a dated failure, never a pass.
       */
      const values: Record<string, string | undefined> = {
        "{{model}}": worker.metadata?.model,
        "{{provider}}": worker.metadata?.provider,
      };
      const args = declared.args ?? [];
      if (args.some((arg) => Object.entries(values).some(([k, v]) => arg.includes(k) && !v))) {
        return null;
      }
      return {
        ...declared,
        args: args.map((arg) =>
          Object.entries(values).reduce((out, [k, v]) => out.split(k).join(v ?? ""), arg),
        ),
      };
    }

    if (worker.runtime === "node") {
      // The runtime we are already executing in. No path, no product name.
      return { command: process.execPath, args: ["--version"] };
    }

    return null;
  };
}

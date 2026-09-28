import {
  runNonInteractive,
  type NonInteractiveRunner,
} from "@/server/workers/process/run-process";
import { plannerError, type PlannerCompletionProvider } from "./canonical-mission-planner";

/**
 * A LOCAL-PROCESS provider behind the canonical planner (M12).
 *
 * Compute, not planning. It launches a configured agent CLI non-interactively, hands it the
 * canonical planner's prompts and returns the raw text. It never parses, repairs or enriches
 * the answer, and it contains no goal, mission or plan semantics — all of that stays in
 * `CanonicalAutonomousMissionPlanner`, whichever provider is configured.
 *
 * NO PRODUCT, MODEL OR PROVIDER NAME IS COMMITTED HERE. The executable and its arguments come
 * from `ICOS_PLANNER_COMMAND`, exactly as worker probe and exec commands do (decisions
 * 0036/0038). A deployment chooses the binary and the model; the domain never learns either.
 *
 * NO SECRET IS HANDLED. The child inherits this process's environment so the CLI can find its
 * own configuration and credentials the way it normally does. Nothing reads, logs or persists
 * them, and no key is passed on the command line, where it would be visible in a process list.
 */

/** Substituted into argv. Literal, never shell-expanded. */
export const PLANNER_PLACEHOLDERS = {
  /** The full prompt: canonical system policy followed by the untrusted mission data. */
  prompt: "{{prompt}}",
} as const;

export interface CommandPlannerProviderOptions {
  command: string;
  args: readonly string[];
  /** Diagnostics only. Defaults to the executable's basename. */
  name?: string;
  timeoutMs: number;
  run?: NonInteractiveRunner;
}

export class CommandPlannerProvider implements PlannerCompletionProvider {
  readonly name: string;
  private readonly run: NonInteractiveRunner;

  constructor(private readonly options: CommandPlannerProviderOptions) {
    if (!options.command) throw plannerError("CONFIGURATION_INCOMPLETE");
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw plannerError("INVALID_TIMEOUT");
    }
    this.name = options.name ?? options.command.split("/").pop() ?? "command";
    this.run = options.run ?? runNonInteractive;
  }

  async complete(input: { system: string; user: string; signal: AbortSignal }): Promise<string> {
    /*
     * ONE prompt. A CLI agent has no system/user split, so the canonical policy is stated
     * first and the untrusted mission data second — the same ordering, and the same policy
     * text, the HTTP provider sends as two messages.
     */
    const prompt = `${input.system}\n\n${input.user}`;

    const args = this.options.args.map((arg) =>
      arg.split(PLANNER_PLACEHOLDERS.prompt).join(prompt),
    );

    const result = await this.run({
      command: this.options.command,
      args,
      timeoutMs: this.options.timeoutMs,
      /* A plan is small; a runaway agent must not be able to grow this without bound. */
      maxOutputBytes: 512 * 1024,
    });

    if (result.timedOut) throw plannerError("TIMEOUT");
    if (result.exitCode !== 0) {
      /*
       * The exit code only — never stderr. A planner failure message is persisted and
       * surfaced, and a CLI's stderr routinely contains paths, endpoints and key fragments.
       */
      throw plannerError(`PROVIDER_EXIT:${result.exitCode ?? "unknown"}`);
    }

    const content = result.stdout.trim();
    if (content.length === 0) throw plannerError("INVALID_RESPONSE");

    /*
     * Agent CLIs commonly wrap JSON in a markdown fence even when told not to. Stripping a
     * fence is TRANSPORT (undoing the CLI's own formatting), not interpretation: what is
     * inside is returned byte-for-byte, and a non-JSON answer still fails INVALID_OUTPUT in
     * the canonical planner.
     */
    return extractJsonObject(stripCodeFence(content));
  }
}

/**
 * Extracts the outermost JSON object from an agent's output.
 *
 * TRANSPORT NORMALISATION, not interpretation. A CLI agent narrates — "Here is the plan:" —
 * however firmly it is told not to, and the canonical planner requires exactly one JSON
 * object. Taking the outermost balanced object undoes the CLI's presentation and nothing
 * else: the bytes inside are returned untouched, and anything that is not a valid plan still
 * fails INVALID_OUTPUT at the canonical gate.
 *
 * Returns the input unchanged when no object is found, so the failure stays honest.
 */
export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) return text;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  /* Unbalanced: hand it back and let the canonical gate reject it. */
  return text;
}

/** Removes a single enclosing ``` fence, if present. Content is never otherwise altered. */
export function stripCodeFence(text: string): string {
  const fence = /^```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n?```$/;
  const match = fence.exec(text.trim());
  return match ? match[1]!.trim() : text;
}

const plannerCommandShape = {
  command: "a non-empty executable",
  args: "a non-empty argv array containing {{prompt}}",
};

/**
 * Parses a configured local-process planner backend.
 *
 * THROWS on malformed configuration. A silently ignored planner configuration means ICOS
 * accepts self-development work and can never plan it — the fleet looks idle for a reason
 * nothing states. Refusing to boot is louder and kinder (same rule as 0036/0038).
 */
export function parsePlannerCommand(
  raw?: string | null,
): { command: string; args: string[] } | undefined {
  if (!raw || raw.trim() === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw plannerError(
      `COMMAND_INVALID_JSON:${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  const record = parsed as { command?: unknown; args?: unknown };
  if (typeof record.command !== "string" || record.command.length === 0) {
    throw plannerError(`COMMAND_INVALID:command must be ${plannerCommandShape.command}`);
  }
  if (
    !Array.isArray(record.args) ||
    record.args.length === 0 ||
    !record.args.every((a) => typeof a === "string")
  ) {
    throw plannerError(`COMMAND_INVALID:args must be ${plannerCommandShape.args}`);
  }
  if (!record.args.some((a) => (a as string).includes(PLANNER_PLACEHOLDERS.prompt))) {
    /* Without the placeholder the agent would be launched with no prompt at all. */
    throw plannerError(`COMMAND_INVALID:args must contain ${PLANNER_PLACEHOLDERS.prompt}`);
  }

  return { command: record.command, args: record.args as string[] };
}

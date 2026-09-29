import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReviewDecision, RequestedChange, ReviewerProviderMetadata } from "@/core/contracts/review";
import { extractJsonObject, stripCodeFence } from "@/server/autonomy/command-planner-provider";
import {
  REVIEWER_ERROR_PREFIX,
  reviewerError,
  reviewerOutputSchema,
  reviewerSystemPrompt,
  reviewerUserPrompt,
} from "@/server/review/omniroute-reviewer";
import type { ReviewInput, ReviewerPort } from "@/server/review/ports";
import { runNonInteractive, type NonInteractiveRunner } from "@/server/workers/process/run-process";

/**
 * A LOCAL-PROCESS reviewer COMPUTE (M13), the exact counterpart of the command planner
 * provider M12 introduced.
 *
 * The review AUTHORITY is unchanged: the policy prompt, the decision vocabulary, the schema
 * and the error taxonomy are the canonical ones, imported rather than restated. What this
 * adds is a second way to answer them — a configured agent CLI instead of an HTTP endpoint.
 *
 * IT EXISTS BECAUSE FAIL-CLOSED IS NOT FREE. The PostgreSQL container REQUIRES an LLM
 * reviewer and refuses to boot without one, which is correct; but with only an HTTP backend,
 * a deployment with no OmniRoute endpoint could never review anything, so self-development
 * could never be approved by anyone. That is not safety, it is a dead end.
 *
 * NO PRODUCT, MODEL OR PROVIDER NAME IS COMMITTED HERE, and no secret is handled: the
 * executable and its argv come from `ICOS_REVIEWER_COMMAND`, and the child inherits this
 * process's environment so the CLI finds its own credentials the way it normally does.
 */

/** Substituted into argv. Literal, never shell-expanded. */
export const REVIEWER_PLACEHOLDERS = {
  /** The full prompt: canonical review policy followed by the untrusted review context. */
  prompt: "{{prompt}}",
  /** The ROUTED reviewer model/provider (decision 0054). */
  model: "{{model}}",
  provider: "{{provider}}",
} as const;

export interface CommandReviewerOptions {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  /**
   * Where the agent runs. Defaults to an EMPTY directory, deliberately.
   *
   * An agent CLI inherits the server's working directory unless told otherwise, and a
   * reviewer that can read the server's tree will read it — one real run refused a correct
   * change after looking for the worker's file in the wrong repository (defect 34). Its
   * verdict must depend on the review context and nothing else, and it has no business
   * reading whatever the server happens to be sitting in.
   */
  cwd?: string;
  run?: NonInteractiveRunner;
}

export class CommandReviewer implements ReviewerPort {
  private readonly run: NonInteractiveRunner;
  private readonly cwd: string;

  constructor(private readonly options: CommandReviewerOptions) {
    if (!options.command) throw reviewerError("CONFIGURATION_INCOMPLETE");
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw reviewerError("INVALID_TIMEOUT");
    }
    this.run = options.run ?? runNonInteractive;
    this.cwd = options.cwd ?? mkdtempSync(path.join(tmpdir(), "icos-review-"));
  }

  /**
   * How many times one review may be put to the agent.
   *
   * Same measured reason as the canonical planner's: a real model answers a `.strict()`
   * schema correctly most of the time and not every time, and a shape failure says nothing
   * about the change under review. Only shape failures are retried — a timeout, a non-zero
   * exit or an abort are conditions asking again cannot improve — and the verdict itself is
   * never retried, because a REQUEST_CHANGES is an answer, not a malfunction.
   */
  private static readonly MAX_ATTEMPTS = 3;

  async review(input: ReviewInput): Promise<{
    decision: ReviewDecision;
    reasons: string[];
    requestedChanges?: RequestedChange[];
    confidence?: number;
    providerMetadata: ReviewerProviderMetadata;
  }> {
    let lastShapeError: Error | undefined;
    for (let attempt = 1; attempt <= CommandReviewer.MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.reviewOnce(input);
      } catch (error) {
        const retryable =
          error instanceof Error &&
          (error.message === `${REVIEWER_ERROR_PREFIX}INVALID_OUTPUT` ||
            error.message === `${REVIEWER_ERROR_PREFIX}INVALID_RESPONSE`);
        if (!retryable) throw error;
        lastShapeError = error;
      }
    }
    throw lastShapeError;
  }

  private async reviewOnce(input: ReviewInput): Promise<{
    decision: ReviewDecision;
    reasons: string[];
    requestedChanges?: RequestedChange[];
    confidence?: number;
    providerMetadata: ReviewerProviderMetadata;
  }> {
    /*
     * ONE prompt. A CLI agent has no system/user split, so the canonical policy goes first
     * and the untrusted review context second — the same order, and the same text, the HTTP
     * reviewer sends as two messages.
     */
    const prompt = `${reviewerSystemPrompt()}\n\n${reviewerUserPrompt(input)}`;
    /*
     * A command that names `{{model}}` reviews on ROUTED compute only. With no routed reviewer
     * it would run with an empty model and the CLI's default — an unattributable review — so it
     * refuses, and QC parks the review as unavailable: no review, no integration.
     */
    const compute = input.reviewerCompute;
    const steers = this.options.args.some((arg) => arg.includes(REVIEWER_PLACEHOLDERS.model));
    if (steers && !compute?.model) throw reviewerError("COMPUTE_UNROUTED");
    const args = this.options.args.map((arg) =>
      arg
        .split(REVIEWER_PLACEHOLDERS.prompt)
        .join(prompt)
        .split(REVIEWER_PLACEHOLDERS.model)
        .join(compute?.model ?? "")
        .split(REVIEWER_PLACEHOLDERS.provider)
        .join(compute?.provider ?? ""),
    );

    let result;
    try {
      result = await this.run({
        command: this.options.command,
        args,
        cwd: this.cwd,
        timeoutMs: this.options.timeoutMs,
        /* A verdict is small; a runaway agent must not be able to grow this without bound. */
        maxOutputBytes: 512 * 1024,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(REVIEWER_ERROR_PREFIX)) throw error;
      if (input.signal?.aborted) throw reviewerError("ABORTED");
      throw reviewerError("PROVIDER_FAILURE");
    }

    if (result.timedOut) throw reviewerError("TIMEOUT");
    if (result.exitCode !== 0) {
      /*
       * The exit code only — never stderr. A reviewer failure message is persisted and
       * surfaced, and a CLI's stderr routinely contains paths, endpoints and key fragments.
       */
      throw reviewerError(`PROVIDER_EXIT:${result.exitCode ?? "unknown"}`);
    }

    const content = result.stdout.trim();
    if (content.length === 0) throw reviewerError("INVALID_RESPONSE");

    let candidate: unknown;
    try {
      /* Transport normalisation only: undo the CLI's fencing and narration, nothing else. */
      candidate = JSON.parse(extractJsonObject(stripCodeFence(content)));
    } catch {
      throw reviewerError("INVALID_OUTPUT");
    }

    const parsed = reviewerOutputSchema.safeParse(candidate);
    if (!parsed.success) throw reviewerError("INVALID_OUTPUT");

    return {
      ...parsed.data,
      /*
       * The model that ACTUALLY reviewed: the routed one only when the command steered it,
       * otherwise the deployment's binary — never a product name compiled in.
       */
      providerMetadata:
        steers && compute?.model
          ? {
              provider: compute.provider ?? "command",
              model: compute.model,
              temperature: 0,
              ...(compute.routing ? { routing: compute.routing } : {}),
            }
          : {
              provider: "command",
              model: this.options.command.split("/").pop() ?? "command",
              temperature: 0,
            },
    };
  }
}

const reviewerCommandShape = {
  command: "a non-empty executable",
  args: "a non-empty argv array containing {{prompt}}",
};

/**
 * Parses a configured local-process reviewer backend.
 *
 * THROWS on malformed configuration, for the same reason the planner does: a silently ignored
 * reviewer configuration means ICOS accepts work it can never review, and nothing says why.
 */
export function parseReviewerCommand(
  raw?: string | null,
): { command: string; args: string[] } | undefined {
  if (!raw || raw.trim() === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw reviewerError(
      `COMMAND_INVALID_JSON:${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  const record = parsed as { command?: unknown; args?: unknown };
  if (typeof record.command !== "string" || record.command.length === 0) {
    throw reviewerError(`COMMAND_INVALID:command must be ${reviewerCommandShape.command}`);
  }
  if (
    !Array.isArray(record.args) ||
    record.args.length === 0 ||
    !record.args.every((a) => typeof a === "string")
  ) {
    throw reviewerError(`COMMAND_INVALID:args must be ${reviewerCommandShape.args}`);
  }
  if (!record.args.some((a) => (a as string).includes(REVIEWER_PLACEHOLDERS.prompt))) {
    /* Without the placeholder the agent would be launched with no prompt at all. */
    throw reviewerError(`COMMAND_INVALID:args must contain ${REVIEWER_PLACEHOLDERS.prompt}`);
  }

  return { command: record.command, args: record.args as string[] };
}

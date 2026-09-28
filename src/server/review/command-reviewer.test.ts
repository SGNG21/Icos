import { describe, expect, it, vi } from "vitest";

import type { NonInteractiveProcessResult } from "@/server/workers/process/run-process";
import { CommandReviewer, parseReviewerCommand } from "./command-reviewer";
import { reviewerSystemPrompt } from "./omniroute-reviewer";
import type { ReviewInput } from "./ports";

const ran = (over: Partial<NonInteractiveProcessResult> = {}): NonInteractiveProcessResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 1,
  truncated: false,
  ...over,
});

const input = {
  mission: { id: "m1", title: "t", objective: "o", status: "running" },
  missionTask: { id: "mt1", missionId: "m1", title: "t", dependsOn: [], status: "running", taskId: "task-1" },
  task: { id: "task-1", title: "t", description: undefined },
  executionResult: { taskId: "task-1", workflowId: "wf-1", outcome: "success" },
  artifacts: [],
  evidence: [],
  findings: [],
} as unknown as ReviewInput;

const reviewer = (run: (spec: unknown) => Promise<NonInteractiveProcessResult>) =>
  new CommandReviewer({ command: "agent", args: ["-p", "{{prompt}}"], timeoutMs: 1000, run });

describe("CommandReviewer", () => {
  it("hands the CANONICAL review policy to the configured agent, as one prompt", async () => {
    const run = vi.fn(async (spec: { args?: readonly string[] }) => {
      const prompt = spec.args?.[1] ?? "";
      /* The canonical policy, not a restatement of it. */
      expect(prompt.startsWith(reviewerSystemPrompt())).toBe(true);
      expect(prompt).toContain("wf-1");
      return ran({ stdout: JSON.stringify({ decision: "APPROVE", reasons: ["ok"] }) });
    });

    const decision = await reviewer(run as never).review(input);

    expect(decision.decision).toBe("APPROVE");
    expect(decision.providerMetadata?.provider).toBe("command");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("DEFECT 34 — runs in an EMPTY directory, never the server's working tree", async () => {
    let seen: string | undefined;
    const run = vi.fn(async (spec: { cwd?: string }) => {
      seen = spec.cwd;
      return ran({ stdout: JSON.stringify({ decision: "APPROVE", reasons: ["ok"] }) });
    });

    await reviewer(run as never).review(input);

    /*
     * An agent CLI inherits the server's cwd unless told otherwise, and a reviewer that can
     * read the server's tree will read it: one real run refused a correct change after
     * looking for the worker's file in the wrong repository.
     */
    expect(seen).toBeDefined();
    expect(seen).not.toBe(process.cwd());
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(seen!)).toHaveLength(0);
  });

  it("DEFECT 34 — the canonical policy tells the reviewer it cannot see a repository", () => {
    const policy = reviewerSystemPrompt();
    expect(policy).toContain("Judge ONLY from the review context");
    expect(policy).toContain("never treat something you");
  });

  it("undoes the CLI's own formatting — a fence and narration are transport, not meaning", async () => {
    const decision = await reviewer(async () =>
      ran({
        stdout: 'Here is my review:\n```json\n{"decision":"APPROVE","reasons":["fine"]}\n```',
      }),
    ).review(input);

    expect(decision.decision).toBe("APPROVE");
  });

  it("FAILS CLOSED on a verdict that is not the canonical schema, after a BOUNDED retry", async () => {
    const run = vi.fn(async () => ran({ stdout: '{"decision":"LOOKS_GOOD","reasons":["x"]}' }));

    await expect(reviewer(run as never).review(input)).rejects.toThrow(
      "QUALITY_REVIEWER_INVALID_OUTPUT",
    );
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("RETRIES a malformed answer, and NEVER retries a verdict it dislikes", async () => {
    const shape = vi
      .fn()
      .mockResolvedValueOnce(ran({ stdout: "I think it is fine, honestly" }))
      .mockResolvedValueOnce(ran({ stdout: JSON.stringify({ decision: "APPROVE", reasons: ["ok"] }) }));
    await expect(reviewer(shape as never).review(input)).resolves.toMatchObject({
      decision: "APPROVE",
    });
    expect(shape).toHaveBeenCalledTimes(2);

    /* REQUEST_CHANGES is an ANSWER. Asking again until it says yes would not be a review. */
    const refusal = vi.fn(async () =>
      ran({
        stdout: JSON.stringify({
          decision: "REQUEST_CHANGES",
          reasons: ["no"],
          requestedChanges: [{ field: "f", reason: "r" }],
        }),
      }),
    );
    await expect(reviewer(refusal as never).review(input)).resolves.toMatchObject({
      decision: "REQUEST_CHANGES",
    });
    expect(refusal).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a timeout or a non-zero exit: asking again cannot help", async () => {
    const timeout = vi.fn(async () => ran({ timedOut: true }));
    await expect(reviewer(timeout as never).review(input)).rejects.toThrow("TIMEOUT");
    expect(timeout).toHaveBeenCalledTimes(1);

    const exited = vi.fn(async () => ran({ exitCode: 3 }));
    await expect(reviewer(exited as never).review(input)).rejects.toThrow("PROVIDER_EXIT:3");
    expect(exited).toHaveBeenCalledTimes(1);
  });

  it("FAILS CLOSED on timeout, empty output and a non-zero exit", async () => {
    await expect(reviewer(async () => ran({ timedOut: true })).review(input)).rejects.toThrow(
      "QUALITY_REVIEWER_TIMEOUT",
    );
    await expect(reviewer(async () => ran({ stdout: "  " })).review(input)).rejects.toThrow(
      "QUALITY_REVIEWER_INVALID_RESPONSE",
    );
    await expect(
      reviewer(async () => ran({ exitCode: 7, stderr: "key=sk-secret" })).review(input),
    ).rejects.toThrow("QUALITY_REVIEWER_PROVIDER_EXIT:7");
  });

  it("NEVER surfaces the agent's stderr: it routinely carries paths and key fragments", async () => {
    await expect(
      reviewer(async () => ran({ exitCode: 1, stderr: "Authorization: Bearer sk-live-abc" })).review(
        input,
      ),
    ).rejects.toThrow(/^QUALITY_REVIEWER_PROVIDER_EXIT:1$/);
  });

  it("refuses malformed configuration rather than silently reviewing nothing", () => {
    expect(parseReviewerCommand(undefined)).toBeUndefined();
    expect(() => parseReviewerCommand("{")).toThrow("QUALITY_REVIEWER_COMMAND_INVALID_JSON");
    expect(() => parseReviewerCommand(JSON.stringify({ command: "a", args: [] }))).toThrow(
      "QUALITY_REVIEWER_COMMAND_INVALID",
    );
    /* Without the placeholder the agent would be launched with no prompt at all. */
    expect(() => parseReviewerCommand(JSON.stringify({ command: "a", args: ["-p"] }))).toThrow(
      "{{prompt}}",
    );
    expect(parseReviewerCommand(JSON.stringify({ command: "a", args: ["{{prompt}}"] }))).toEqual({
      command: "a",
      args: ["{{prompt}}"],
    });
  });

  it("commits no product, model or provider name", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./command-reviewer.ts", import.meta.url), "utf8"),
    );
    for (const name of ["hermes", "claude", "gpt", "nemotron", "openai", "anthropic"]) {
      expect(source.toLowerCase()).not.toContain(name);
    }
  });
});

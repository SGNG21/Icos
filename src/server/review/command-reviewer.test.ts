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

  it("undoes the CLI's own formatting — a fence and narration are transport, not meaning", async () => {
    const decision = await reviewer(async () =>
      ran({
        stdout: 'Here is my review:\n```json\n{"decision":"APPROVE","reasons":["fine"]}\n```',
      }),
    ).review(input);

    expect(decision.decision).toBe("APPROVE");
  });

  it("FAILS CLOSED on a verdict that is not the canonical schema", async () => {
    await expect(
      reviewer(async () => ran({ stdout: '{"decision":"LOOKS_GOOD","reasons":["x"]}' })).review(
        input,
      ),
    ).rejects.toThrow("QUALITY_REVIEWER_INVALID_OUTPUT");
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

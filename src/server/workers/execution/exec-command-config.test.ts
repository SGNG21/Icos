import { describe, expect, it } from "vitest";

import { parseWorkerExecCommands } from "./exec-command-config";

const config = (args: string[], resumeArgs?: string[]) =>
  JSON.stringify({ node: { command: "agent-cli", args, ...(resumeArgs ? { resumeArgs } : {}) } });

describe("a launch command never hard-codes an OmniRoute meta-route (decision 0078 §3)", () => {
  it.each([
    [["--model", "auto/best-free", "{{prompt}}"]],
    [["-m", "auto"]],
    [["--model", "auto"]],
    [["--model=auto/coding:free"]],
    [["--model=auto"]],
    [["-m", "no-think/auto/best-free"]],
    [["run", "auto/best-free"]],
    [["run", "claude/combo/team"]],
    /* Whitespace normalised like the gateway (model.ts:401, :416-418). */
    [["--model", "openrouter/ auto"]],
    [["--model=cu/ auto"]],
    [["run", "openrouter /auto"]],
  ])("args %j are refused at parse, named", (args) => {
    expect(() => parseWorkerExecCommands(config(args))).toThrow(
      /WORKER_EXEC_COMMANDS_INVALID: [\s\S]*AUTO_COMBO_NOT_ADMISSIBLE: args\[/,
    );
  });

  it("resumeArgs are checked too", () => {
    expect(() =>
      parseWorkerExecCommands(config(["--model", "{{model}}"], ["--resume", "-m", "auto/x"])),
    ).toThrow(/AUTO_COMBO_NOT_ADMISSIBLE: resumeArgs\[2\]/);
  });

  it.each([
    [["--model", "{{model}}", "{{prompt}}"]],
    [["--model", "cc/claude-sonnet-5"]],
    [["--model=nvidia/nemotron-ultra"]],
    [["--color", "auto", "--model", "{{model}}"]],
    [["--mode", "autonomous/x", "x/auto/y"]],
  ])("args %j are accepted", (args) => {
    expect(parseWorkerExecCommands(config(args)).node?.args).toEqual(args);
  });
});

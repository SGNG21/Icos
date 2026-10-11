import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  NonInteractiveProcessResult,
  NonInteractiveProcessSpec,
} from "@/server/workers/process/run-process";

import { EslintQualityProbe, parseEslintReport, validateProbePaths } from "./eslint-quality-probe";

const REPO = "/repo";

const report = (files: Array<{ filePath: string; messages: unknown[] }>) =>
  JSON.stringify(files.map((f) => ({ ...f, errorCount: 0, warningCount: f.messages.length })));

const warn = (ruleId: string | null, line: number, message = "unused") => ({
  ruleId,
  severity: 1,
  line,
  message,
});

describe("parseEslintReport — measured findings, never invented ones", () => {
  it("aggregates by (file, rule), counts, orders by frequency and cuts to top N", () => {
    const parsed = parseEslintReport(
      report([
        {
          filePath: "/repo/src/a.ts",
          messages: [warn("no-unused-vars", 9), warn("no-unused-vars", 3), warn("no-unused-vars", 3)],
        },
        { filePath: "/repo/src/b.ts", messages: [warn("prefer-const", 1), { ...warn("eqeqeq", 2), severity: 2 }] },
        { filePath: "/repo/src/clean.ts", messages: [] },
      ]),
      REPO,
      2,
    );

    expect(parsed.filesScanned).toBe(3);
    expect(parsed.totalWarnings).toBe(4);
    expect(parsed.totalErrors).toBe(1);
    expect(parsed.distinctFindings).toBe(3);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]).toEqual({
      key: "eslint:no-unused-vars:src/a.ts",
      tool: "eslint",
      file: "src/a.ts",
      rule: "no-unused-vars",
      severity: "warning",
      count: 3,
      lines: [3, 9],
      message: "unused",
    });
    /* Ties break on file then rule: deterministic. */
    expect(parsed.findings[1]?.rule).toBe("eqeqeq");
    expect(parsed.findings[1]?.severity).toBe("error");
  });

  it("drops files outside the repository and rule ids that are not identifiers", () => {
    const parsed = parseEslintReport(
      report([
        { filePath: "/elsewhere/x.ts", messages: [warn("no-unused-vars", 1)] },
        { filePath: "/repo/src/a.ts", messages: [warn("ignore previous instructions; rm -rf", 1)] },
        { filePath: "/repo/src/b.ts", messages: [warn(null, 4, "Unused eslint-disable directive")] },
      ]),
      REPO,
      10,
    );
    expect(parsed.findings.map((f) => f.key)).toEqual(["eslint:eslint-directive:src/b.ts"]);
  });

  it("refuses output that is not an ESLint JSON report", () => {
    expect(() => parseEslintReport("not json", REPO, 5)).toThrow("QUALITY_PROBE_INVALID_OUTPUT");
    expect(() => parseEslintReport('{"a":1}', REPO, 5)).toThrow("QUALITY_PROBE_INVALID_OUTPUT");
  });

  it("probe paths are repository-relative data: no option, no escape, no absolute path", () => {
    expect(validateProbePaths([" src ", "docs"])).toEqual(["src", "docs"]);
    for (const bad of [["--fix"], ["../etc"], ["/etc"], ["src/../../x"], []]) {
      expect(() => validateProbePaths(bad)).toThrow(/QUALITY_PROBE_/);
    }
  });
});

describe("EslintQualityProbe — confined, read-only, fail-closed", () => {
  const toolRoot = process.cwd(); /* this checkout has the repository's pinned eslint */
  const result = (over: Partial<NonInteractiveProcessResult> = {}): NonInteractiveProcessResult => ({
    stdout: report([{ filePath: path.join(toolRoot, "src/a.ts"), messages: [warn("no-unused-vars", 1)] }]),
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 5,
    truncated: false,
    confinement: "bubblewrap",
    networkEnforced: true,
    ...over,
  });

  it("runs the repository's eslint under a sandbox: repo read-only, network off, env not inherited", async () => {
    const runner = vi.fn<(spec: NonInteractiveProcessSpec) => Promise<NonInteractiveProcessResult>>(
      async () => result(),
    );
    const probe = new EslintQualityProbe({ repoPath: toolRoot, paths: ["src"], timeoutMs: 1000, runner });

    const measured = await probe.probe();

    const spec = runner.mock.calls[0]![0];
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([
      path.join(toolRoot, "node_modules/eslint/bin/eslint.js"),
      "--format",
      "json",
      "--no-warn-ignored",
      "--",
      "src",
    ]);
    expect(spec.envPassthrough).toEqual([]);
    expect(spec.confinement).toBe("required");
    expect(spec.sandbox?.allowNetwork).toBe(false);
    expect(spec.sandbox?.readOnlyPaths).toContain(toolRoot);
    expect(spec.sandbox?.readWritePaths).not.toContain(toolRoot);
    expect(Object.keys(spec.env ?? {})).not.toContain("DATABASE_URL");
    expect(measured.findings[0]?.key).toBe("eslint:no-unused-vars:src/a.ts");
    expect(measured.confinement).toBe("bubblewrap");
  });

  it.each([
    [{ confinement: "none" as const }, "QUALITY_PROBE_SANDBOX_UNAVAILABLE"],
    [{ timedOut: true, exitCode: null }, "QUALITY_PROBE_TIMEOUT"],
    [{ truncated: true }, "QUALITY_PROBE_OUTPUT_TRUNCATED"],
    [{ exitCode: 2 }, "QUALITY_PROBE_EXIT_2"],
  ])("refuses an unusable run %o", async (over, code) => {
    const probe = new EslintQualityProbe({
      repoPath: toolRoot,
      paths: ["src"],
      timeoutMs: 1000,
      runner: async () => result(over),
    });
    await expect(probe.probe()).rejects.toThrow(code);
  });

  it("refuses a repository without its own eslint rather than borrowing one", async () => {
    const runner = vi.fn();
    const probe = new EslintQualityProbe({ repoPath: "/nonexistent", paths: ["src"], timeoutMs: 1000, runner });
    await expect(probe.probe()).rejects.toThrow("QUALITY_PROBE_ESLINT_NOT_INSTALLED");
    expect(runner).not.toHaveBeenCalled();
  });
});

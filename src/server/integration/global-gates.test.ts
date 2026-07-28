import { describe, expect, it, vi } from "vitest";

import { GlobalGates } from "./global-gates";
import type { GlobalGatesPort } from "./ports";

// ─────────────────────────────────────────────────────────────
// Typed accessor for the injectable process-runner seam.
// `run` is protected: spying through this typed shim (rather than
// `as any`) keeps the tests type-checked, mirroring the pattern used
// in integration-orchestrator.test.ts.
// ─────────────────────────────────────────────────────────────

interface RunnableGates {
  run(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }>;
}

function runnable(gates: GlobalGates): RunnableGates {
  return gates as unknown as RunnableGates;
}

/** Emule le rejet de promisify(execFile) sur exit non-zero. */
function execFailure(message: string): Error {
  return new Error(message);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const WS = "/tmp/workspace";

describe("GlobalGates — structured exit status is authoritative", () => {
  // 1. exit 0 + stderr containing "error" → PASS
  it("passes a gate that exits 0 even when stderr contains the word 'error'", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockResolvedValue({
      stdout: "",
      stderr: "Deprecation: 3 errors were downgraded to warnings",
    });

    const result = await gates.executeGate("test", WS);

    expect(result.passed).toBe(true);
    expect(result.gate).toBe("test");
    expect(result.errors).toEqual([]);
  });

  // 2. exit 0 + stdout containing "failed" → PASS
  it("passes a gate that exits 0 even when stdout contains the word 'failed'", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockResolvedValue({
      stdout: "0 failed, 1220 passed",
      stderr: "",
    });

    const result = await gates.executeGate("test", WS);

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // 3. exit 0 + output containing "FAIL" → PASS
  it("passes a gate that exits 0 even when output contains 'FAIL'", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockResolvedValue({
      stdout: "FAIL is the documented label for an unsuccessful check",
      stderr: "",
    });

    const result = await gates.executeGate("test", WS);

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // 4. non-zero exit → FAIL
  it("fails a gate when the command exits non-zero", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockRejectedValue(execFailure("Command failed: pnpm test"));

    const result = await gates.executeGate("test", WS);

    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // 5. actual test failure → FAIL
  it("fails the test gate on a real test failure (non-zero exit)", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockRejectedValue(
      execFailure(
        "Command failed: pnpm test\n\n FAIL src/foo.test.ts > does a thing\n expected 1 to be 2",
      ),
    );

    const result = await gates.executeGate("test", WS);

    expect(result.passed).toBe(false);
  });

  // 6. actual typecheck failure → FAIL
  it("fails the typecheck gate on a real typecheck failure (non-zero exit)", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockRejectedValue(
      execFailure("Command failed: pnpm typecheck\nsrc/x.ts(3,1): error TS2322"),
    );

    const result = await gates.executeGate("typecheck", WS);

    expect(result.passed).toBe(false);
  });

  // 7. no false FAIL from diagnostic strings — combined stdout+stderr noise
  it("does not fail on diagnostic 'error'/'failed' strings when exit is 0", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockResolvedValue({
      stdout: "Build error boundary compiled. 0 failed.",
      stderr: "warning: something error-like",
    });

    const result = await gates.executeGate("build", WS);

    expect(result.passed).toBe(true);
  });

  // 8. exceptions fail closed (spawn error, not a test failure)
  it("fails closed when the runner throws a non-exec error (ENOENT)", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockRejectedValue(execFailure("spawn pnpm ENOENT"));

    const result = await gates.executeGate("lint", WS);

    expect(result.passed).toBe(false);
    expect(result.errors[0]).toContain("ENOENT");
  });

  // 9. timeouts fail closed
  it("fails closed when the command times out", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockRejectedValue(
      execFailure("Command timed out after 120000ms: pnpm test"),
    );

    const result = await gates.executeGate("test", WS);

    expect(result.passed).toBe(false);
    expect(result.errors[0]).toContain("timed out");
  });
});

describe("GlobalGates.gitDiffCheck — exit status authoritative", () => {
  it("passes when git diff --check exits 0 (clean)", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockResolvedValue({ stdout: "", stderr: "" });

    const result = await gates.gitDiffCheck(WS);

    expect(result.gate).toBe("git-diff-check");
    expect(result.passed).toBe(true);
  });

  it("fails when git diff --check exits non-zero (whitespace/conflict)", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockRejectedValue(
      execFailure("Command failed: git diff --check\nsrc/a.ts:3: trailing whitespace."),
    );

    const result = await gates.gitDiffCheck(WS);

    expect(result.passed).toBe(false);
  });
});

describe("GlobalGates.executeAll — deterministic ordering & sequencing", () => {
  // 10. deterministic ordering + bounded (sequential) concurrency
  it("runs gates sequentially in a fixed order (max concurrency = 1)", async () => {
    const gates = new GlobalGates();
    const startOrder: string[] = [];
    let active = 0;
    let maxActive = 0;
    const calls = Array.from({ length: 5 }, () => ({
      started: deferred(),
      release: deferred(),
    }));
    let callIndex = 0;

    vi.spyOn(runnable(gates), "run").mockImplementation(async (command: string, args: string[]) => {
      const call = calls[callIndex++];
      // Identify the gate from the invocation.
      const label = command === "git" ? "git-diff-check" : args[0];
      startOrder.push(label);
      active += 1;
      maxActive = Math.max(maxActive, active);
      call.started.resolve();
      await call.release.promise;
      active -= 1;
      return { stdout: "", stderr: "" };
    });

    const execution = gates.executeAll(WS);
    for (const call of calls) {
      await call.started.promise;
      expect(active).toBe(1);
      call.release.resolve();
    }
    const results = await execution;

    expect(startOrder).toEqual(["git-diff-check", "lint", "typecheck", "test", "build"]);
    expect(maxActive).toBe(1);
    expect(results.map((r) => r.gate)).toEqual([
      "git-diff-check",
      "lint",
      "typecheck",
      "test",
      "build",
    ]);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  // 11. no false PASS — a genuine failing gate fails the whole set
  it("reports a failing gate without short-circuiting the rest (all 5 reported)", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockImplementation(async (command: string, args: string[]) => {
      const label = command === "git" ? "git-diff-check" : args[0];
      if (label === "test") {
        throw execFailure("Command failed: pnpm test");
      }
      return { stdout: "", stderr: "" };
    });

    const results = await gates.executeAll(WS);

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.passed)).toBe(false);
    expect(results.find((r) => r.gate === "test")!.passed).toBe(false);
    // Gates other than the failing one still pass.
    expect(results.filter((r) => r.passed).map((r) => r.gate)).toEqual([
      "git-diff-check",
      "lint",
      "typecheck",
      "build",
    ]);
  });

  // 12. repeated green executions remain green
  it("stays green across repeated executions (no nondeterminism)", async () => {
    const gates = new GlobalGates();
    vi.spyOn(runnable(gates), "run").mockResolvedValue({ stdout: "", stderr: "" });

    for (let i = 0; i < 5; i++) {
      const results = await gates.executeAll(WS);
      expect(results.every((r) => r.passed)).toBe(true);
    }
  });
});

describe("GlobalGates — public port compatibility", () => {
  it("remains assignable to GlobalGatesPort", () => {
    const port: GlobalGatesPort = new GlobalGates();

    expect(typeof port.executeAll).toBe("function");
    expect(typeof port.executeGate).toBe("function");
    expect(typeof port.gitDiffCheck).toBe("function");
  });
});

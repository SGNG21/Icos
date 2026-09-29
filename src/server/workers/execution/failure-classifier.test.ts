import { describe, expect, it } from "vitest";

import {
  WORKER_FAILURE_RETRYABLE,
  isRetryableFailure,
  toExecutionErrorCode,
  workerFailureClassSchema,
  type WorkerProcessObservation,
} from "@/core/contracts/worker-execution";
import { classifyWorkerFailure, parseWorkerFailureConfig } from "./failure-classifier";
import { identityOf } from "./worker-executor";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";

/*
 * M6.3 FAILURE TAXONOMY.
 *
 * The taxonomy only earns its existence if each class implies a DIFFERENT correct
 * response. These pin the classes, their retryability, their precedence, and the
 * single mapping to the coarse business error code.
 */

const proc = (over: Partial<WorkerProcessObservation> = {}): WorkerProcessObservation => ({
  stdout: "",
  stderr: "",
  exitCode: 1,
  signal: null,
  timedOut: false,
  durationMs: 10,
  ...over,
});

/* A realistic deployment config. Provider-shaped strings live HERE, never in code. */
const config = parseWorkerFailureConfig(
  JSON.stringify({
    patterns: {
      SESSION_EXHAUSTED: ["context (window|length) exceeded", "session limit reached"],
      RATE_LIMITED: ["rate limit", "429"],
      PROVIDER_UNAVAILABLE: ["service unavailable", "503", "connection refused"],
      STREAM_FAILED: ["stream (closed|interrupted)"],
    },
    exitCodes: { "17": "FAILED_TERMINAL" },
  }),
);

describe("M6.3 worker failure taxonomy", () => {
  it("ALL REQUIRED CLASSES EXIST (M6.3 eight + decision 0054 three)", () => {
    expect(workerFailureClassSchema.options).toEqual([
      "SESSION_EXHAUSTED",
      "PROVIDER_UNAVAILABLE",
      "RATE_LIMITED",
      "STREAM_FAILED",
      "WORKER_CRASHED",
      "EXECUTION_TIMEOUT",
      "AUTH_FAILURE",
      "MODEL_UNAVAILABLE",
      "LEASE_EXPIRED",
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
    ]);
  });

  it("RETRYABILITY IS EXHAUSTIVE and FAILED_TERMINAL is the only terminal class", () => {
    /*
     * An exhaustive record rather than a function with a default: a new class cannot
     * be added without a deliberate answer, because silently defaulting to retryable
     * is how an impossible task burns its whole attempt budget.
     */
    for (const cls of workerFailureClassSchema.options) {
      expect(WORKER_FAILURE_RETRYABLE[cls]).toBeTypeOf("boolean");
    }
    const terminal = workerFailureClassSchema.options.filter((c) => !isRetryableFailure(c));
    expect(terminal).toEqual(["FAILED_TERMINAL"]);
  });

  it("THE MAPPING TO THE BUSINESS CODE IS TOTAL and never invents success", () => {
    for (const cls of workerFailureClassSchema.options) {
      const code = toExecutionErrorCode(cls);
      expect(code).toBeTruthy();
      // A failure must never map to something a reader could read as fine.
      expect(code).not.toBe("CANCELLED");
    }
  });

  it("A PARTIALLY-DONE RUN maps to the fail-closed UNKNOWN_EFFECT", () => {
    /*
     * These three tell us nothing about what landed on disk. Calling them
     * WORKER_FAILED would assert more than we know.
     */
    expect(toExecutionErrorCode("STREAM_FAILED")).toBe("UNKNOWN_EFFECT");
    expect(toExecutionErrorCode("LEASE_EXPIRED")).toBe("UNKNOWN_EFFECT");
    expect(toExecutionErrorCode("WORKER_CRASHED")).toBe("UNKNOWN_EFFECT");
    // Whereas a reached verdict is a real, attributable task failure.
    expect(toExecutionErrorCode("FAILED_TERMINAL")).toBe("WORKER_FAILED");
    // And these never ran at all, so the task is untouched.
    expect(toExecutionErrorCode("RATE_LIMITED")).toBe("WORKER_UNAVAILABLE");
    expect(toExecutionErrorCode("SESSION_EXHAUSTED")).toBe("WORKER_UNAVAILABLE");
  });

  it("SESSION_EXHAUSTION is recognised from the worker's output and stays RETRYABLE", () => {
    const result = classifyWorkerFailure(
      { process: proc({ stderr: "Error: context window exceeded for this session" }) },
      config,
    );
    expect(result.failureClass).toBe("SESSION_EXHAUSTED");
    // The whole point: a NEW session can continue the same logical task.
    expect(result.retryable).toBe(true);
    expect(result.reason).toContain("stderr matched");
  });

  it("SESSION_EXHAUSTION is also recognised when the worker reports it ITSELF", () => {
    const result = classifyWorkerFailure({
      process: proc({ exitCode: 0 }),
      structured: { status: "failed", failureClass: "SESSION_EXHAUSTED" },
    });
    expect(result.failureClass).toBe("SESSION_EXHAUSTED");
    expect(result.reason).toContain("the worker classified its own failure");
  });

  it("RATE_LIMITED and PROVIDER_UNAVAILABLE are distinguished from each other", () => {
    expect(
      classifyWorkerFailure({ process: proc({ stderr: "HTTP 429 rate limit" }) }, config)
        .failureClass,
    ).toBe("RATE_LIMITED");
    expect(
      classifyWorkerFailure({ process: proc({ stderr: "503 service unavailable" }) }, config)
        .failureClass,
    ).toBe("PROVIDER_UNAVAILABLE");
  });

  it("A CONFIGURED EXIT CODE can declare a TERMINAL failure", () => {
    const result = classifyWorkerFailure({ process: proc({ exitCode: 17 }) }, config);
    expect(result.failureClass).toBe("FAILED_TERMINAL");
    expect(result.retryable).toBe(false);
  });

  it("EXIT CODE 0 IS NEVER CLASSIFIED BY THE EXIT MAP", () => {
    /* Otherwise a config typo mapping "0" would turn every success into a failure. */
    const withZero = parseWorkerFailureConfig(
      JSON.stringify({ exitCodes: { "0": "FAILED_TERMINAL" } }),
    );
    expect(classifyWorkerFailure({ process: proc({ exitCode: 0 }) }, withZero).failureClass).toBe(
      "FAILED_RETRYABLE",
    );
  });

  it("THE LEASE OUTRANKS EVERYTHING: a fenced run is LEASE_EXPIRED whatever it observed", () => {
    /*
     * If we no longer own the attempt, nothing this runner saw is authoritative —
     * another runner may already have redone the work.
     */
    const result = classifyWorkerFailure(
      {
        process: proc({ exitCode: 0, stderr: "rate limit" }),
        structured: { status: "failed", failureClass: "FAILED_TERMINAL" },
        leaseLost: true,
      },
      config,
    );
    expect(result.failureClass).toBe("LEASE_EXPIRED");
    expect(result.retryable).toBe(true);
  });

  it("A CLASSLESS 'I failed' DOES NOT HIDE a recognisable cause", () => {
    /*
     * REGRESSION. The first version short-circuited on any `status: "failed"`, so a
     * worker that reported failure without a class AND printed "context window
     * exceeded" was filed as an anonymous FAILED_RETRYABLE. The diagnosable cause was
     * discarded in favour of the catch-all — found by the end-to-end run, not by a
     * unit test, because only the real worker produced both signals at once.
     */
    const result = classifyWorkerFailure(
      {
        process: proc({ stderr: "context window exceeded", exitCode: 1 }),
        structured: { status: "failed", summary: "ran out of room" },
      },
      config,
    );

    expect(result.failureClass).toBe("SESSION_EXHAUSTED");
    expect(result.reason).toContain("stderr matched");
  });

  it("A CLASSLESS FAILURE with nothing recognisable is still a real, retryable failure", () => {
    const result = classifyWorkerFailure(
      { process: proc({ exitCode: 0 }), structured: { status: "failed" } },
      config,
    );
    expect(result.failureClass).toBe("FAILED_RETRYABLE");
    expect(result.reason).toContain("no classification");
  });

  it("THE WORKER'S OWN VERDICT outranks a configured pattern", () => {
    const result = classifyWorkerFailure(
      {
        process: proc({ stderr: "rate limit" }),
        structured: { status: "failed", failureClass: "FAILED_TERMINAL" },
      },
      config,
    );
    // Only an explicit verdict may reach TERMINAL; it knows what no pattern conveys.
    expect(result.failureClass).toBe("FAILED_TERMINAL");
  });

  it("STDERR outranks STDOUT, because an agent narrates on stdout", () => {
    const result = classifyWorkerFailure(
      { process: proc({ stdout: "rate limit", stderr: "connection refused" }) },
      config,
    );
    expect(result.failureClass).toBe("PROVIDER_UNAVAILABLE");
  });

  it("A SIGNAL DEATH is a crash; a NEVER-STARTED process is not the task's fault", () => {
    expect(
      classifyWorkerFailure({ process: proc({ exitCode: null, signal: "SIGKILL" }) }).failureClass,
    ).toBe("WORKER_CRASHED");
    expect(classifyWorkerFailure({ process: proc({ exitCode: null }) }).failureClass).toBe(
      "PROVIDER_UNAVAILABLE",
    );
  });

  it("AN UNRECOGNISED FAILURE STAYS RETRYABLE rather than abandoning the work", () => {
    const result = classifyWorkerFailure({ process: proc({ exitCode: 99 }) }, config);
    expect(result.failureClass).toBe("FAILED_RETRYABLE");
    expect(result.retryable).toBe(true);
  });

  it("MALFORMED CONFIGURATION REFUSES TO LOAD rather than classifying nothing", () => {
    expect(() => parseWorkerFailureConfig("{not json")).toThrow(/INVALID_JSON/);
    expect(() => parseWorkerFailureConfig(JSON.stringify({ patterns: { NOPE: ["x"] } }))).toThrow(
      /INVALID/,
    );
    // A bad regex must fail at boot, not mid-incident.
    expect(() =>
      parseWorkerFailureConfig(JSON.stringify({ patterns: { RATE_LIMITED: ["(unclosed"] } })),
    ).toThrow(/PATTERN_INVALID/);
    // Absent configuration is legitimate: the catch-all still works.
    expect(parseWorkerFailureConfig(undefined)).toEqual({});
  });
});

describe("M6.3 identity axes", () => {
  const entry = (over: Partial<WorkerRegistryEntry> = {}): WorkerRegistryEntry =>
    ({
      id: "w-1",
      workerKind: "agent",
      displayName: "w",
      capabilities: [],
      features: [],
      supportsTools: false,
      supportsStructuredOutput: false,
      status: "active",
      runtime: "binary",
      runtimeSupport: "SUPPORTED_RUNTIME",
      health: "healthy",
      availability: "available",
      tags: [],
      metadata: {},
      maxConcurrency: 1,
      updatedAt: new Date(),
      ...over,
    }) as WorkerRegistryEntry;

  it("WORKER, RUNTIME, MODEL, PROVIDER, ACCOUNT and CAPACITY SLOT stay SIX DISTINCT values", () => {
    const identity = identityOf(
      entry({
        id: "worker-77",
        runtime: "binary",
        metadata: { model: "some-model", provider: "some-provider", account: "acct-3" },
        capacityPool: "pool-a",
      } as Partial<WorkerRegistryEntry>),
    );

    /*
     * Collapsing these is what makes "the account's quota is gone" indistinguishable
     * from "the worker is broken" — and the correct responses are opposite.
     */
    expect(identity).toEqual({
      workerId: "worker-77",
      runtime: "binary",
      model: "some-model",
      provider: "some-provider",
      account: "acct-3",
      capacitySlot: "pool-a",
    });
  });

  it("UNDECLARED AXES ARE ABSENT, never guessed from the worker kind", () => {
    const identity = identityOf(entry({ workerKind: "hermes" } as Partial<WorkerRegistryEntry>));
    // The kind says what the worker is FOR; it is not evidence of a provider.
    expect(identity.provider).toBeUndefined();
    expect(identity.model).toBeUndefined();
    expect(identity.account).toBeUndefined();
    expect(identity.capacitySlot).toBeUndefined();
  });

  it("THE CAPACITY SLOT comes from the registry's own capacity concept", () => {
    expect(identityOf(entry({ capacityPool: "shared-quota" })).capacitySlot).toBe("shared-quota");
  });
});

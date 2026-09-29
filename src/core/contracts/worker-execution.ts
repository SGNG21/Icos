import { z } from "zod";

import { workerRuntimeDescriptorSchema } from "./worker-registry";
import type { ExecutionErrorCode } from "./task-execution";

/**
 * The EXECUTION-LAYER contract for external workers (M6.3).
 *
 * WHY THIS IS NOT `task-execution.ts`
 * `task-execution.ts` is the BUSINESS PROOF, exposed to the Cockpit, and it says
 * so: coarse outcome, normalised error, never an internal trace. That contract is
 * right and is not widened here.
 *
 * What an executor needs is a different thing: an operational taxonomy fine enough
 * to DECIDE WHETHER TO RETRY. "The provider is rate-limiting us" and "the task is
 * impossible" are both `WORKER_FAILED` to the business record, and conflating them
 * is the difference between a task that completes on the next tick and a task
 * abandoned forever. So there are two layers, with ONE deterministic mapping
 * between them (`toExecutionErrorCode`) — not two competing vocabularies.
 */

/**
 * The SIX DISTINCT IDENTITY AXES of an execution.
 *
 * These are deliberately separate fields and must never be collapsed into one
 * "worker" string. The reason is operational, not aesthetic: when a run fails
 * because an ACCOUNT's quota is gone, the WORKER is fine, the RUNTIME is fine and
 * the MODEL is fine — retrying on the same worker with a different account is
 * correct, and retrying the whole task elsewhere is waste. A single opaque
 * identity makes that distinction unrepresentable.
 *
 * Worker != Runtime != Model != Provider != Account != CapacitySlot.
 */
export const workerIdentitySchema = z
  .object({
    /** WHO executed: the registry's worker id. An execution unit, nothing more. */
    workerId: z.string().min(1),
    /** HOW it is executed. Determines which adapter applies (decision 0036). */
    runtime: workerRuntimeDescriptorSchema,
    /** WHAT reasoned, if the worker reports it. Opaque; never matched on. */
    model: z.string().min(1).optional(),
    /** WHOSE service served it. Opaque: no provider name is branched on. */
    provider: z.string().min(1).optional(),
    /** WHICH credential/tenant identity paid for it. Never a secret — an id. */
    account: z.string().min(1).optional(),
    /** WHICH shared quota bucket it consumed (workers.capacity_pool). */
    capacitySlot: z.string().min(1).optional(),
  })
  .strict();

export type WorkerIdentity = z.infer<typeof workerIdentitySchema>;

/**
 * The task contract handed to an external worker.
 *
 * This is the whole of what the worker is told, and it is injected
 * programmatically — no human pastes a prompt. Identity is carried in full
 * (goal/mission/plan/task/attempt) because a worker's output has to be
 * attributable to one logical attempt even after a restart, and because resuming
 * must be able to prove it is continuing the SAME logical task rather than
 * starting a similar one.
 */
export const workerTaskContractSchema = z
  .object({
    /** Nullable by design: a mission with no goal is generic, not autonomous. */
    goalId: z.string().min(1).nullish(),
    missionId: z.string().min(1),
    planId: z.string().min(1).nullish(),
    missionTaskId: z.string().min(1),
    taskId: z.string().min(1),
    /** The logical attempt. Together with missionTaskId it is the identity. */
    attempt: z.number().int().positive(),
    /** Correlation id for the durable ledger. Unique per attempt. */
    workflowId: z.string().min(1),
    objective: z.string().min(1),
    instructions: z.string().min(1),
    successCriteria: z.array(z.string().min(1)).default([]),
    /** Paths the worker may write. Empty = read-only. */
    allowedFileScope: z.array(z.string().min(1)).default([]),
    /** Absolute path of the workspace the worker must work in. */
    workspacePath: z.string().min(1),
    /** Set only when resuming: the worker's own prior session handle. */
    resumeToken: z.string().min(1).nullish(),
    /** Set only when resuming: what the previous attempt had already done. */
    handoff: z.record(z.string(), z.unknown()).nullish(),
  })
  .strict();

export type WorkerTaskContract = z.infer<typeof workerTaskContractSchema>;

/**
 * How an execution failed, operationally.
 *
 * Each class exists because it implies a DIFFERENT correct response. A class that
 * implied the same response as another would be noise.
 */
export const workerFailureClassSchema = z.enum([
  /** The worker's own session/context is used up. A NEW session can continue. */
  "SESSION_EXHAUSTED",
  /** The backing service is down or unreachable. The task is untouched. */
  "PROVIDER_UNAVAILABLE",
  /** Throttled. Identical to available, only later. */
  "RATE_LIMITED",
  /** The transport died mid-answer. Work may be partially done — resume, don't restart. */
  "STREAM_FAILED",
  /** The process died abnormally (signal, non-zero with no verdict). */
  "WORKER_CRASHED",
  /**
   * ICOS killed the worker for exceeding its execution budget. Distinct from STREAM_FAILED
   * (a transport death): the model did not finish in time, so repeating the same compute with
   * the same budget is the least likely thing to work. Routing reads it (decision 0054).
   */
  "EXECUTION_TIMEOUT",
  /** The credential was refused. Retrying on the same account is waste; elsewhere is not. */
  "AUTH_FAILURE",
  /** The provider is up but this model is not served. Another model may be. */
  "MODEL_UNAVAILABLE",
  /** This attempt's execution lease expired; another runner may own it now. */
  "LEASE_EXPIRED",
  /** Retryable, but not attributable to any class above. Honest catch-all. */
  "FAILED_RETRYABLE",
  /** The worker reached a verdict: this cannot be done. Retrying is waste. */
  "FAILED_TERMINAL",
]);

export type WorkerFailureClass = z.infer<typeof workerFailureClassSchema>;

/**
 * THE single source of truth for retryability.
 *
 * An exhaustive record, not a function with a `default: true`. A new class then
 * cannot be added without a compile error forcing a deliberate answer — and
 * "retryable" defaulting silently is how a permanently-impossible task ends up
 * consuming its attempt budget forever.
 */
export const WORKER_FAILURE_RETRYABLE: Readonly<Record<WorkerFailureClass, boolean>> =
  Object.freeze({
    SESSION_EXHAUSTED: true,
    PROVIDER_UNAVAILABLE: true,
    RATE_LIMITED: true,
    STREAM_FAILED: true,
    WORKER_CRASHED: true,
    EXECUTION_TIMEOUT: true,
    AUTH_FAILURE: true,
    MODEL_UNAVAILABLE: true,
    LEASE_EXPIRED: true,
    FAILED_RETRYABLE: true,
    /* The ONLY terminal class. A worker's explicit "impossible" verdict. */
    FAILED_TERMINAL: false,
  });

export function isRetryableFailure(failureClass: WorkerFailureClass): boolean {
  return WORKER_FAILURE_RETRYABLE[failureClass];
}

/**
 * The one mapping from the operational taxonomy to the business proof.
 *
 * Deliberately lossy and in ONE place. The fine class stays durable on the
 * attempt ledger (`dispatch_attempts.failure_class`), so nothing is lost — but
 * the Cockpit-facing record keeps its small, stable vocabulary instead of growing
 * a provider-shaped enum.
 */
export function toExecutionErrorCode(failureClass: WorkerFailureClass): ExecutionErrorCode {
  switch (failureClass) {
    /* Nothing ran, or the backing service refused to serve. Not the task's fault. */
    case "PROVIDER_UNAVAILABLE":
    case "RATE_LIMITED":
    case "SESSION_EXHAUSTED":
    case "AUTH_FAILURE":
    case "MODEL_UNAVAILABLE":
      return "WORKER_UNAVAILABLE";
    /*
     * The work may be PARTIALLY DONE and we cannot say what landed, so this is
     * exactly UNKNOWN_EFFECT — which the business contract documents as
     * fail-closed and never to be masked as success.
     *
     * WORKER_CRASHED belongs here, not with WORKER_FAILED. A process that died
     * mid-run tells you nothing about which files it had already written; calling
     * that "the task failed" asserts more than we know. (Writer isolation plus git
     * evidence can often answer it afterwards — but this mapping is a pure
     * function of the class, with no evidence in hand, so it must stay
     * conservative.)
     */
    case "STREAM_FAILED":
    case "LEASE_EXPIRED":
    case "WORKER_CRASHED":
    /* Killed mid-run: what it had written is unknown, exactly like a crash. */
    case "EXECUTION_TIMEOUT":
      return "UNKNOWN_EFFECT";
    /* A verdict was actually reached: the worker ran and reported failure. */
    case "FAILED_RETRYABLE":
    case "FAILED_TERMINAL":
      return "WORKER_FAILED";
  }
}

/** What a worker may report about itself in its structured result. */
export const workerStructuredResultSchema = z
  .object({
    status: z.enum(["succeeded", "failed"]),
    /** Present on failure: the worker's own classification, if it has one. */
    failureClass: workerFailureClassSchema.optional(),
    summary: z.string().max(20_000).optional(),
    /** Work the worker knows it did NOT finish. Carried into the next attempt. */
    unresolved: z.array(z.string()).optional(),
    testsRun: z.array(z.string()).optional(),
    /** The worker's own session handle, so the same logical task can resume. */
    resumeToken: z.string().min(1).optional(),
    handoff: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type WorkerStructuredResult = z.infer<typeof workerStructuredResultSchema>;

/**
 * Git-observable evidence of what an execution actually changed.
 *
 * Collected from the WORKSPACE, never from the worker's own claims: a worker
 * saying "I committed the fix" is a claim, and `git rev-parse HEAD` is evidence.
 */
export const workerCommitEvidenceSchema = z
  .object({
    branch: z.string().min(1),
    /** HEAD after the run. Null when the worker committed nothing. */
    commitHash: z.string().min(1).nullable(),
    /** Commits created by this run, oldest first. */
    commits: z.array(z.string().min(1)).default([]),
    changedFiles: z.array(z.string()).default([]),
    /**
     * The change ITSELF, bounded (defect 35).
     *
     * File names and a commit hash say that something changed; they do not say WHAT, so a
     * reviewer asked to judge quality from them can only escalate — and did, in a real run:
     * "Cannot verify the existence or content of the documentation file". A review of a
     * change that nobody can see is not a review.
     *
     * Truncated rather than omitted when large, and flagged as such, so the reviewer knows
     * it is seeing part of the change rather than all of it.
     */
    diff: z.string().optional(),
    /** True when `diff` was cut short. Evidence about the evidence. */
    diffTruncated: z.boolean().optional(),
    /** True when the worker left uncommitted changes — evidence, not a verdict. */
    dirty: z.boolean(),
  })
  .strict();

export type WorkerCommitEvidence = z.infer<typeof workerCommitEvidenceSchema>;

/** Raw, bounded process observation. The truth about what the process did. */
export interface WorkerProcessObservation {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Signal that killed it, when it died by signal rather than exiting. */
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}

/** The canonical outcome of one external worker execution. */
export type WorkerExecutionOutcome =
  | {
      ok: true;
      identity: WorkerIdentity;
      process: WorkerProcessObservation;
      structured?: WorkerStructuredResult;
      evidence?: WorkerCommitEvidence;
      resumeToken?: string;
    }
  | {
      ok: false;
      identity: WorkerIdentity;
      failureClass: WorkerFailureClass;
      retryable: boolean;
      message: string;
      process?: WorkerProcessObservation;
      structured?: WorkerStructuredResult;
      evidence?: WorkerCommitEvidence;
      /** Carried forward so the NEXT attempt continues instead of restarting. */
      resumeToken?: string;
      handoff?: Record<string, unknown>;
    };

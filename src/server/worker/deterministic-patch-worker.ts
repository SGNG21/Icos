import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import type { PolicyDecision } from "@/core/policy";
import type { CreateWorkerInput, Worker, WorkerResult } from "@/core/worker";
import type { D1PolicyPort } from "@/server/policy/ports";

import type { WorkerManagerPort } from "./ports";

const execFile = promisify(execFileCallback);
const OUTPUT_LIMIT = 16 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type DeterministicPatchExpectation = { kind: "ABSENT" } | { kind: "SHA256"; value: string };

export interface DeterministicPatchTarget {
  path: string;
  expected: DeterministicPatchExpectation;
  content: string;
}

/**
 * Trusted, composition-owned patch. Nothing in this object is derived from a
 * Mission objective or browser request.
 */
export interface DeterministicPatchDefinition {
  id: string;
  targets: readonly DeterministicPatchTarget[];
  focusedTestPaths: readonly string[];
  commitMessage: string;
}

export interface DeterministicPatchCatalog {
  get(taskId: string): DeterministicPatchDefinition | undefined;
}

export interface BoundedProcessRecord {
  executable: "git" | "pnpm";
  args: readonly string[];
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface DeterministicPatchEvidence {
  patchId: string;
  targetFiles: string[];
  beforeHashes: Record<string, string | null>;
  afterHashes: Record<string, string>;
  changedFiles: string[];
  processes: BoundedProcessRecord[];
  focusedTestsPassed: boolean;
  baseSha: string;
  commitSha?: string;
  cancellationState: "NONE" | "CANCELLED" | "TIMED_OUT";
  cleanupResult: "SUPERVISOR_OWNED";
}

export type DeterministicPatchWorkerResult = WorkerResult & {
  evidence: DeterministicPatchEvidence;
  mergePerformed: false;
  productionPerformed: false;
};

export interface DeterministicPatchProcessRunner {
  run(
    executable: "git" | "pnpm",
    args: readonly string[],
    options: {
      cwd: string;
      signal: AbortSignal;
      timeoutMs: number;
    },
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface DeterministicPatchWorkerOptions {
  taskWorktreeRoot: string;
  runner?: DeterministicPatchProcessRunner;
}

class ExecFileProcessRunner implements DeterministicPatchProcessRunner {
  async run(
    executable: "git" | "pnpm",
    args: readonly string[],
    options: {
      cwd: string;
      signal: AbortSignal;
      timeoutMs: number;
    },
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await execFile(executable, [...args], {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs,
      maxBuffer: OUTPUT_LIMIT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: process.env.NODE_ENV ?? "production",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "ICOS Deterministic Worker",
        GIT_AUTHOR_EMAIL: "deterministic-worker@icos.invalid",
        GIT_COMMITTER_NAME: "ICOS Deterministic Worker",
        GIT_COMMITTER_EMAIL: "deterministic-worker@icos.invalid",
      },
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }
}

interface WorkerEntry {
  worker: Worker;
  patch: DeterministicPatchDefinition;
  abortController: AbortController;
  timedOut: boolean;
  promise?: Promise<DeterministicPatchWorkerResult>;
}

class BoundedWorkerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "BoundedWorkerError";
  }
}

/**
 * A deliberately non-general worker.
 *
 * The canonical task id selects an immutable patch from a trusted catalog.
 * Objective text is stored for audit only and is never parsed or used to
 * choose executables, arguments, content, paths, tests, or commit messages.
 */
export class DeterministicPatchWorker implements WorkerManagerPort {
  private readonly workers = new Map<string, WorkerEntry>();

  constructor(
    private readonly policy: D1PolicyPort,
    private readonly catalog: DeterministicPatchCatalog,
    options: DeterministicPatchWorkerOptions,
  ) {
    this.taskWorktreeRoot = path.resolve(options.taskWorktreeRoot);
    this.runner = options.runner ?? new ExecFileProcessRunner();
  }

  private readonly taskWorktreeRoot: string;
  private readonly runner: DeterministicPatchProcessRunner;

  async spawn(input: CreateWorkerInput): Promise<string> {
    const selected = this.catalog.get(input.taskId);
    if (!selected) {
      throw new BoundedWorkerError(
        `No composition-owned deterministic patch exists for task ${input.taskId}`,
        "PATCH_NOT_CATALOGUED",
      );
    }
    if (!input.worktreePath || !path.isAbsolute(input.worktreePath)) {
      throw new BoundedWorkerError(
        "A canonical absolute task worktree path is required",
        "INVALID_WORKTREE",
      );
    }

    const patch = this.validateAndClonePatch(selected);
    const decision = await this.authorize(input);
    if (decision.outcome !== "allow") {
      throw new BoundedWorkerError(
        `Worker refused by D1: ${decision.reason}`,
        decision.outcome === "require_approval" ? "APPROVAL_NOT_AUTHORITY" : "POLICY_DENIED",
      );
    }

    const workerId = `patch-worker-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const worker: Worker = {
      id: workerId,
      spec: {
        taskId: input.taskId,
        missionId: input.missionId,
        tenantId: input.tenantId,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        modelProfile: input.modelProfile ?? "BEST_CODING",
        skillRequirements: [],
        toolRequirements: [],
        permissionEnvelope: input.permissionEnvelope,
        timeoutMs: input.timeoutMs ?? 300_000,
        budget: {},
        reviewPolicy: {
          requiresReview: input.requiresReview ?? true,
          reviewerCount: 1,
        },
      },
      status: "CREATED",
      worktreePath: input.worktreePath,
      createdAt: now,
      updatedAt: now,
    };
    const abortController = new AbortController();
    const entry: WorkerEntry = {
      worker,
      patch,
      abortController,
      timedOut: false,
    };
    entry.promise = this.execute(entry, input.worktreePath);
    this.workers.set(workerId, entry);
    return workerId;
  }

  async getStatus(workerId: string): Promise<{ status: Worker["status"]; worker: Worker | null }> {
    const entry = this.workers.get(workerId);
    return entry
      ? { status: entry.worker.status, worker: entry.worker }
      : { status: "LOST", worker: null };
  }

  async collectResult(workerId: string): Promise<WorkerResult | null> {
    const entry = this.workers.get(workerId);
    return entry?.promise ?? null;
  }

  async waitForCompletion(workerId: string, timeoutMs?: number): Promise<WorkerResult> {
    const entry = this.workers.get(workerId);
    if (!entry) {
      return this.failureWithoutEvidence("Worker not found", "WORKER_LOST");
    }
    if (!entry.promise) {
      return this.failureWithoutEvidence("Worker has no execution promise", "INTERNAL_ERROR");
    }
    if (!timeoutMs) return entry.promise;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        entry.promise,
        new Promise<DeterministicPatchWorkerResult>((resolve) => {
          timer = setTimeout(() => {
            entry.timedOut = true;
            entry.abortController.abort("timeout");
            resolve(
              this.failureResult(entry.patch.id, "Worker wait timed out", "TIMEOUT", {
                patchId: entry.patch.id,
                targetFiles: entry.patch.targets.map((target) => target.path),
                beforeHashes: {},
                afterHashes: {},
                changedFiles: [],
                processes: [],
                focusedTestsPassed: false,
                baseSha: "",
                cancellationState: "TIMED_OUT",
                cleanupResult: "SUPERVISOR_OWNED",
              }),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async cancel(workerId: string): Promise<void> {
    const entry = this.workers.get(workerId);
    if (!entry || this.isTerminal(entry.worker.status)) return;
    entry.abortController.abort("cancelled");
  }

  async markLost(workerId: string): Promise<void> {
    const entry = this.workers.get(workerId);
    if (!entry || this.isTerminal(entry.worker.status)) return;
    entry.abortController.abort("lost");
    entry.worker.status = "LOST";
    entry.worker.updatedAt = new Date().toISOString();
    entry.worker.completedAt = entry.worker.updatedAt;
  }

  private async execute(
    entry: WorkerEntry,
    worktreePath: string,
  ): Promise<DeterministicPatchWorkerResult> {
    const startedAt = Date.now();
    entry.worker.status = "RUNNING";
    entry.worker.startedAt = new Date().toISOString();
    entry.worker.updatedAt = entry.worker.startedAt;

    const evidence: DeterministicPatchEvidence = {
      patchId: entry.patch.id,
      targetFiles: entry.patch.targets.map((target) => target.path),
      beforeHashes: {},
      afterHashes: {},
      changedFiles: [],
      processes: [],
      focusedTestsPassed: false,
      baseSha: "",
      cancellationState: "NONE",
      cleanupResult: "SUPERVISOR_OWNED",
    };
    const timeout = setTimeout(() => {
      entry.timedOut = true;
      entry.abortController.abort("timeout");
    }, entry.worker.spec.timeoutMs);

    try {
      const canonicalRoot = await this.validateTaskWorktree(worktreePath, entry.worker.spec.taskId);
      this.assertActive(entry);
      evidence.baseSha = (
        await this.runProcess(evidence, "git", ["rev-parse", "HEAD"], canonicalRoot, entry)
      ).stdout.trim();

      const initialStatus = await this.runProcess(
        evidence,
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        canonicalRoot,
        entry,
      );
      if (initialStatus.stdout.trim()) {
        throw new BoundedWorkerError(
          "Task worktree must be clean before deterministic patch execution",
          "DIRTY_WORKTREE",
        );
      }

      for (const target of entry.patch.targets) {
        this.assertActive(entry);
        const targetPath = await this.validateTargetPath(canonicalRoot, target.path);
        const before = await this.verifyExpectation(targetPath, target.expected);
        evidence.beforeHashes[target.path] = before;
        await writeFile(targetPath, target.content, {
          encoding: "utf8",
          flag: target.expected.kind === "ABSENT" ? "wx" : "w",
        });
        evidence.afterHashes[target.path] = this.hash(target.content);
      }

      for (const testPath of entry.patch.focusedTestPaths) {
        await this.validateExistingRegularPath(canonicalRoot, testPath);
      }

      const statusAfterWrite = await this.runProcess(
        evidence,
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        canonicalRoot,
        entry,
      );
      evidence.changedFiles = this.parseStatusPaths(statusAfterWrite.stdout);
      this.assertOnlyDeclaredChanges(evidence.changedFiles, evidence.targetFiles);

      await this.runProcess(evidence, "git", ["diff", "--check"], canonicalRoot, entry);
      await this.runProcess(
        evidence,
        "pnpm",
        ["exec", "vitest", "run", ...entry.patch.focusedTestPaths],
        canonicalRoot,
        entry,
      );
      evidence.focusedTestsPassed = true;

      const statusAfterTests = await this.runProcess(
        evidence,
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        canonicalRoot,
        entry,
      );
      evidence.changedFiles = this.parseStatusPaths(statusAfterTests.stdout);
      this.assertOnlyDeclaredChanges(evidence.changedFiles, evidence.targetFiles);

      await this.runProcess(
        evidence,
        "git",
        ["add", "--", ...entry.patch.targets.map((target) => target.path)],
        canonicalRoot,
        entry,
      );
      await this.runProcess(
        evidence,
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "-m",
          entry.patch.commitMessage,
        ],
        canonicalRoot,
        entry,
      );
      evidence.commitSha = (
        await this.runProcess(evidence, "git", ["rev-parse", "HEAD"], canonicalRoot, entry)
      ).stdout.trim();

      const result: DeterministicPatchWorkerResult = {
        outcome: "SUCCESS",
        commitSha: evidence.commitSha,
        artifacts: entry.patch.targets.map((target) => ({
          name: path.basename(target.path),
          path: target.path,
          size: Buffer.byteLength(target.content),
        })),
        summary: `Deterministic patch ${entry.patch.id} committed after focused tests`,
        durationMs: Date.now() - startedAt,
        evidence,
        mergePerformed: false,
        productionPerformed: false,
      };
      this.complete(entry.worker, "SUCCEEDED", result);
      return result;
    } catch (error) {
      evidence.cancellationState = entry.timedOut
        ? "TIMED_OUT"
        : entry.abortController.signal.aborted
          ? "CANCELLED"
          : "NONE";
      const message = error instanceof Error ? error.message : "Unknown deterministic worker error";
      const code =
        evidence.cancellationState === "TIMED_OUT"
          ? "TIMEOUT"
          : evidence.cancellationState === "CANCELLED"
            ? "CANCELLED"
            : error instanceof BoundedWorkerError
              ? error.code
              : "INTERNAL_ERROR";
      const result = this.failureResult(entry.patch.id, message, code, evidence);
      result.durationMs = Date.now() - startedAt;
      this.complete(
        entry.worker,
        evidence.cancellationState === "CANCELLED"
          ? "CANCELLED"
          : evidence.cancellationState === "TIMED_OUT"
            ? "TIMED_OUT"
            : "FAILED",
        result,
      );
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async authorize(input: CreateWorkerInput): Promise<PolicyDecision> {
    return this.policy.decide({
      actor: {
        kind: "system",
        id: input.agentIdentity?.id ?? "supervisor",
        tenantId: input.agentIdentity?.tenantId ?? input.tenantId,
        roles: input.agentIdentity?.roles,
        authorizationLevel: input.agentIdentity?.authorizationLevel,
      },
      tenant: { tenantId: input.tenantId },
      action: input.permissionEnvelope.action,
      resource: {
        type: "worker-execution",
        id: input.taskId,
        ownerTenantId: input.tenantId,
      },
      capabilityKey: input.permissionEnvelope.capabilityKey,
      risk: "reversible",
      hasExternalEffect: false,
    });
  }

  private validateAndClonePatch(
    definition: DeterministicPatchDefinition,
  ): DeterministicPatchDefinition {
    const patch = structuredClone(definition);
    if (!patch.id.trim() || patch.targets.length === 0 || patch.focusedTestPaths.length === 0) {
      throw new BoundedWorkerError(
        "Patch id, targets, and focused tests are required",
        "INVALID_PATCH",
      );
    }
    if (
      !patch.commitMessage.trim() ||
      patch.commitMessage.length > 200 ||
      patch.commitMessage.includes("\n")
    ) {
      throw new BoundedWorkerError("Patch commit message is invalid", "INVALID_PATCH");
    }
    const paths = [...patch.targets.map((target) => target.path), ...patch.focusedTestPaths];
    for (const candidate of paths) this.validateRelativePath(candidate);
    for (const testPath of patch.focusedTestPaths) {
      if (testPath.startsWith("-") || !/\.test\.(?:ts|tsx)$/.test(testPath)) {
        throw new BoundedWorkerError(
          `Focused test path is not allowlisted: ${testPath}`,
          "TEST_PATH_REJECTED",
        );
      }
    }
    if (new Set(patch.targets.map((target) => target.path)).size !== patch.targets.length) {
      throw new BoundedWorkerError("Patch target paths must be unique", "INVALID_PATCH");
    }
    for (const target of patch.targets) {
      if (target.expected.kind === "SHA256" && !SHA256_PATTERN.test(target.expected.value)) {
        throw new BoundedWorkerError(
          `Invalid expected SHA-256 for ${target.path}`,
          "INVALID_PATCH",
        );
      }
    }
    return patch;
  }

  private validateRelativePath(candidate: string): void {
    if (
      !candidate ||
      path.isAbsolute(candidate) ||
      candidate.includes("\0") ||
      candidate.split(/[\\/]/).includes("..") ||
      path.normalize(candidate) !== candidate
    ) {
      throw new BoundedWorkerError(
        `Unsafe repository-relative path: ${candidate}`,
        "PATH_REJECTED",
      );
    }
  }

  private async validateTaskWorktree(worktreePath: string, taskId: string): Promise<string> {
    const canonicalRoot = await realpath(worktreePath);
    const canonicalBase = await realpath(this.taskWorktreeRoot);
    const sanitizedTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const expectedRoot = path.join(canonicalBase, sanitizedTaskId);
    if (canonicalRoot !== expectedRoot || path.dirname(canonicalRoot) !== canonicalBase) {
      throw new BoundedWorkerError(
        "Worker path is not the canonical task-scoped worktree",
        "INVALID_WORKTREE",
      );
    }
    return canonicalRoot;
  }

  private async validateTargetPath(canonicalRoot: string, relativePath: string): Promise<string> {
    this.validateRelativePath(relativePath);
    const resolved = path.resolve(canonicalRoot, relativePath);
    if (!resolved.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new BoundedWorkerError(`Path escapes task worktree: ${relativePath}`, "PATH_REJECTED");
    }

    let cursor = canonicalRoot;
    const parts = relativePath.split(path.sep);
    for (let index = 0; index < parts.length; index++) {
      cursor = path.join(cursor, parts[index]!);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) {
          throw new BoundedWorkerError(
            `Symbolic links are forbidden: ${relativePath}`,
            "SYMLINK_REJECTED",
          );
        }
        if (index < parts.length - 1 && !info.isDirectory()) {
          throw new BoundedWorkerError(
            `Patch parent is not a directory: ${relativePath}`,
            "PATH_REJECTED",
          );
        }
      } catch (error) {
        if (
          error instanceof BoundedWorkerError ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw error;
        }
        if (index < parts.length - 1) {
          throw new BoundedWorkerError(
            `Patch parent directory is missing: ${relativePath}`,
            "PATH_REJECTED",
          );
        }
      }
    }
    return resolved;
  }

  private async validateExistingRegularPath(
    canonicalRoot: string,
    relativePath: string,
  ): Promise<void> {
    const resolved = await this.validateTargetPath(canonicalRoot, relativePath);
    const info = await lstat(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new BoundedWorkerError(
          `Focused test file is missing: ${relativePath}`,
          "TEST_PATH_REJECTED",
        );
      }
      throw error;
    });
    if (!info.isFile()) {
      throw new BoundedWorkerError(
        `Focused test path must be a regular file: ${relativePath}`,
        "TEST_PATH_REJECTED",
      );
    }
  }

  private async verifyExpectation(
    targetPath: string,
    expected: DeterministicPatchExpectation,
  ): Promise<string | null> {
    let current: string;
    try {
      const info = await stat(targetPath);
      if (!info.isFile()) {
        throw new BoundedWorkerError("Patch target must be a regular file", "PATH_REJECTED");
      }
      current = await readFile(targetPath, "utf8");
    } catch (error) {
      if (
        error instanceof BoundedWorkerError ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      if (expected.kind === "SHA256") {
        throw new BoundedWorkerError("Expected patch target is missing", "EXPECTED_FILE_MISSING");
      }
      return null;
    }

    if (expected.kind === "ABSENT") {
      throw new BoundedWorkerError("Patch target unexpectedly exists", "UNEXPECTED_EXISTING_FILE");
    }
    const currentHash = this.hash(current);
    if (currentHash !== expected.value) {
      throw new BoundedWorkerError("Patch target prior hash is stale", "STALE_PRIOR_HASH");
    }
    return currentHash;
  }

  private async runProcess(
    evidence: DeterministicPatchEvidence,
    executable: "git" | "pnpm",
    args: readonly string[],
    cwd: string,
    entry: WorkerEntry,
  ): Promise<{ stdout: string; stderr: string }> {
    this.assertAllowedProcess(executable, args);
    this.assertActive(entry);
    const startedAt = Date.now();
    try {
      const output = await this.runner.run(executable, args, {
        cwd,
        signal: entry.abortController.signal,
        timeoutMs: entry.worker.spec.timeoutMs,
      });
      evidence.processes.push({
        executable,
        args: [...args],
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        stdout: this.bound(output.stdout),
        stderr: this.bound(output.stderr),
      });
      return output;
    } catch (error) {
      const processError = error as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      evidence.processes.push({
        executable,
        args: [...args],
        exitCode: typeof processError.code === "number" ? processError.code : -1,
        durationMs: Date.now() - startedAt,
        stdout: this.bound(processError.stdout ?? ""),
        stderr: this.bound(processError.stderr ?? processError.message),
      });
      throw error;
    }
  }

  private assertAllowedProcess(executable: "git" | "pnpm", args: readonly string[]): void {
    const gitAllowed =
      executable === "git" &&
      (this.matches(args, ["rev-parse", "HEAD"]) ||
        this.matches(args, ["status", "--porcelain=v1", "--untracked-files=all"]) ||
        this.matches(args, ["diff", "--check"]) ||
        (args[0] === "add" && args[1] === "--" && args.length > 2) ||
        (this.matches(args.slice(0, 5), [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgSign=false",
          "commit",
        ]) &&
          args[5] === "-m" &&
          args.length === 7));
    const vitestAllowed =
      executable === "pnpm" &&
      args[0] === "exec" &&
      args[1] === "vitest" &&
      args[2] === "run" &&
      args.length > 3;
    if (!gitAllowed && !vitestAllowed) {
      throw new BoundedWorkerError(
        `Process operation is not allowlisted: ${executable}`,
        "PROCESS_NOT_ALLOWED",
      );
    }
  }

  private matches(actual: readonly string[], expected: readonly string[]): boolean {
    return (
      actual.length === expected.length && actual.every((value, index) => value === expected[index])
    );
  }

  private parseStatusPaths(output: string): string[] {
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3))
      .sort();
  }

  private assertOnlyDeclaredChanges(
    changedFiles: readonly string[],
    declaredFiles: readonly string[],
  ): void {
    const declared = new Set(declaredFiles);
    const unexpected = changedFiles.filter((file) => !declared.has(file));
    if (unexpected.length > 0) {
      throw new BoundedWorkerError(
        `Undeclared changed files: ${unexpected.join(", ")}`,
        "UNDECLARED_CHANGE",
      );
    }
    if (changedFiles.length !== declared.size) {
      throw new BoundedWorkerError(
        "Not every declared patch target changed",
        "MISSING_DECLARED_CHANGE",
      );
    }
  }

  private assertActive(entry: WorkerEntry): void {
    if (entry.abortController.signal.aborted) {
      throw new BoundedWorkerError(
        entry.timedOut ? "Deterministic worker timed out" : "Deterministic worker cancelled",
        entry.timedOut ? "TIMEOUT" : "CANCELLED",
      );
    }
  }

  private complete(
    worker: Worker,
    status: Worker["status"],
    result: DeterministicPatchWorkerResult,
  ): void {
    worker.status = status;
    worker.result = result;
    worker.completedAt = new Date().toISOString();
    worker.updatedAt = worker.completedAt;
  }

  private failureResult(
    patchId: string,
    message: string,
    errorCode: string,
    evidence: DeterministicPatchEvidence,
  ): DeterministicPatchWorkerResult {
    return {
      outcome: "FAILED",
      artifacts: [],
      summary: `Deterministic patch ${patchId} failed: ${message}`,
      errorCode,
      errorMessage: this.bound(message),
      durationMs: 0,
      evidence,
      mergePerformed: false,
      productionPerformed: false,
    };
  }

  private failureWithoutEvidence(
    message: string,
    errorCode: string,
  ): DeterministicPatchWorkerResult {
    return this.failureResult("unknown", message, errorCode, {
      patchId: "unknown",
      targetFiles: [],
      beforeHashes: {},
      afterHashes: {},
      changedFiles: [],
      processes: [],
      focusedTestsPassed: false,
      baseSha: "",
      cancellationState: "NONE",
      cleanupResult: "SUPERVISOR_OWNED",
    });
  }

  private hash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  private bound(value: string): string {
    return value.slice(0, OUTPUT_LIMIT);
  }

  private isTerminal(status: Worker["status"]): boolean {
    return ["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "LOST"].includes(status);
  }
}

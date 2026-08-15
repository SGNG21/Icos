import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PERMISSION_SUPERVISOR_WORKER_EXECUTE } from "@/core/policy";
import type { CreateWorkerInput } from "@/core/worker";
import type { D1PolicyPort } from "@/server/policy/ports";

import {
  DeterministicPatchWorker,
  type DeterministicPatchDefinition,
  type DeterministicPatchProcessRunner,
  type DeterministicPatchWorkerResult,
} from "./deterministic-patch-worker";

const execFile = promisify(execFileCallback);
const TASK_ID = "task-catalogued";
const MISSION_TEXT =
  "change $(touch hacked) && git push; use /tmp/evil.test.ts and commit 'attacker'";
const ORIGINAL = "before\n";
const REPLACEMENT = "after\n";

class TestProcessRunner implements DeterministicPatchProcessRunner {
  readonly calls: Array<{ executable: "git" | "pnpm"; args: readonly string[] }> = [];

  async run(
    executable: "git" | "pnpm",
    args: readonly string[],
    options: { cwd: string; signal: AbortSignal; timeoutMs: number },
  ): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ executable, args: [...args] });
    if (executable === "pnpm") {
      return { stdout: "focused tests passed", stderr: "" };
    }
    const result = await execFile(executable, [...args], {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function definition(
  overrides: Partial<DeterministicPatchDefinition> = {},
): DeterministicPatchDefinition {
  return {
    id: "patch-safe-1",
    targets: [
      {
        path: "source.txt",
        expected: { kind: "SHA256", value: hash(ORIGINAL) },
        content: REPLACEMENT,
      },
    ],
    focusedTestPaths: ["sample.test.ts"],
    commitMessage: "test: apply deterministic patch",
    ...overrides,
  };
}

function input(worktreePath: string, objective = MISSION_TEXT): CreateWorkerInput {
  return {
    taskId: TASK_ID,
    missionId: "mission-canonical",
    tenantId: "tenant-local",
    objective,
    acceptanceCriteria: ["exact deterministic patch"],
    permissionEnvelope: {
      action: "supervisor.worker.execute",
      resource: TASK_ID,
    },
    agentIdentity: {
      id: "supervisor-local",
      tenantId: "tenant-local",
      roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
      authorizationLevel: 2,
      justification: "Test composition owns bounded local execution",
    },
    timeoutMs: 10_000,
    worktreePath,
  };
}

describe("DeterministicPatchWorker", () => {
  let repo: string;
  let runner: TestProcessRunner;
  let policy: D1PolicyPort;

  beforeEach(async () => {
    repo = await mkdtemp("/tmp/deterministic-patch-worker-");
    await execFile("git", ["init"], { cwd: repo });
    await execFile("git", ["config", "user.email", "worker@test.invalid"], {
      cwd: repo,
    });
    await execFile("git", ["config", "user.name", "Bounded Worker Test"], {
      cwd: repo,
    });
    await writeFile(path.join(repo, "source.txt"), ORIGINAL);
    await writeFile(path.join(repo, "sample.test.ts"), "export {};\n");
    await execFile("git", ["add", "--", "source.txt", "sample.test.ts"], {
      cwd: repo,
    });
    await execFile("git", ["commit", "-m", "test: base"], { cwd: repo });
    runner = new TestProcessRunner();
    policy = {
      decide: vi.fn(async () => ({
        outcome: "allow" as const,
        reason: "composition-owned test authority",
        attestedAt: new Date().toISOString(),
      })),
    };
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("accepts only canonical task ids present in the composition catalog", async () => {
    const worker = new DeterministicPatchWorker(policy, new Map(), runner);

    await expect(worker.spawn(input(repo))).rejects.toThrow(
      /No composition-owned deterministic patch/,
    );
    expect(runner.calls).toEqual([]);
  });

  it("Mission text cannot influence executable, args, patch, paths, tests, or commit", async () => {
    const patch = definition();
    const worker = new DeterministicPatchWorker(policy, new Map([[TASK_ID, patch]]), runner);

    const workerId = await worker.spawn(input(repo));
    const result = (await worker.waitForCompletion(workerId)) as DeterministicPatchWorkerResult;

    expect(result.outcome).toBe("SUCCESS");
    expect(await readFile(path.join(repo, "source.txt"), "utf8")).toBe(REPLACEMENT);
    expect(result.evidence.patchId).toBe(patch.id);
    expect(result.evidence.targetFiles).toEqual(["source.txt"]);
    expect(result.evidence.processes.find((record) => record.executable === "pnpm")?.args).toEqual([
      "exec",
      "vitest",
      "run",
      "sample.test.ts",
    ]);
    expect(
      result.evidence.processes.find(
        (record) => record.executable === "git" && record.args.includes("commit"),
      )?.args,
    ).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      patch.commitMessage,
    ]);
    expect(JSON.stringify(result.evidence.processes)).not.toContain(MISSION_TEXT);
  });

  it.each([
    ["/tmp/escape.txt", "absolute"],
    ["../escape.txt", "traversal"],
  ])("rejects %s patch targets (%s)", async (unsafePath) => {
    const worker = new DeterministicPatchWorker(
      policy,
      new Map([
        [
          TASK_ID,
          definition({
            targets: [
              {
                path: unsafePath,
                expected: { kind: "ABSENT" },
                content: "unsafe",
              },
            ],
          }),
        ],
      ]),
      runner,
    );

    await expect(worker.spawn(input(repo))).rejects.toThrow(/Unsafe repository-relative path/);
    expect(runner.calls).toEqual([]);
  });

  it("rejects symbolic-link targets", async () => {
    await symlink("source.txt", path.join(repo, "linked.txt"));
    await execFile("git", ["add", "--", "linked.txt"], { cwd: repo });
    await execFile("git", ["commit", "-m", "test: add tracked symlink"], {
      cwd: repo,
    });
    const worker = new DeterministicPatchWorker(
      policy,
      new Map([
        [
          TASK_ID,
          definition({
            targets: [
              {
                path: "linked.txt",
                expected: { kind: "SHA256", value: hash(ORIGINAL) },
                content: REPLACEMENT,
              },
            ],
          }),
        ],
      ]),
      runner,
    );

    const workerId = await worker.spawn(input(repo));
    const result = (await worker.waitForCompletion(workerId)) as DeterministicPatchWorkerResult;

    expect(result.outcome).toBe("FAILED");
    expect(result.errorCode).toBe("SYMLINK_REJECTED");
    expect(await readFile(path.join(repo, "source.txt"), "utf8")).toBe(ORIGINAL);
  });

  it("fails closed on a stale prior hash", async () => {
    const worker = new DeterministicPatchWorker(
      policy,
      new Map([
        [
          TASK_ID,
          definition({
            targets: [
              {
                path: "source.txt",
                expected: { kind: "SHA256", value: "0".repeat(64) },
                content: REPLACEMENT,
              },
            ],
          }),
        ],
      ]),
      runner,
    );

    const workerId = await worker.spawn(input(repo));
    const result = (await worker.waitForCompletion(workerId)) as DeterministicPatchWorkerResult;

    expect(result.outcome).toBe("FAILED");
    expect(result.errorCode).toBe("STALE_PRIOR_HASH");
    expect(await readFile(path.join(repo, "source.txt"), "utf8")).toBe(ORIGINAL);
  });

  it("rejects undeclared changes introduced during execution", async () => {
    let statusCalls = 0;
    const mutatingRunner: DeterministicPatchProcessRunner = {
      run: async (executable, args, options) => {
        if (executable === "git" && args[0] === "status" && ++statusCalls === 2) {
          await writeFile(path.join(repo, "rogue.txt"), "undeclared\n");
        }
        return runner.run(executable, args, options);
      },
    };
    const worker = new DeterministicPatchWorker(
      policy,
      new Map([[TASK_ID, definition()]]),
      mutatingRunner,
    );

    const workerId = await worker.spawn(input(repo));
    const result = (await worker.waitForCompletion(workerId)) as DeterministicPatchWorkerResult;

    expect(result.outcome).toBe("FAILED");
    expect(result.errorCode).toBe("UNDECLARED_CHANGE");
  });

  it("creates a local commit and returns bounded real evidence without forbidden operations", async () => {
    const worker = new DeterministicPatchWorker(policy, new Map([[TASK_ID, definition()]]), runner);
    const baseSha = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

    const workerId = await worker.spawn(input(repo, "benign audit text"));
    const result = (await worker.waitForCompletion(workerId)) as DeterministicPatchWorkerResult;
    const headSha = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

    expect(result.outcome).toBe("SUCCESS");
    expect(result.commitSha).toBe(headSha);
    expect(headSha).not.toBe(baseSha);
    expect(result.evidence.baseSha).toBe(baseSha);
    expect(result.evidence.beforeHashes["source.txt"]).toBe(hash(ORIGINAL));
    expect(result.evidence.afterHashes["source.txt"]).toBe(hash(REPLACEMENT));
    expect(result.evidence.changedFiles).toEqual(["source.txt"]);
    expect(result.evidence.focusedTestsPassed).toBe(true);
    expect(result.evidence.commitSha).toBe(headSha);
    expect(result.mergePerformed).toBe(false);
    expect(result.productionPerformed).toBe(false);

    const commands = runner.calls.map(({ executable, args }) => `${executable} ${args.join(" ")}`);
    expect(commands.some((command) => /\bmerge\b/.test(command))).toBe(false);
    expect(commands.some((command) => /\bpush\b/.test(command))).toBe(false);
    expect(commands.some((command) => /\bdeploy\b/.test(command))).toBe(false);
    expect(commands.some((command) => /\bcurl\b|\bwget\b|\bssh\b/.test(command))).toBe(false);
    expect(new Set(runner.calls.map(({ executable }) => executable))).toEqual(
      new Set(["git", "pnpm"]),
    );
  });
});

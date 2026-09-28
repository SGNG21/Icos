import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workerTaskContractSchema } from "@/core/contracts/worker-execution";
import {
  workerRegistryEntrySchema,
  type WorkerRegistryEntry,
} from "@/core/contracts/worker-registry";
import { runNonInteractive } from "@/server/workers/process/run-process";
import { CommandWorkerExecutor } from "./command-worker-executor";
import { createWorkerExecResolver, parseWorkerExecCommands } from "./exec-command-config";
import { WorkerExecutor } from "./worker-executor";
import { collectCommitEvidence, provisionWorkspace } from "./writer-workspace";

/*
 * M6.3 — A REAL EXTERNAL AGENT, LAUNCHED BY ICOS, WITH NO HUMAN PRESENT.
 *
 * Everything else in M6.3 is proven against real processes that ICOS controls
 * (`process.execPath`). This file is the one that proves the point of the milestone:
 * a genuinely external, third-party agent binary — one that talks to a model over a
 * network, has its own config, its own session store and its own opinions about
 * terminals — is launched programmatically, receives its task, and comes back with
 * output ICOS can read.
 *
 * WHY IT IS OPT-IN
 * It spends real model credits and depends on a third-party service being up, so
 * running it on every commit would make an unrelated provider outage look like an
 * ICOS regression and would bill the repository for every CI run. It is gated on
 * ICOS_LIVE_WORKER_PROOF=1, NOT on a `skip` that hides a broken test: the code paths
 * it exercises are covered deterministically elsewhere, and this adds the one thing
 * those cannot — contact with a real provider.
 *
 * REPRODUCE:
 *   ICOS_LIVE_WORKER_PROOF=1 npx vitest run --config vitest.integration.config.ts \
 *     src/server/workers/execution/live-external-worker.integration.test.ts
 *
 * NOTHING HERE NAMES A PROVIDER IN PRODUCTION CODE. The binary is named in this
 * TEST, as configuration, exactly the way a deployment would name it in
 * ICOS_WORKER_EXEC_COMMANDS.
 */

/** Locates a binary with NO shell, so a name can never be interpolated into one. */
function whichSync(binary: string): string | null {
  try {
    const found = execFileSync("which", [binary], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

const ENABLED = process.env.ICOS_LIVE_WORKER_PROOF === "1";
const HERMES = whichSync("hermes");
/* Hermes first when present, Codex next — the adapter is identical either way. */
const CODEX = whichSync("codex");

let root: string;
let repo: string;

const git = async (cwd: string, args: string[]) => {
  const result = await runNonInteractive({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

beforeAll(async () => {
  if (!ENABLED) return;
  root = await mkdtemp(join(tmpdir(), "icos-live-worker-"));
  repo = join(root, "canonical");
  await git(root, ["init", "--initial-branch=main", "canonical"]);
  await git(repo, ["config", "user.email", "test@icos.local"]);
  await git(repo, ["config", "user.name", "ICOS Test"]);
  await writeFile(join(repo, "README.md"), "canonical\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function liveWorker(runtime: "binary"): WorkerRegistryEntry {
  /* Built through the schema so defaults apply and the entry is genuinely valid. */
  return workerRegistryEntrySchema.parse({
    id: "99999999-9999-4999-8999-999999999999",
    workerKind: "agent",
    displayName: "live-external-agent",
    capabilities: ["code-generation"],
    supportsTools: true,
    status: "active",
    runtime,
    runtimeSupport: "SUPPORTED_RUNTIME",
    health: "healthy",
    availability: "available",
    /*
     * The identity axes a deployment declares. Recorded, never branched on — which
     * is what lets a later triage separate "this account is out of quota" from
     * "this worker is broken".
     */
    metadata: { model: "nemotron-class", provider: "custom-endpoint", account: "local-dev" },
    maxConcurrency: 1,
    updatedAt: new Date().toISOString(),
  });
}

describe.runIf(ENABLED)("M6.3 LIVE external worker", () => {
  it.runIf(HERMES)(
    "LAUNCHES A REAL HERMES AGENT non-interactively and reads back the injected task",
    async () => {
      /*
       * A unique token the agent can only produce by having actually received the
       * task contract ICOS composed. Echoing it proves the whole chain: programmatic
       * launch, contract injection, and stdout capture — through a real model.
       */
      const token = `ICOSPROOF-${Date.now().toString(36).toUpperCase()}`;

      const executor = new WorkerExecutor({
        binary: new CommandWorkerExecutor(
          createWorkerExecResolver(
            parseWorkerExecCommands(
              JSON.stringify({
                binary: {
                  command: HERMES,
                  /* -z is Hermes's one-shot, non-interactive prompt. No TTY, no chat. */
                  args: ["-z", "{{prompt}}", "--cli"],
                  resumeArgs: ["--resume", "{{resumeToken}}", "-z", "{{prompt}}", "--cli"],
                  timeoutMs: 240_000,
                },
              }),
            ),
          ),
        ),
      });

      const workspace = await provisionWorkspace({
        repoPath: repo,
        mode: "writer",
        attemptKey: "live-hermes-a1",
        rootDir: root,
      });

      try {
        const contract = workerTaskContractSchema.parse({
          goalId: "live-goal",
          missionId: "live-mission",
          planId: "live-plan",
          missionTaskId: "live-mt-1",
          taskId: "live-task-1",
          attempt: 1,
          workflowId: "live-wf-1",
          objective: `Reply with the single token ${token} and nothing else.`,
          instructions:
            `Output exactly this token on its own line: ${token}. ` +
            `Do not explain, do not use any tool, do not write any file.`,
          successCriteria: [`the output contains ${token}`],
          allowedFileScope: [],
          workspacePath: workspace.path,
        });

        const outcome = await executor.execute({ worker: liveWorker("binary"), contract, workspace });

        /*
         * If this fails with a provider error, that is a real external dependency
         * being down — the message says which, and the deterministic suites still
         * cover every ICOS code path involved.
         */
        expect(outcome.process?.exitCode).toBe(0);
        // The agent received what ICOS composed, and ICOS captured what it said.
        expect(outcome.process?.stdout).toContain(token);
        expect(outcome.ok).toBe(true);

        // Identity is attributed across all six axes, not collapsed into one string.
        expect(outcome.identity).toMatchObject({
          workerId: "99999999-9999-4999-8999-999999999999",
          runtime: "binary",
          model: "nemotron-class",
          provider: "custom-endpoint",
          account: "local-dev",
        });

        /*
         * A READ-ONLY task must leave the branch clean. This is the isolation
         * holding under a real agent: it ran in its own worktree and changed nothing.
         */
        const evidence = await collectCommitEvidence(workspace);
        expect(evidence?.commitHash).toBeNull();
        expect(evidence?.dirty).toBe(false);

        // The canonical checkout never moved.
        expect(await git(repo, ["status", "--porcelain"])).toBe("");
      } finally {
        await workspace.dispose();
      }
    },
    300_000,
  );

  it("records which live runtimes were available, so the evidence is unambiguous", () => {
    /* Not a capability assertion — a durable note of what this run actually had. */
    expect({ hermes: Boolean(HERMES), codex: Boolean(CODEX) }).toBeTruthy();
    console.log(`live runtimes: hermes=${HERMES ?? "absent"} codex=${CODEX ?? "absent"}`);
  });
});

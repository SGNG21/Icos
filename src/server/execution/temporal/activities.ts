/**
 * Temporal ACTIVITIES for the canonical ICOS task workflow.
 *
 * This replaces the out-of-repo proof-of-concept worker, and differs from it in the one
 * way that matters: the executor is ICOS's own governed gateway. The PoC called
 * `execFile('hermes', …)` directly, so every autonomous run executed with the server's
 * full environment, the server's `$HOME` and no kernel confinement at all — the exact
 * authority `run-process.ts` exists to remove.
 *
 * Here the run gets the certified treatment instead: a Seatbelt profile with
 * `(deny default)`, a disposable HOME seeded only with capability-scoped credentials, an
 * explicit environment allow-list, and a hard timeout. `certify:gateway` proves this same
 * path, so the worker and the certification agree by construction.
 *
 * The callbacks stay HTTP against ICOS's existing internal routes. They are already the
 * only writer of execution results, already idempotent on `workflowId`, and already
 * authenticated by a constant-time secret comparison — a second, in-process writer would
 * be a second settlement authority.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { brokerCredentials, seedHome } from "@/server/workers/process/credential-broker";
import { createEphemeralHome } from "@/server/workers/process/ephemeral-home";
import { runNonInteractive } from "@/server/workers/process/run-process";

import { classifyHermesRun } from "./hermes-run";

/** Correlates one run with its ICOS task and its durable Temporal workflow. */
export interface ExecutionContext {
  readonly taskId: string;
  readonly workflowId: string;
}

const HOME = process.env.HOME ?? "";

/** Credentials hermes needs, named one by one. A grant is never a whole directory. */
const HERMES_CREDENTIALS = [".hermes/config.yaml", ".hermes/auth.json"] as const;

/** Program paths, read-only. Deliberately distinct from credentials. */
const HERMES_PROGRAM_PATHS = [
  `${HOME}/.local/bin`,
  `${HOME}/.hermes/hermes-agent`,
  `${HOME}/.local/share/uv`,
] as const;

/**
 * THE WORKSPACE THE TASK ACTUALLY RUNS AGAINST.
 *
 * A sandboxed run used to get an empty temp directory, so "inspect the ICOS codebase"
 * honestly reported on an empty folder — and the reviewer honestly rejected it. The PoC
 * only ever appeared to work because it ran UNSANDBOXED and hermes reached a real
 * checkout on its own. The answer is to bind the intended checkout explicitly, not to
 * loosen the sandbox.
 *
 * Named configuration, never the process cwd by accident: the worker may be started from
 * anywhere, and a workspace nobody declared is not a workspace.
 */
function workspaceRoot(): string {
  const configured = process.env.ICOS_WORKSPACE_ROOT;
  if (!configured) {
    throw new Error(
      "ICOS_WORKSPACE_ROOT manquant : une tâche qui lit un dépôt exige un workspace déclaré",
    );
  }
  return resolve(configured);
}

/**
 * The execution budget. Matches `ICOS_WORKER_EXECUTION_TIMEOUT_MS` when the deployment
 * sets one, so the OWNER's budget is the binding constraint rather than a constant
 * compiled into the transport. A real codebase-inspection run measures around 7 minutes,
 * which is why the default is not two.
 */
function executionTimeoutMs(): number {
  const configured = Number(process.env.ICOS_WORKER_EXECUTION_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 900_000;
}

function callbackSecret(): string {
  const secret = process.env.ICOS_EXECUTION_CALLBACK_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("ICOS_EXECUTION_CALLBACK_SECRET manquant ou trop court");
  }
  return secret;
}

function icosBaseUrl(): string {
  const base = process.env.ICOS_BASE_URL;
  if (!base) throw new Error("ICOS_BASE_URL manquant");
  return base.replace(/\/+$/, "");
}

async function postJson(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${icosBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-icos-callback-secret": callbackSecret(),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    /* Status only: the body is ICOS's and may name internals. */
    throw new Error(`ICOS callback ${path} -> HTTP ${response.status}`);
  }
}

/**
 * Runs the worker under the governed gateway and returns its text result.
 *
 * Throws on failure, which Temporal turns into an activity failure and the workflow turns
 * into a canonical ICOS `failure` callback. Nothing here may report success on its own.
 */
export async function runGovernedWorker(prompt: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "icos-worker-"));
  const home = await createEphemeralHome();
  try {
    const capabilities = HERMES_CREDENTIALS.map((relativePath) => ({
      id: `hermes:${relativePath}`,
      kind: "file" as const,
      target: relativePath,
    }));
    const contents = new Map<string, string>();
    for (const relativePath of HERMES_CREDENTIALS) {
      const value = await readFile(join(HOME, relativePath), "utf8").catch(() => undefined);
      if (value !== undefined) contents.set(relativePath, value);
    }
    const broker = brokerCredentials(capabilities, (c) => contents.get(c.target));
    if (!broker.ok) {
      throw new Error(`WORKER_CREDENTIAL_MISSING: ${broker.reason}`);
    }
    await seedHome(home.path, broker.files);

    const usageFile = join(workspace, "usage.json");
    const root = workspaceRoot();
    const run = await runNonInteractive({
      command: "hermes",
      args: ["-z", prompt, "--usage-file", usageFile],
      /*
       * The declared checkout IS the working directory, so `allowed_file_scope: ["."]`
       * means the repository rather than an empty temp folder.
       */
      cwd: root,
      env: { HOME: home.path, ...broker.env },
      timeoutMs: executionTimeoutMs(),
      sandbox: {
        /*
         * READ_ONLY. The repository is readable and NOT writable: the only writable paths
         * stay the scratch workspace and the disposable HOME, so an analysis mission
         * cannot mutate the checkout it is reading. ~/.ssh, ~/.aws, the real HOME and
         * every unrelated worktree remain outside the profile entirely — `(deny default)`
         * means a path that is not listed does not exist for this process.
         */
        readWritePaths: [workspace, home.path],
        readOnlyPaths: [root, ...HERMES_PROGRAM_PATHS],
        /*
         * A remote provider needs the network, so it is granted. Seatbelt cannot filter by
         * hostname, so this is all-or-nothing and the audit says so rather than implying a
         * per-endpoint policy that does not exist.
         */
        allowNetwork: true,
      },
    });

    if (run.timedOut) {
      throw new Error(`WORKER_TIMEOUT: no result within ${executionTimeoutMs()}ms`);
    }

    let usage: unknown;
    try {
      usage = JSON.parse(await readFile(usageFile, "utf8"));
    } catch {
      usage = undefined; // fail closed: absent or unreadable status is a failure
    }

    const classified = classifyHermesRun(run.stdout, usage);
    if (!classified.ok) throw new Error(classified.message);
    return classified.result;
  } finally {
    await home.dispose();
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function reportStarted(ctx: ExecutionContext): Promise<void> {
  await postJson("/api/internal/executions/started", {
    taskId: ctx.taskId,
    workflowId: ctx.workflowId,
    startedAt: new Date().toISOString(),
  });
}

export async function reportSuccess(input: {
  ctx: ExecutionContext;
  workerKind: string;
  result: string;
  startedAt: string;
  completedAt: string;
}): Promise<void> {
  await postJson("/api/internal/executions/completed", {
    taskId: input.ctx.taskId,
    workflowId: input.ctx.workflowId,
    outcome: "success",
    workerKind: input.workerKind,
    result: input.result,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
}

export async function reportFailure(input: {
  ctx: ExecutionContext;
  workerKind: string;
  errorCode: string;
  errorMessage: string;
  startedAt: string;
  completedAt: string;
}): Promise<void> {
  await postJson("/api/internal/executions/completed", {
    taskId: input.ctx.taskId,
    workflowId: input.ctx.workflowId,
    outcome: "failure",
    workerKind: input.workerKind,
    error: { code: input.errorCode, message: input.errorMessage },
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  });
}

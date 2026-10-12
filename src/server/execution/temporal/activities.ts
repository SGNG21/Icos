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
import { access as fsAccess, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { brokerCredentials, seedHome } from "@/server/workers/process/credential-broker";
import { createEphemeralHome } from "@/server/workers/process/ephemeral-home";
import {
  startMeteredEgressProxy,
  type MeteredEgressProxy,
} from "@/server/workers/metered-egress-proxy";
import { workerEgressFetch, workerEgressUpstream } from "@/server/workers/metered-egress";
import { Context as ActivityContext } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runNonInteractive } from "@/server/workers/process/run-process";
import { parseGateCommands } from "@/server/workspace-manager/integration-gate";
import {
  SandboxedCommandRunner,
  defaultToolchainReadOnlyPaths,
  offlineInstallEnv,
  pnpmOfflineSettings,
} from "@/server/workspace-manager/sandboxed-command-runner";
import {
  EXEC_PLACEHOLDERS,
  parseWorkerExecCommands,
} from "@/server/workers/execution/exec-command-config";
import type { WorkerRuntimeDescriptor } from "@/core/contracts/worker-registry";

import { decideExecutable } from "@/core/execution/executable-policy";
import type { ExecutionScope } from "@/core/execution/execution-scope";

import { firstLineRedacted } from "@/server/workers/probes/probe-redaction";
import { classifyWorkerRun } from "./worker-run";

/** Correlates one run with its ICOS task and its durable Temporal workflow. */
export interface ExecutionContext {
  readonly taskId: string;
  readonly workflowId: string;
}

const HOME = process.env.HOME ?? "";

/**
 * THE EXECUTOR COMES FROM CONFIGURATION, never from a literal here.
 *
 * This activity used to name `hermes` outright while `exec-command-config.ts` states the
 * rule plainly — "Adding Hermes, Codex or anything else is CONFIGURATION… deliberately no
 * built-in default". So the thing that ran was not the thing ICOS declared, and
 * `tools.governed` correctly read NOT_CONNECTED while hermes executed every mission.
 *
 * Fail closed: an undeclared runtime gets no command and the activity refuses, rather
 * than falling back to an executable nobody authorised.
 */
const EXECUTOR_RUNTIME: WorkerRuntimeDescriptor = "binary";

/**
 * Credentials and program paths the declared executor may read, named one by one — a
 * grant is never a whole directory. Keyed by command so adding codex is configuration
 * plus one entry here, not a code change in the run path.
 */
const EXECUTOR_ACCESS: Readonly<
  Record<string, { credentials: readonly string[]; programPaths: readonly string[] }>
> = {
  hermes: {
    credentials: [".hermes/config.yaml", ".hermes/auth.json"],
    programPaths: [`${HOME}/.local/bin`, `${HOME}/.hermes/hermes-agent`, `${HOME}/.local/share/uv`],
  },
  codex: {
    credentials: [".codex/auth.json", ".codex/config.toml"],
    programPaths: [`${HOME}/.local/bin`],
  },
};

/**
 * EXECUTORS WHOSE MODEL TRAFFIC IS METERED BY ICOS (ADR 0075, "worker egress is metered").
 *
 * For these, the sandbox gets NO network at all — not the host's, not its loopback, so the
 * gateway on 127.0.0.1 is unreachable — and the only way out is a UNIX socket served by
 * `metered-egress-proxy.ts`, which forwards through `meteredFetch` under the task's goal.
 *
 * Keyed by the program's BASENAME, unlike {@link EXECUTOR_ACCESS}, and that is safe because
 * of which direction it moves: membership here only ever REMOVES authority (host network)
 * and adds none — no secret, no path beyond the adapter file itself and the socket directory.
 * A different program that happened to share the name would run with less, never more.
 * Which program may run at all stays the executable allowlist's decision.
 */
const METERED_EGRESS_EXECUTORS: ReadonlySet<string> = new Set(["icos-claude-worker.mjs"]);

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
    /*
     * A 4xx ON AN INTERNAL CALLBACK IS A CONTRACT VIOLATION, so it must say which one.
     *
     * Both sides of this call are ICOS: a 4xx means the worker built a body its own route
     * refuses, which is always a bug and never a runtime condition. Reporting the status
     * alone made that bug unreadable — and a refused completion callback is the exact
     * defect shape this lane exists to remove, because Temporal then retries it twenty
     * times and the attempt sits `dispatched` for ever with a missing review as the only
     * symptom. It cost two long hunts before the reason was carried at all.
     *
     * What the body can hold is bounded by construction: `apiError` emits
     * `{error:{code,message,details}}`, and the only details this route produces are
     * `zodDetails` — field PATH, zod code and zod message — or a fixed correlation
     * message. Never a field VALUE, so the prompt and the result cannot travel here.
     *
     * 5xx keeps status only: those bodies are ICOS's internals, and a 5xx is an outage to
     * retry rather than a contract to fix.
     */
    let detail = "";
    if (response.status >= 400 && response.status < 500) {
      detail = await response
        .text()
        .then((text) => (text ? ` ${text.slice(0, 500)}` : ""))
        .catch(() => "");
    }
    throw new Error(`ICOS callback ${path} -> HTTP ${response.status}${detail}`);
  }
}

/**
 * WHAT THIS EXECUTION IS ALLOWED TO DO — asked of ICOS, never decided here.
 *
 * Write authority is a property of the TASK, held in ICOS's durable state: its declared
 * risk class, its declared file scope, and the worktree the WorkspaceManager allocated
 * for it before dispatch. None of that is in the workflow payload, and none of it is in
 * this process's environment, so a forged payload or a tampered env cannot manufacture a
 * writer. The worker is told; it does not claim (ADR 0067, amendment A).
 */
export interface ExecutionGrant {
  readonly taskId: string;
  readonly missionId: string;
  readonly workflowId: string;
  readonly goalId: string | null;
  /** Executors ICOS authorised for this task; anything else gets no secrets. */
  readonly credentialScope: readonly string[];
  readonly writeAllowed: boolean;
  readonly workspace: {
    readonly worktreePath: string;
    readonly branch: string;
    readonly baseCommit: string;
    readonly fencingToken: number;
    /** The existing workspace lease. Null means no lease is held at all. */
    readonly leaseExpiresAt: string | null;
  } | null;
  /**
   * WHOSE WORK THIS IS (decision 0063 amendment A): the client/project scope ICOS read from the
   * task's goal. Absent only from a server that predates the carriage.
   */
  readonly scope?: ExecutionScope | null;
  /**
   * THE ROUTED MODEL (decision 0054), from the registration of the worker ICOS routed this
   * attempt to. Substituted for `{{model}}` / `{{provider}}`; absent from a server that
   * predates the carriage, and absent for a worker that declares none.
   */
  readonly model?: string | null;
  readonly provider?: string | null;
}

/**
 * FAIL CLOSED: a scope bound to another task or mission is never run under. The grant route
 * already refuses a task whose lineage disagrees with its goal's client; this is the worker's
 * own check that the scope it is about to export belongs to THIS execution.
 */
export function assertGrantScope(ctx: ExecutionContext, grant: ExecutionGrant): void {
  const scope = grant.scope;
  if (!scope) return;
  if (scope.missionId !== grant.missionId || (scope.taskId ?? ctx.taskId) !== ctx.taskId) {
    throw new Error("WORKER_SCOPE_MISMATCH: le périmètre accordé ne correspond pas à cette tâche");
  }
  if (scope.projectId && !scope.clientId) {
    throw new Error("WORKER_SCOPE_MISMATCH: projet sans client");
  }
}

async function fetchGrant(ctx: ExecutionContext): Promise<ExecutionGrant> {
  const response = await fetch(`${icosBaseUrl()}/api/internal/executions/grant`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-icos-callback-secret": callbackSecret(),
    },
    body: JSON.stringify({ taskId: ctx.taskId, workflowId: ctx.workflowId }),
  });
  if (!response.ok) {
    /*
     * No grant, no run — and a 4xx says WHICH refusal, for the same reason `postJson`
     * does: both sides of this call are ICOS, so a 4xx is a contract bug rather than a
     * runtime condition, and the body is bounded to stable codes and zod field paths.
     * 5xx stays status-only.
     */
    let detail = "";
    if (response.status >= 400 && response.status < 500) {
      detail = await response
        .text()
        .then((text) => (text ? ` ${text.slice(0, 500)}` : ""))
        .catch(() => "");
    }
    throw new Error(`WORKER_GRANT_REFUSED: HTTP ${response.status}${detail}`);
  }
  const payload = (await response.json()) as { grant?: ExecutionGrant };
  if (!payload.grant) throw new Error("WORKER_GRANT_MALFORMED");
  return payload.grant;
}

/**
 * KEEPS ASKING WHETHER THE WRITER MAY STILL WRITE.
 *
 * A fencing token proves authority at the instant it is read, and a long write runs for
 * minutes afterwards. The workspace lease can be lost mid-run — expired, taken over by a
 * recoverer, the workspace released — and the only consequence used to be that the
 * RESULT would be refused later. That is not enough: the process is still writing into a
 * worktree somebody else may now own, and refusing its result does not unwrite the files.
 *
 * THREE ANSWERS, THREE BEHAVIOURS:
 *
 *   revoked / fenced out / released  abort at once; the work has no authority
 *   still mine, same token           authority refreshed to the lease it reports
 *   no answer at all                 keep working, but only as far as the authority
 *                                    already verified actually reaches
 *
 * The third is the subtle one. Killing a live build because one callback timed out turns
 * a network blip into lost work, so silence is tolerated — but never indefinitely, and
 * never past the lease the writer was last told it held. That deadline is the workspace
 * lease ICOS already keeps in the registry, carried on the grant: no second clock, and
 * no way for a grace period to outlast the authority it stands in for. Reaching it
 * without a successful re-read is AUTHORITY_REVALIDATION_TIMEOUT, which aborts exactly
 * as a revocation does.
 */
function watchAuthority(
  ctx: ExecutionContext,
  granted: ExecutionGrant,
  intervalMs: number,
  now: () => number = Date.now,
): { signal: AbortSignal; reason: () => string | null; stop: () => void } {
  const controller = new AbortController();
  let lost: string | null = null;

  /**
   * How far the LAST SUCCESSFUL verification reaches. A workspace holding no lease at
   * all can coast nowhere: authority that was never verifiable is not authority.
   */
  const deadlineFrom = (grant: ExecutionGrant): number => {
    const expiry = grant.workspace?.leaseExpiresAt;
    const parsed = expiry ? Date.parse(expiry) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  let authorityValidUntil = deadlineFrom(granted);

  const revoke = (reason: string): void => {
    lost = reason;
    clearInterval(timer);
    controller.abort();
  };

  const check = async (): Promise<void> => {
    let current: ExecutionGrant;
    try {
      current = await fetchGrant(ctx);
    } catch {
      /*
       * Unreachable is not revoked — but it is not a renewal either. The writer coasts
       * on the authority it last verified, and no further than that.
       */
      if (now() >= authorityValidUntil) revoke("AUTHORITY_REVALIDATION_TIMEOUT");
      return;
    }
    if (!current.writeAllowed) return revoke("WRITE_REVOKED");
    if (!current.workspace || !granted.workspace) return revoke("WORKSPACE_RELEASED");
    if (current.workspace.fencingToken !== granted.workspace.fencingToken) {
      /* Someone else fenced this workspace: this run is no longer its owner. */
      return revoke("FENCED_OUT");
    }
    if (current.workspace.worktreePath !== granted.workspace.worktreePath) {
      return revoke("WORKSPACE_MOVED");
    }
    /* Verified: authority now reaches as far as the lease ICOS has just reported. */
    authorityValidUntil = deadlineFrom(current);
    if (now() >= authorityValidUntil) revoke("AUTHORITY_REVALIDATION_TIMEOUT");
  };

  const timer = setInterval(() => void check(), intervalMs);
  /* Never hold the worker process open on this alone. */
  timer.unref?.();

  return {
    signal: controller.signal,
    reason: () => lost,
    stop: () => clearInterval(timer),
  };
}

/**
 * How often a writer re-checks that it still holds its workspace.
 *
 * Read per run, not frozen at load: unlike the executable allowlist this is operational
 * tuning, not a security boundary — shortening it cannot grant anyone anything.
 */
function authorityCheckIntervalMs(): number {
  const configured = Number(process.env.ICOS_WORKER_AUTHORITY_CHECK_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 5_000;
}

/**
 * The worktree must live under the root THIS process was configured with.
 *
 * The grant is authenticated, so this is not distrust of ICOS; it is the second half of
 * a two-party agreement. A single compromised or misconfigured answer must not be able to
 * point a writer at the canonical checkout, at another task's worktree, or anywhere else
 * on the disk — and `resolve` collapses `..` before the comparison, so a traversal in the
 * path is caught here rather than by the sandbox.
 */
async function assertWorktreeWithinRoot(worktreePath: string): Promise<string> {
  const configured = process.env.ICOS_WORKER_WORKSPACE_ROOT;
  if (!configured) {
    throw new Error("WORKER_WORKSPACE_ROOT_UNDECLARED: ICOS_WORKER_WORKSPACE_ROOT manquant");
  }
  /*
   * REAL paths on both sides. `resolve` collapses `..` but follows no symlink, so a
   * worktree that IS a link to the canonical checkout — or to another task's tree —
   * would pass a purely lexical check and then write wherever the link points.
   */
  const root = await realpath(resolve(configured)).catch(() => {
    throw new Error("WORKER_WORKSPACE_ROOT_UNREADABLE: racine déclarée introuvable");
  });
  /*
   * It must already exist: the WorkspaceManager allocates the worktree BEFORE dispatch,
   * so a path that resolves to nothing is not a race, it is a grant for a workspace that
   * was never created — and creating one here would be exactly the ad-hoc, ungoverned
   * worktree whose branch nothing reviews.
   */
  const worktree = await realpath(resolve(worktreePath)).catch(() => {
    throw new Error("WORKER_WORKSPACE_MISSING: worktree accordé inexistant");
  });
  if (worktree !== root && !worktree.startsWith(`${root}/`)) {
    throw new Error("WORKER_WORKSPACE_OUTSIDE_ROOT: worktree hors de la racine déclarée");
  }
  /*
   * The canonical checkout is never a worktree. Even nested under the root it stays
   * read-only: a writer that reaches it bypasses the branch the IntegrationGate reviews.
   */
  const canonical = process.env.ICOS_REPO_PATH
    ? await realpath(resolve(process.env.ICOS_REPO_PATH)).catch(() =>
        resolve(process.env.ICOS_REPO_PATH as string),
      )
    : null;
  if (canonical && (worktree === canonical || worktree.startsWith(`${canonical}/`))) {
    throw new Error("WORKER_WORKSPACE_IS_CANONICAL: refus d'écrire dans le dépôt canonique");
  }
  return worktree;
}

/**
 * THE WORKTREE'S GIT POINTER IS NOT THE WORKER'S (ADR 0072, phase 0).
 *
 * A linked worktree holds a `.git` FILE naming its gitdir. Writable, it let a worker swap
 * it for a directory whose config runs a command (`core.fsmonitor`) the next time ICOS ran
 * git there — outside the sandbox, with the server's environment. ICOS's own git no longer
 * reads it (`git-authority.ts`), and the worker may no longer change it: the pointer is
 * bound READ-ONLY inside the writable worktree.
 *
 * It must exist as a REGULAR file before the run. A missing pointer would not be bound at
 * all (a backend mounts only what exists), leaving the worker free to create a `.git`; a
 * directory or a link is already tampering. Either is refused before anything starts.
 */
async function assertGitPointer(worktree: string): Promise<string> {
  const pointer = join(worktree, ".git");
  const entry = await lstat(pointer).catch(() => null);
  if (!entry || !entry.isFile()) {
    throw new Error(
      "WORKER_WORKSPACE_GIT_POINTER_INVALID: the worktree's .git must be the regular file git created",
    );
  }
  return pointer;
}

/**
 * Runs the worker under the governed gateway and returns its text result.
 *
 * Throws on failure, which Temporal turns into an activity failure and the workflow turns
 * into a canonical ICOS `failure` callback. Nothing here may report success on its own.
 */
export interface GovernedRun {
  readonly result: string;
  /** Reported by the executor itself. Absent means unreported, never the request. */
  readonly actualExecutor: string;
  readonly actualProvider?: string;
  readonly actualModel?: string;
}

/** The failure type the workflow's retry policy treats as NON-retryable: the run itself failed. */
export const GOVERNED_RUN_FAILURE = "GovernedRunFailure";

const execFileAsync = promisify(execFile);

/**
 * Temporal's try number of this activity when it runs inside a worker; `1` elsewhere
 * (tests, direct calls). Every use is best-effort: the activity never depends on a worker.
 */
export function activityAttempt(): number {
  try {
    return ActivityContext.current().info.attempt;
  } catch {
    return 1;
  }
}

function heartbeatIntervalMs(): number {
  const configured = Number(process.env.ICOS_WORKER_HEARTBEAT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 15_000;
}

/**
 * THE WORKER PROVES IT IS ALIVE while the executor runs (W6 recovery, N1 run 10). Without a
 * heartbeat, a worker killed mid-run left its activity "started" until the 16-minute
 * start-to-close timeout, and the only ways out were a manual kill and a manual Temporal
 * reset. With one, the server sees the silence within `heartbeatTimeout` and schedules the
 * activity's second (and last) try on a live worker. Best-effort outside a worker.
 */
function startHeartbeat(ctx: ExecutionContext): { stop: () => void } {
  const beat = () => {
    try {
      ActivityContext.current().heartbeat({ taskId: ctx.taskId, at: new Date().toISOString() });
    } catch {
      /* not inside a Temporal activity (tests, direct calls): nothing to prove to */
    }
  };
  beat();
  const timer = setInterval(beat, heartbeatIntervalMs());
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * THE SECOND TRY STARTS FROM THE ATTEMPT'S BASE. A worker that died mid-run leaves the
 * worktree with whatever its executor had written (ICOS commits governed work only on a
 * reported success, `finalize-successful-worker-execution`). Re-launching on top of that
 * would hand the writer half of a dead run's edits as if they were the base. Tracked files
 * return to HEAD, untracked files go — except the dependencies installed before the first
 * try, which are the one thing worth keeping.
 */
export async function resetWorktreeForRetry(worktree: string): Promise<void> {
  await execFileAsync("git", ["-C", worktree, "checkout", "--", "."]);
  await execFileAsync("git", ["-C", worktree, "clean", "-fdq", "-e", "node_modules"]);
}

/**
 * Every failure of the run itself is final for Temporal: `GovernedRunFailure`, non-retryable.
 * Only the transport's own timeouts (heartbeat, start-to-close — a dead or hung worker) may
 * trigger the activity's single retry. ICOS's QC keeps deciding RETRY/CORRECT/ESCALATE on the
 * canonical failure code, exactly as before: the message is unchanged.
 */
export async function runGovernedWorker(
  ctx: ExecutionContext,
  prompt: string,
): Promise<GovernedRun> {
  try {
    return await runGovernedWorkerUnguarded(ctx, prompt);
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw ApplicationFailure.create({
      type: GOVERNED_RUN_FAILURE,
      message,
      nonRetryable: true,
      ...(error instanceof Error ? { cause: error } : {}),
    });
  }
}

async function runGovernedWorkerUnguarded(
  ctx: ExecutionContext,
  prompt: string,
): Promise<GovernedRun> {
  /* The declared command for this runtime. No declaration, no execution. */
  const declared = parseWorkerExecCommands(process.env.ICOS_WORKER_EXEC_COMMANDS)[EXECUTOR_RUNTIME];
  if (!declared) {
    throw new Error(
      `WORKER_EXECUTOR_UNDECLARED: ICOS_WORKER_EXEC_COMMANDS has no '${EXECUTOR_RUNTIME}' runtime`,
    );
  }
  /* The ONE budget this run is bounded by: declared per command, else the deployment's. */
  const enforcedTimeoutMs = declared.timeoutMs ?? executionTimeoutMs();
  /*
   * ICOS decides what this execution may do, BEFORE anything is provisioned. Asking
   * first also means a refusal costs no worktree and no subprocess.
   */
  const grant = await fetchGrant(ctx);
  assertGrantScope(ctx, grant);

  /*
   * MAY THIS PROGRAM RUN? Asked of the executable policy, which is default-deny and
   * frozen at load, and is a different question from which secrets it may read.
   */
  const executable = decideExecutable(declared.command, declared.args);
  if (!executable.allowed) {
    throw new Error(`WORKER_EXECUTABLE_DENIED: ${executable.reason}`);
  }

  /*
   * A credential policy is how a KNOWN agent gets its secrets, not a list of who may run.
   *
   * This used to refuse any command absent from the table, which made the table an
   * executable allowlist of exactly two names and left every other declared executor —
   * including a governed writer — unable to run at all. Declaration is the authority for
   * WHICH program runs (it is deployment configuration, not caller input); the table
   * stays the authority for WHICH SECRETS it may read. A command nobody wrote a policy
   * for therefore runs with NO brokered credentials, which is the safe direction.
   */
  const access = EXECUTOR_ACCESS[declared.command] ?? { credentials: [], programPaths: [] };

  /*
   * THE SECRET SCOPE IS ICOS'S DECISION, not the deployment's.
   *
   * The credential set used to follow the declared command alone, so re-declaring the
   * executor changed which secrets a task received without ICOS ever agreeing. A command
   * that HAS a credential policy must therefore be one ICOS authorised for this task; a
   * mismatch is a refusal, not a quieter grant, because the two disagreeing is a
   * misconfiguration and running on would hand out the wrong secrets.
   */
  const executorName = declared.command.split("/").pop() ?? declared.command;
  if (access.credentials.length > 0 && !grant.credentialScope.includes(executorName)) {
    throw new Error(
      `WORKER_CREDENTIAL_SCOPE_MISMATCH: '${executorName}' not authorised for this task`,
    );
  }

  /*
   * A launch command that asks for the routed model must GET one: an empty `--model` would
   * let the CLI run its own default — a routing decision that routed nothing. Refused before
   * anything is provisioned, exactly as the in-process executor refuses it.
   */
  const routed = { model: grant.model ?? undefined, provider: grant.provider ?? undefined };
  const unroutable = (["model", "provider"] as const).filter(
    (key) => declared.args.some((arg) => arg.includes(EXEC_PLACEHOLDERS[key])) && !routed[key],
  );
  if (unroutable.length > 0) {
    throw new Error(
      `WORKER_EXEC_UNROUTABLE: the launch command needs ${unroutable.join(", ")} and the routed worker declares none`,
    );
  }

  /*
   * METERED EGRESS: the adapter must be an absolute, existing file, because it is bound
   * read-only into a sandbox that has nothing else of the host's filesystem.
   */
  const meteredEgress = METERED_EGRESS_EXECUTORS.has(executorName);
  const adapterPath = meteredEgress
    ? await realpath(resolve(declared.command)).then(
        /* The DECLARED path: the sandbox mounts its real target there (and at the real path). */
        () => resolve(declared.command),
        () => {
          throw new Error("WORKER_EGRESS_ADAPTER_MISSING: the declared adapter does not exist");
        },
      )
    : null;

  const scratch = await mkdtemp(join(tmpdir(), "icos-worker-"));
  /*
   * A WRITER RUNS IN THE WORKTREE ICOS ALLOCATED IT, and a reader never writes to the
   * repository at all. The path is validated against this process's own configured root
   * before it is given to the sandbox.
   */
  const worktree =
    grant.writeAllowed && grant.workspace
      ? await assertWorktreeWithinRoot(grant.workspace.worktreePath)
      : null;
  if (grant.writeAllowed && !worktree) {
    throw new Error("WORKER_WORKSPACE_MISSING: écriture accordée sans worktree alloué");
  }
  const gitPointer = worktree ? await assertGitPointer(worktree) : null;
  if (worktree && activityAttempt() > 1) await resetWorktreeForRetry(worktree);
  /*
   * W10 — THE WRITER CAN VERIFY ITS OWN WORK. N1 lab, 2026-10-12 (runs 8–9): the allocated
   * worktree had no node_modules, so `eslint`/`vitest` could not run inside the sandbox, the
   * writer could never prove its lint, the independent reviewer (rightly) kept requesting
   * changes, and three corrections burnt 3.8 M tokens before the cap ended the mission. The
   * dependencies are installed BEFORE launch with the gate's own sandboxed runner: offline
   * (frozen lockfile, read-only pnpm store), no network, ephemeral HOME, no secret — the same
   * confinement the gate uses, not a new one. Fail-closed: no deps ⇒ no writer run.
   */
  const dependencies = worktree ? await ensureWorktreeDependencies(worktree) : "none";
  const workspace = scratch;
  /*
   * Only a WRITER needs watching: a reader holds no worktree, so there is no authority
   * over one to lose, and polling for it would be noise.
   */
  const authority = worktree ? watchAuthority(ctx, grant, authorityCheckIntervalMs()) : null;
  const home = await createEphemeralHome();
  let egress: MeteredEgressProxy | null = null;
  let egressDir: string | null = null;
  try {
    if (meteredEgress) {
      /*
       * One proxy per execution, its socket in a directory of its own that the sandbox sees
       * READ-ONLY. Attribution is the grant's — ICOS's durable answer — never the env's.
       */
      const upstream = workerEgressUpstream();
      egressDir = await mkdtemp(join(tmpdir(), "icos-egress-"));
      egress = await startMeteredEgressProxy({
        socketPath: join(egressDir, "gateway.sock"),
        upstreamBaseUrl: upstream.baseUrl,
        ...(upstream.apiKey ? { upstreamApiKey: upstream.apiKey } : {}),
        fetch: workerEgressFetch(),
        attribution: {
          missionId: grant.missionId,
          ...(grant.goalId ? { goalId: grant.goalId } : {}),
        },
      });
    }
    const capabilities = access.credentials.map((relativePath) => ({
      /* The task owns the capability: task A's grant cannot be replayed for task B. */
      id: `${grant.taskId}:${executorName}:${relativePath}`,
      kind: "file" as const,
      target: relativePath,
    }));
    const contents = new Map<string, string>();
    for (const relativePath of access.credentials) {
      const value = await readFile(join(HOME, relativePath), "utf8").catch(() => undefined);
      if (value !== undefined) contents.set(relativePath, value);
    }
    const broker = brokerCredentials(
      capabilities,
      (c) => contents.get(c.target),
      undefined,
      /* Audited: which task, which workflow, which executor — never a value. */
      { taskId: grant.taskId, workflowId: grant.workflowId, executor: executorName },
    );
    if (!broker.ok) {
      throw new Error(`WORKER_CREDENTIAL_MISSING: ${broker.reason}`);
    }
    await seedHome(home.path, broker.files);

    /*
     * WHERE THE WORK HAPPENS. A writer runs IN its own worktree, so a relative path and
     * `allowed_file_scope: ["."]` both mean that worktree. A reader keeps the previous
     * behaviour exactly: the canonical checkout, bound read-only.
     */
    const root = worktree ?? workspaceRoot();
    /*
     * Literal substitution, never a shell. The declaration owns the invocation shape —
     * including `--no-restore-cwd`, which is load-bearing: hermes otherwise chdirs to its
     * OWN configured project on startup, leaving the directory ICOS bound and outside the
     * sandbox profile, so the run reports the repository "not accessible" from a temp
     * folder. The workspace ICOS declares must be the one the executor runs in.
     */
    const usageFile = join(workspace, "usage.json");
    /*
     * W7 — THE CONSIGNE MATCHES THE AUTHORISATION. The executor refuses every shell command
     * outside its allowlist without any prompt (`--permission-prompts none`); a writer that
     * does not know the allowed forms guesses (`npx eslint …`), is refused, and reports it
     * could not verify (N1 lab runs 8–9). The prompt now states the exact permitted commands
     * and whether the worktree is runnable, from the declaration the executor enforces.
     */
    const launchPrompt = withExecutionEnvironment(prompt, {
      shellPatterns: allowBashPatterns(declared.args),
      dependencies,
    });
    const args = declared.args.map((arg) =>
      arg
        .split(EXEC_PLACEHOLDERS.prompt)
        .join(launchPrompt)
        .split(EXEC_PLACEHOLDERS.workspace)
        .join(workspace)
        .split(EXEC_PLACEHOLDERS.model)
        .join(routed.model ?? "")
        .split(EXEC_PLACEHOLDERS.provider)
        .join(routed.provider ?? ""),
    );
    const pulse = startHeartbeat(ctx);
    const run = await runNonInteractive({
      command: declared.command,
      args,
      /*
       * The declared checkout IS the working directory, so `allowed_file_scope: ["."]`
       * means the repository rather than an empty temp folder.
       */
      cwd: root,
      /*
       * IDENTITY COMES FROM THE GRANT, never from this process's environment.
       *
       * The worker is told which task and workflow it is executing, and those values are
       * the ones ICOS holds durably. A caller who sets ICOS_TASK_ID in the environment
       * cannot change them, because nothing here reads the environment for them — the
       * allow-list below is constructed, not inherited.
       */
      env: {
        /* What every `pnpm` the writer runs must see (W10, run 10 attempt 1): no reinstall. */
        ...(dependencies === "none" ? {} : pnpmOfflineSettings()),
        HOME: home.path,
        /*
         * AND ITS TEMPORARY DIRECTORY TOO. `TMPDIR` is on the child-environment allowlist, so
         * without this the worker inherits the SERVER's — a path the sandbox never grants, so
         * every temp write fails with « Operation not permitted ». git only complains
         * (`xcrun_db`) and commits anyway, but any worker that genuinely needs a temp file
         * would fail for a reason that reads like a bug in the worker.
         *
         * The answer is not to grant another path: the disposable HOME is already writable
         * and already destroyed with the run, so pointing temp INTO it widens nothing.
         */
        TMPDIR: home.path,
        /*
         * WHERE TO REPORT. Hermes is told through `--usage-file` in its declaration;
         * every other executor is told here, so "which program ran" and "how success is
         * reported" stay separate questions and the result contract is not the private
         * convention of one vendor.
         */
        ICOS_WORKER_STATUS_FILE: usageFile,
        ICOS_TASK_ID: grant.taskId,
        ICOS_WORKFLOW_ID: grant.workflowId,
        ICOS_MISSION_ID: grant.missionId,
        ...(grant.goalId ? { ICOS_GOAL_ID: grant.goalId } : {}),
        /*
         * WHOSE WORK, from the grant like every identity above — never from this process's
         * environment, so an inherited ICOS_CLIENT_ID cannot relabel the task.
         */
        ...(grant.scope?.clientId ? { ICOS_CLIENT_ID: grant.scope.clientId } : {}),
        ...(grant.scope?.clientId && grant.scope.projectId
          ? { ICOS_PROJECT_ID: grant.scope.projectId }
          : {}),
        ...(worktree && grant.workspace
          ? {
              ICOS_WORKSPACE_PATH: worktree,
              ICOS_WORKSPACE_BRANCH: grant.workspace.branch,
              ICOS_WORKSPACE_BASE_COMMIT: grant.workspace.baseCommit,
            }
          : {}),
        ...(egress ? { ICOS_EGRESS_SOCKET: egress.socketPath } : {}),
        ...broker.env,
      },
      timeoutMs: enforcedTimeoutMs,
      /* Losing the workspace lease kills the run, and the process group with it. */
      ...(authority ? { abortSignal: authority.signal } : {}),
      sandbox: {
        /*
         * READ_ONLY. The repository is readable and NOT writable: the only writable paths
         * stay the scratch workspace and the disposable HOME, so an analysis mission
         * cannot mutate the checkout it is reading. ~/.ssh, ~/.aws, the real HOME and
         * every unrelated worktree remain outside the profile entirely — Seatbelt's
         * `(deny default)` and Bubblewrap's empty root both mean a path that is not listed
         * does not exist for this process.
         */
        /*
         * The allocated worktree is writable; the canonical checkout never is. For a
         * reader this is unchanged — scratch and HOME only — so granting the writer
         * capability widened nothing for the tasks that do not have it.
         */
        /*
         * NO WRITABLE GITDIR, EVER (ADR 0073). The worker modifies files in its workspace
         * and writes its structured status; it holds no Git authority at all. An earlier
         * design granted it `.git/worktrees/<id>` and `<commondir>/objects` so that it
         * could commit its own work — that is precisely what this decision refuses: the
         * trusted authority revalidates success, ownership, lease and fencing, verifies the
         * declared scope, and materializes the commit itself through `git-authority`. The
         * `.git` pointer stays bound READ-ONLY below, so the worker cannot even redirect
         * its own gitdir.
         */
        readWritePaths: worktree ? [worktree, workspace, home.path] : [workspace, home.path],
        /*
         * A writer still READS the canonical checkout (it branched from it) but may not
         * write there, so it appears in the read-only list even when a worktree exists.
         */
        readOnlyPaths: [
          workspaceRoot(),
          ...access.programPaths,
          /* The pnpm store the worktree's node_modules links into (public packages only). */
          ...(dependencies === "none" ? [] : defaultToolchainReadOnlyPaths()),
          /*
           * Nested inside the writable worktree and still READ-ONLY: both backends let the
           * narrower grant win (ADR 0072, phase 0). A narrowing, never a widening.
           */
          ...(gitPointer ? [gitPointer] : []),
          /* The adapter itself and the egress socket's directory: read-only, nothing more. */
          ...(adapterPath ? [adapterPath] : []),
          ...(egressDir ? [egressDir] : []),
        ],
        /*
         * A remote provider needs the network, so it is granted. Neither Seatbelt nor
         * Bubblewrap can filter by hostname, so this is all-or-nothing and the audit says
         * so rather than implying a per-endpoint policy that does not exist.
         */
        /*
         * EXCEPT for a metered-egress executor: no network namespace of the host's at all.
         * Its one road out is the socket above, and every call on it is metered.
         */
        allowNetwork: !meteredEgress,
      },
    }).finally(() => pulse.stop());

    /*
     * AUTHORITY FIRST. A run that lost its lease must fail for THAT reason, before its
     * output is read: whatever it produced, it produced without the right to, and
     * classifying it as a normal result would let post-revocation work be accepted.
     */
    const lostAuthority = authority?.reason();
    if (lostAuthority) {
      throw new Error(`WORKER_AUTHORITY_LOST: ${lostAuthority}`);
    }

    /*
     * A CONFINEMENT REFUSAL IS NOT AN EMPTY RESULT.
     *
     * The run asks for a sandbox, and `required` is the default: a run announced as
     * confined that is not confined would make the audit lie, so the runner REFUSES to
     * spawn anything and says why — on stderr. The result contract reads stdout only, so
     * the refusal arrived here as `worker returned no structured status: no output`, which
     * is indistinguishable from a worker that started and produced nothing.
     *
     * Those need different answers. One is a deployment fact — there is no confinement
     * mechanism on this platform, so no governed write can run here at all — and the other
     * is a broken worker. Reporting the first as the second cost a long hunt through a
     * governed path that had never executed a single process.
     *
     * The evidence is already in hand: a sandbox was requested and `confinement` came back
     * `"none"`, which the runner only reports when it declined to launch. Still fails
     * closed, with the reason it actually had.
     */
    if (run.confinement === "none") {
      throw new Error(
        "WORKER_SANDBOX_UNAVAILABLE: no confinement mechanism on this platform; " +
          "a governed run is refused rather than executed unconfined",
      );
    }

    /*
     * A BUDGET REFUSAL ENDS THE RUN AS A FAILURE, whatever the worker printed: the work was
     * cut off by ICOS's cap, so it is incomplete by construction, and the refusal is the
     * cause the ledger and the reviewer must see.
     */
    if (egress && egress.stats.denied > 0) {
      throw new Error(`WORKER_BUDGET_DENIED: ${egress.stats.lastDenial ?? "denied"}`);
    }

    if (run.timedOut) {
      /*
       * THE BUDGET THAT ACTUALLY EXPIRED. This said `executionTimeoutMs()` — the
       * deployment-wide default — while the run is bounded by the DECLARED command timeout
       * when there is one. A worker killed after 5 s therefore reported "no result within
       * 900000ms", and a diagnostic that names the wrong number is worse than none.
       */
      throw new Error(`WORKER_TIMEOUT: no result within ${enforcedTimeoutMs}ms`);
    }

    let usage: unknown;
    try {
      usage = JSON.parse(await readFile(usageFile, "utf8"));
    } catch {
      usage = undefined; // fail closed: absent or unreadable status is a failure
    }

    const classified = classifyWorkerRun(run.stdout, usage);
    if (!classified.ok) {
      /*
       * A WORKER THAT DIED SAYING WHY IS NOT A SILENT WORKER.
       *
       * The result contract reads stdout, so a run that printed nothing there and failed on
       * stderr reported `no structured status: no output` — indistinguishable from a worker
       * that started and produced nothing. That is the same mistake as the confinement
       * refusal (aa54ce1), one layer further in, and it cost this lane a second long hunt:
       * `git add` was dying on « index.lock: Operation not permitted » and the only
       * evidence anybody saw was "no output".
       *
       * stderr is therefore carried into the reason when stdout was silent — bounded, like
       * stdout already is, and never allowed to turn a failure into a success.
       *
       * AND REDACTED, through the rule ICOS already owns for exactly this situation. This
       * text comes from OUTSIDE ICOS and now actually reaches the durable ledger and the
       * Cockpit: until the failure report stopped discarding the activity's message in
       * favour of Temporal's wrapper, nothing here could leave the worker. A worker that
       * echoes its own credential while dying must not write it into the business record,
       * and `firstLineRedacted` is the one place that rule lives — a second copy of a
       * redaction rule is the copy that leaks.
       */
      const reason = firstLineRedacted(run.stderr.trim());
      throw new Error(
        reason && !run.stdout.trim()
          ? `${classified.message} (stderr: ${reason})`
          : classified.message,
      );
    }

    /*
     * THE ACTIVITY DOES NOT MATERIALIZE (ADR 0073).
     *
     * It held a `commitWorkerChanges` call, and that was the wrong place twice over. A
     * Temporal activity holds no container: no workspace registry, so it cannot revalidate
     * the lease and the fencing token against DURABLE state, and cannot persist the commit
     * identity the review and the gate then judge — it could only consult its own grant
     * watcher. And it is one of TWO production execution paths, so the in-process external
     * worker path had no materialization at all and every governed write there was refused by
     * the gate as uncommitted.
     *
     * The worker's tree is therefore left exactly as it is, and
     * `finalizeSuccessfulWorkerExecution` captures it ICOS-side at the completion point —
     * one implementation, called by both paths.
     */
    return {
      result: classified.result,
      actualExecutor: declared.command,
      /* Only what the worker itself stated; silence stays silence. */
      ...(classified.model ? { actualModel: classified.model } : {}),
    };
  } finally {
    authority?.stop();
    await egress?.close().catch(() => undefined);
    if (egressDir) await rm(egressDir, { recursive: true, force: true }).catch(() => undefined);
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
  actualExecutor?: string;
  actualProvider?: string;
  actualModel?: string;
}): Promise<void> {
  await postJson("/api/internal/executions/completed", {
    taskId: input.ctx.taskId,
    workflowId: input.ctx.workflowId,
    outcome: "success",
    workerKind: input.workerKind,
    result: input.result,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    ...(input.actualExecutor ? { actualExecutor: input.actualExecutor } : {}),
    ...(input.actualProvider ? { actualProvider: input.actualProvider } : {}),
    ...(input.actualModel ? { actualModel: input.actualModel } : {}),
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

/** What the worktree offers the writer's verification commands. */
export type WorktreeDependencies = "none" | "not_a_package" | "present" | "installed";

const DEFAULT_INSTALL_COMMAND = ["pnpm", "install", "--frozen-lockfile", "--offline"] as const;

async function exists(path: string): Promise<boolean> {
  return fsAccess(path).then(
    () => true,
    () => false,
  );
}

/**
 * Installs the worktree's dependencies when it is a pnpm package without `node_modules`, with the
 * integration gate's sandboxed runner (`ICOS_GATE_COMMANDS.install`, default frozen + offline):
 * no network, ephemeral HOME, read-only pnpm store. A worktree that is not a package (no
 * `package.json` + `pnpm-lock.yaml`) needs nothing. A failed install fails the run closed.
 */
export async function ensureWorktreeDependencies(
  worktree: string,
  runner: Pick<SandboxedCommandRunner, "run"> = new SandboxedCommandRunner(),
): Promise<WorktreeDependencies> {
  const [pkg, lock, modules] = await Promise.all([
    exists(join(worktree, "package.json")),
    exists(join(worktree, "pnpm-lock.yaml")),
    exists(join(worktree, "node_modules")),
  ]);
  if (!pkg || !lock) return "not_a_package";
  if (modules) return "present";
  const install = parseGateCommands(process.env.ICOS_GATE_COMMANDS)?.install ?? [
    ...DEFAULT_INSTALL_COMMAND,
  ];
  const run = await runner.run([...install], {
    cwd: worktree,
    env: offlineInstallEnv(),
    network: false,
  });
  if (run.code !== 0) {
    throw new Error(
      `WORKER_DEPENDENCIES_UNAVAILABLE: ${install.join(" ")} exited ${run.code}: ${run.output.slice(-400)}`,
    );
  }
  return "installed";
}

/** The `--allow-bash` values of the declared launch command, in order. */
export function allowBashPatterns(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "--allow-bash") out.push(args[i + 1]!);
  }
  return out;
}

/** The execution environment, stated to the writer from the declaration the executor enforces. */
export function withExecutionEnvironment(
  prompt: string,
  environment: { shellPatterns: readonly string[]; dependencies: WorktreeDependencies },
): string {
  const lines = [
    prompt,
    "",
    "Execution environment (ICOS sandbox, enforced — not advice):",
    environment.dependencies === "present" || environment.dependencies === "installed"
      ? "- Dependencies are installed in this worktree (node_modules present). Do not install anything."
      : environment.dependencies === "not_a_package"
        ? "- This worktree is not a package: no dependency install is possible."
        : "- No worktree: edit nothing, report only.",
    environment.shellPatterns.length > 0
      ? `- Shell commands permitted, in these exact forms and no other: ${environment.shellPatterns.map((p) => `\`${p}\``).join(" ; ")}`
      : "- No shell command is permitted: edit files only.",
    "- Any other command is refused without a prompt; do not retry it — verify with the permitted forms and report their output.",
  ];
  return lines.join("\n");
}

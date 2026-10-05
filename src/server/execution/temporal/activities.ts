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
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { brokerCredentials, seedHome } from "@/server/workers/process/credential-broker";
import { createEphemeralHome } from "@/server/workers/process/ephemeral-home";
import { runNonInteractive } from "@/server/workers/process/run-process";
import {
  EXEC_PLACEHOLDERS,
  parseWorkerExecCommands,
} from "@/server/workers/execution/exec-command-config";
import type { WorkerRuntimeDescriptor } from "@/core/contracts/worker-registry";

import { decideExecutable } from "@/core/execution/executable-policy";

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
 * CE QUE LE WORKER DOIT POUVOIR ÉCRIRE POUR COMMITER, ET RIEN DE PLUS.
 *
 * Un worktree git ne garde pas son index chez lui : `<worktree>/.git` est un FICHIER qui
 * pointe vers `<canonique>/.git/worktrees/<id>`, et les objets d'un commit vont dans le
 * dépôt d'objets PARTAGÉ. Les deux sont à l'intérieur du dépôt que la politique déclare en
 * lecture seule, donc sans cet accord `git add` meurt sur « index.lock: Operation not
 * permitted » et l'écriture gouvernée n'aboutit jamais (preuves : `sandbox-escape.test.ts`).
 *
 * L'accord est STRICTEMENT ces deux chemins :
 *
 *   - `.git/worktrees/<id>` — le dossier d'administration de CE worktree (index, HEAD,
 *     verrous). Celui des autres reste dehors, donc inaccessible.
 *   - `<commondir>/objects` — de quoi matérialiser blobs, arbres et commit.
 *
 * `.git/refs/**`, `.git/packed-refs`, `.git/config` et `.git/hooks/**` ne sont JAMAIS
 * accordés : le worker rend un SHA sur un HEAD détaché, et c'est ICOS — hors bac à sable,
 * après vérification — qui nomme la branche. Élargir `.git` en bloc rendrait la revue
 * contournable, ce qui est le contraire du but.
 *
 * Résolu par LECTURE DE FICHIERS, sans sous-processus git : `<worktree>/.git` donne le
 * dossier d'administration, et son `commondir` (relatif) donne le dépôt commun. Un worktree
 * dont ces fichiers sont illisibles n'est pas un worktree : on échoue fermé plutôt que de
 * lancer un writer qui ne pourra pas committer.
 */
async function gitWritePathsFor(worktree: string): Promise<string[]> {
  const pointer = await readFile(join(worktree, ".git"), "utf8").catch(() => {
    throw new Error("WORKER_WORKSPACE_NOT_A_WORKTREE: <worktree>/.git illisible");
  });
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!match) {
    throw new Error("WORKER_WORKSPACE_NOT_A_WORKTREE: <worktree>/.git sans 'gitdir:'");
  }
  const admin = resolve(worktree, match[1]);
  /*
   * `commondir` est relatif AU dossier d'administration. Absent, le worktree est en fait un
   * dépôt ordinaire et son propre dossier contient déjà les objets.
   */
  const common = await readFile(join(admin, "commondir"), "utf8")
    .then((text) => resolve(admin, text.trim()))
    .catch(() => admin);
  return [admin, join(common, "objects")];
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

export async function runGovernedWorker(
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
  /*
   * ICOS decides what this execution may do, BEFORE anything is provisioned. Asking
   * first also means a refusal costs no worktree and no subprocess.
   */
  const grant = await fetchGrant(ctx);

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
  const workspace = scratch;
  /*
   * Only a WRITER needs watching: a reader holds no worktree, so there is no authority
   * over one to lose, and polling for it would be noise.
   */
  const authority = worktree ? watchAuthority(ctx, grant, authorityCheckIntervalMs()) : null;
  const home = await createEphemeralHome();
  try {
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
    const args = declared.args.map((arg) =>
      arg
        .split(EXEC_PLACEHOLDERS.prompt)
        .join(prompt)
        .split(EXEC_PLACEHOLDERS.workspace)
        .join(workspace),
    );
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
        ...(worktree && grant.workspace
          ? {
              ICOS_WORKSPACE_PATH: worktree,
              ICOS_WORKSPACE_BRANCH: grant.workspace.branch,
              ICOS_WORKSPACE_BASE_COMMIT: grant.workspace.baseCommit,
            }
          : {}),
        ...broker.env,
      },
      timeoutMs: declared.timeoutMs ?? executionTimeoutMs(),
      /* Losing the workspace lease kills the run, and the process group with it. */
      ...(authority ? { abortSignal: authority.signal } : {}),
      sandbox: {
        /*
         * READ_ONLY. The repository is readable and NOT writable: the only writable paths
         * stay the scratch workspace and the disposable HOME, so an analysis mission
         * cannot mutate the checkout it is reading. ~/.ssh, ~/.aws, the real HOME and
         * every unrelated worktree remain outside the profile entirely — `(deny default)`
         * means a path that is not listed does not exist for this process.
         */
        /*
         * The allocated worktree is writable; the canonical checkout never is. For a
         * reader this is unchanged — scratch and HOME only — so granting the writer
         * capability widened nothing for the tasks that do not have it.
         */
        readWritePaths: worktree
          ? [worktree, workspace, home.path, ...(await gitWritePathsFor(worktree))]
          : [workspace, home.path],
        /*
         * A writer still READS the canonical checkout (it branched from it) but may not
         * write there, so it appears in the read-only list even when a worktree exists.
         */
        readOnlyPaths: [workspaceRoot(), ...access.programPaths],
        /*
         * A remote provider needs the network, so it is granted. Seatbelt cannot filter by
         * hostname, so this is all-or-nothing and the audit says so rather than implying a
         * per-endpoint policy that does not exist.
         */
        allowNetwork: true,
      },
    });

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

    if (run.timedOut) {
      throw new Error(`WORKER_TIMEOUT: no result within ${executionTimeoutMs()}ms`);
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
       */
      const reason = run.stderr.trim().slice(0, 300);
      throw new Error(
        reason && !run.stdout.trim() ? `${classified.message} (stderr: ${reason})` : classified.message,
      );
    }
    return {
      result: classified.result,
      actualExecutor: declared.command,
      /* Only what the worker itself stated; silence stays silence. */
      ...(classified.model ? { actualModel: classified.model } : {}),
    };
  } finally {
    authority?.stop();
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

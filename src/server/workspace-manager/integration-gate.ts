import { sameEffectiveModel } from "@/core/workers/compute-routing";
import { existsSync } from "node:fs";
import path from "node:path";
import { ControlHeldError, type RuntimeControlGuard } from "@/server/control/runtime-control";

import { checkMigrations, effectiveScope, scanSecrets, scanSecurity } from "./checks";
import type { Git } from "./git";
import type { WorkspaceManager } from "./manager";
import type { ConflictStatus, GateReportRecorder, IntegrationReport, StepStatus } from "./report";
import { checkScope } from "./scope";
import { WorkspaceError, type IntegrationDecision, type Workspace } from "./types";

/**
 * What a gate step hands its runner. `env` is the COMPLETE set of variables the gate names
 * — nothing is inherited from this process (P0: the gate runs worker-authored code, see
 * `sandboxed-command-runner.ts`). The gate never sets `network` (H1, ADR 0075): even the
 * PostgreSQL step reaches its database only through `readWritePaths` — the directory holding
 * the gatekeeper's socket (see `disposable-gate-database.ts`).
 */
export interface GateCommandContext {
  cwd: string;
  env: Readonly<Record<string, string>>;
  network: boolean;
  /** Extra host directories the step may see read-write (the database socket directory). */
  readWritePaths?: readonly string[];
}

export interface CommandRunner {
  run(command: string[], ctx: GateCommandContext): Promise<{ code: number; output: string }>;
}

/**
 * One PostgreSQL step's database: created empty for this run (migrations are proven from
 * zero), reachable only as described by the session, destroyed by `close`.
 */
export interface GateDatabaseSession {
  /** Name of the disposable database (and of its role). */
  readonly database: string;
  /** The ONLY database variables the step receives: the per-run URL. */
  readonly env: Readonly<Record<string, string>>;
  /** Host directories the step must see read-write to reach the database. */
  readonly readWritePaths: readonly string[];
  /** Values never to be kept in a report (the per-run password). */
  readonly secrets: readonly string[];
  /** The step command, wrapped so it reaches the database from an unshared network. */
  wrap(command: readonly string[]): string[];
  /** Connections refused by the gatekeeper during the run (evidence). */
  refusals(): readonly string[];
  /** Cuts every connection and drops the database and role. Always called. */
  close(): Promise<void>;
}

export interface GateDatabase {
  open(ws: Workspace): Promise<GateDatabaseSession>;
}

export interface GateOptions {
  review?: {
    verdict: "APPROVED" | "CHANGES_REQUESTED";
    reviewer: string;
    /**
     * EFFECTIVE identities (decision 0054), resolved from durable rows. Absent = unknown: never
     * guessed, and never treated as "different".
     */
    reviewerWorkerId?: string;
    reviewerModel?: string;
    writerModel?: string;
  };
  /** Approbation humaine explicite ; ne peut pas venir du worker lui-même. */
  humanApprovedBy?: string;
  /** Mandatory durable ownership evidence for autonomous gate mutations. */
  lease: { owner: string; fencingToken: number };
}

export interface GateCommands {
  install: string[];
  typecheck: string[];
  lint: string[];
  unit: string[];
  postgres: string[][];
  build: string[];
}

const DEFAULT_COMMANDS: GateCommands = {
  install: ["pnpm", "install", "--frozen-lockfile", "--offline"],
  typecheck: ["pnpm", "run", "typecheck"],
  lint: ["pnpm", "run", "lint"],
  unit: ["pnpm", "test"],
  postgres: [
    ["pnpm", "run", "test:db:setup"],
    ["pnpm", "run", "test:integration"],
  ],
  build: ["pnpm", "build"],
};

interface Outcome {
  /** Décision bloquante (arrête la gate) ou à valider par un humain (la gate continue). */
  decision?: Exclude<IntegrationDecision, "ACCEPT">;
  reasons?: string[];
}

interface GateDeps {
  git: Git;
  manager: WorkspaceManager;
  runner: CommandRunner;
  database: GateDatabase;
  commands?: Partial<GateCommands>;
  /** Runtime control (decision 0055): integration refused while not allowed. Wired by the container. */
  control?: Pick<RuntimeControlGuard, "integration">;
  /** Durable record of every report (see `report.ts`). Recorded BEFORE the transition. */
  reports?: GateReportRecorder;
}

/**
 * Integration Gate local : évalue un commit worker contre la cible d'intégration.
 * Ne merge rien : ACCEPT signifie « prêt à être intégré », l'intégration reste humaine/contrôlée.
 */
export class IntegrationGate {
  private readonly git: Git;
  private readonly manager: WorkspaceManager;
  private readonly runner: CommandRunner;
  private readonly database: GateDatabase;
  private readonly commands: GateCommands;

  private readonly control?: Pick<RuntimeControlGuard, "integration">;
  private readonly reports?: GateReportRecorder;

  constructor(deps: GateDeps) {
    ({ git: this.git, manager: this.manager, runner: this.runner, database: this.database } = deps);
    this.commands = { ...DEFAULT_COMMANDS, ...deps.commands };
    this.control = deps.control;
    this.reports = deps.reports;
  }

  async integrate(workspaceId: string, options: GateOptions): Promise<IntegrationReport> {
    // Control plane first: refused before any workspace transition or evaluation (fail closed).
    if (this.control) {
      const decision = await this.control.integration();
      if (!decision.allowed) throw new ControlHeldError(decision.reason, `integration of ${workspaceId}`);
    }
    let ws = await this.manager.get(workspaceId);
    const precondition = (why: string) =>
      new WorkspaceError("GATE_PRECONDITION", `${workspaceId}: ${why}`);
    if (options.humanApprovedBy === ws.workerId) {
      throw new WorkspaceError(
        "APPROVAL_INVALID",
        "un worker ne peut pas approuver son propre travail",
      );
    }
    if (ws.releasedAt || (ws.status !== "ready_for_integration" && ws.status !== "integrating")) {
      throw precondition(`statut ${ws.status} (ready_for_integration ou integrating requis)`);
    }
    if (!existsSync(ws.worktreePath)) throw precondition("worktree absent");
    if ((await this.git.statusPorcelain(ws.worktreePath)).length > 0) {
      throw precondition("changements non commités : le gate n'évalue que des commits");
    }
    const head = await this.git.headCommit(ws.worktreePath);
    if (ws.status === "ready_for_integration") {
      ws = await this.manager.transition(
        workspaceId,
        "integrating",
        options.lease.owner,
        options.lease.fencingToken,
      );
    }
    await this.manager.recordSourceCommit(
      workspaceId,
      head,
      options.lease.owner,
      options.lease.fencingToken,
    );

    const others = (await this.manager.list()).filter(
      (w) => w.workspaceId !== workspaceId && w.releasedAt === null,
    );
    await this.manager.assertLease(
      workspaceId,
      options.lease.owner,
      options.lease.fencingToken,
    );

    const report = await this.evaluate(ws, head, others, options);
    /*
     * DURABLE BEFORE IT TAKES EFFECT. A verdict nobody can read back afterwards is not
     * evidence; if the record fails, the workspace stays `integrating` and the gate retries.
     */
    await this.reports?.record(report, { missionId: ws.missionId, taskId: ws.taskId });

    const next = { ACCEPT: "accepted", REJECT: "rejected", NEEDS_REBASE: "working" } as const;
    if (report.decision !== "NEEDS_HUMAN_APPROVAL") {
      await this.manager.transition(
        workspaceId,
        next[report.decision],
        options.lease.owner,
        options.lease.fencingToken,
      );
    }
    return report;
  }

  private async evaluate(
    ws: Workspace,
    head: string,
    others: Workspace[],
    options: GateOptions,
  ): Promise<IntegrationReport> {
    const { git } = this;
    const target = await git.resolveCommit(ws.integrationTarget);
    const report: IntegrationReport = {
      workspaceId: ws.workspaceId,
      workerId: ws.workerId,
      branch: ws.branch,
      worktree: ws.worktreePath,
      baseCommit: ws.baseCommit,
      targetCommit: target,
      testDatabase: ws.testDatabase,
      fileScopeStatus: "SKIPPED",
      sharedFilesChanged: [],
      migrations: [],
      typecheck: "SKIPPED",
      lint: "SKIPPED",
      unitTests: "SKIPPED",
      postgresTests: "SKIPPED",
      build: "SKIPPED",
      secretCheck: "SKIPPED",
      conflictStatus: "SKIPPED",
      conflictFiles: [],
      decision: "ACCEPT",
      commitSha: head,
      reasons: [],
    };
    const changed = await git.changedFiles(ws.baseCommit, head);
    const added = await git.addedLines(ws.baseCommit, head);
    const stepStatus = (o: Outcome): StepStatus =>
      o.decision === "REJECT" || o.decision === "NEEDS_REBASE" ? "FAIL" : "PASS";

    const steps: [string, () => Promise<Outcome>][] = [
      [
        "scope",
        async () => {
          const scope = checkScope(
            effectiveScope(ws),
            changed.map((c) => c.path),
          );
          report.fileScopeStatus = scope.status;
          report.sharedFilesChanged = scope.shared;
          if (scope.forbidden.length)
            return {
              decision: "REJECT",
              reasons: [`fichiers interdits : ${scope.forbidden.join(", ")}`],
            };
          if (scope.outOfScope.length)
            return {
              decision: "REJECT",
              reasons: [`fichiers hors périmètre : ${scope.outOfScope.join(", ")}`],
            };
          return {};
        },
      ],
      [
        "secret",
        async () => {
          const findings = scanSecrets(changed, added);
          report.secretCheck = findings.length ? "FAIL" : "PASS";
          return findings.length
            ? {
                decision: "REJECT",
                reasons: findings.map((f) => `secret suspect : ${f.file} (${f.rule})`),
              }
            : {};
        },
      ],
      [
        "migration",
        async () => {
          const [targetFiles, baseFiles] = await Promise.all([
            git.listDir(target, "drizzle"),
            git.listDir(ws.baseCommit, "drizzle"),
          ]);
          const m = checkMigrations({
            changed,
            added,
            reservation: ws.migrationReservation,
            targetFiles,
            baseFiles,
          });
          report.migrations = m.added;
          return { decision: m.decision ?? undefined, reasons: m.reasons };
        },
      ],
      [
        "typecheck",
        () =>
          this.command(
            ws,
            "typecheck",
            (s) => (report.typecheck = s),
            [this.commands.typecheck],
            { withInstall: true },
          ),
      ],
      ["lint", () => this.command(ws, "lint", (s) => (report.lint = s), [this.commands.lint])],
      [
        "unit",
        () =>
          this.command(ws, "tests unitaires", (s) => (report.unitTests = s), [this.commands.unit]),
      ],
      [
        "postgres",
        async () => {
          await this.manager.assertLease(
            ws.workspaceId,
            options.lease.owner,
            options.lease.fencingToken,
          );
          /*
           * H1 (ADR 0075): no network, no shared credential. A database created for this run,
           * reachable only through the gatekeeper's socket, dropped whatever happens.
           */
          const database = await this.database.open(ws);
          try {
            const outcome = await this.command(
              ws,
              "tests PostgreSQL",
              (s) => (report.postgresTests = s),
              this.commands.postgres,
              { database },
            );
            const refused = database.refusals();
            if (refused.length === 0) return outcome;
            /* Said, not decisive: the step's own exit status is the verdict. */
            return {
              ...outcome,
              reasons: [
                ...(outcome.reasons ?? []),
                `base jetable : ${refused.length} connexion(s) refusée(s) — ${refused.slice(0, 3).join(" ; ")}`,
              ],
            };
          } finally {
            await database.close();
          }
        },
      ],
      ["build", () => this.command(ws, "build", (s) => (report.build = s), [this.commands.build])],
      [
        "diff",
        async () => {
          if (changed.length === 0)
            return { decision: "REJECT", reasons: ["diff vide : rien à intégrer"] };
          if (!(await git.isAncestor(ws.baseCommit, head)))
            return {
              decision: "REJECT",
              reasons: ["la base enregistrée n'est pas ancêtre du commit"],
            };
          const check = await git.diffCheck(ws.baseCommit, head);
          return check.ok
            ? {}
            : { decision: "REJECT", reasons: [`git diff --check : ${check.output.slice(0, 200)}`] };
        },
      ],
      [
        "security",
        async () => {
          const s = scanSecurity(changed, added);
          const reasons = [
            ...s.governance.map((f) => `security : fichier de gouvernance modifié ${f}`),
            ...s.weakening.map((f) => `security : ${f.rule} (${f.file})`),
          ];
          return reasons.length ? { decision: "NEEDS_HUMAN_APPROVAL", reasons } : {};
        },
      ],
      [
        "conflict",
        async () => {
          if (await git.isAncestor(target, head)) {
            const mine = new Set(changed.map((c) => c.path));
            const overlaps = new Set<string>();
            for (const o of others) {
              /*
               * LE TRAVAIL DE L'AUTRE WORKER, OÙ QU'IL SOIT ENCORE.
               *
               * Les writers sont alloués sur un HEAD DÉTACHÉ : le commit d'un pair n'est porté
               * par sa branche qu'après que le coordinateur l'a nommé. Ne regarder que la
               * branche ferait donc dépendre la détection d'un conflit multi-worker de
               * l'ORDRE dans lequel les pairs ont été nommés — et un pair pas encore nommé
               * paraîtrait n'avoir rien changé, donc deux workers modifiant le même fichier
               * partagé passeraient tous les deux sans validation humaine.
               *
               * L'arbre de travail du pair, quand il existe, est la source la plus à jour ; sa
               * branche sert quand le worktree a déjà été retiré. Les deux sont des LECTURES.
               */
              const tip = existsSync(o.worktreePath)
                ? await git.headCommit(o.worktreePath).catch(() => null)
                : null;
              const peer = tip ?? ((await git.branchExists(o.branch)) ? o.branch : null);
              if (!peer) continue;
              for (const f of await git.changedFiles(o.baseCommit, peer))
                if (mine.has(f.path)) overlaps.add(f.path);
            }
            report.conflictStatus = overlaps.size ? "MULTI_WORKER" : "CLEAN";
            return overlaps.size
              ? {
                  decision: "NEEDS_HUMAN_APPROVAL",
                  reasons: [
                    `fichiers modifiés par plusieurs workers : ${[...overlaps].join(", ")}`,
                  ],
                }
              : {};
          }
          report.conflictFiles = await git.mergeConflicts(target, head);
          const status: ConflictStatus = report.conflictFiles.length ? "CONFLICT" : "BEHIND";
          report.conflictStatus = status;
          return {
            decision: "NEEDS_REBASE",
            reasons: [
              status === "CONFLICT"
                ? `conflits avec ${ws.integrationTarget} (à résoudre par un humain/agent d'intégration) : ${report.conflictFiles.join(", ")}`
                : `base obsolète : ${ws.integrationTarget} a avancé, rebase requis`,
            ],
          };
        },
      ],
      [
        "review",
        async () => {
          const r = options.review;
          if (r?.verdict === "CHANGES_REQUESTED")
            return {
              decision: "REJECT",
              reasons: [`revue : changements demandés par ${r.reviewer}`],
            };
          if (!r) return { decision: "NEEDS_HUMAN_APPROVAL", reasons: ["revue absente"] };
          if (r.reviewer === ws.workerId || r.reviewerWorkerId === ws.workerId)
            return {
              decision: "NEEDS_HUMAN_APPROVAL",
              reasons: ["auto-revue : le reviewer est le worker"],
            };
          /*
           * SAME MODEL = SAME JUDGE (decision 0054). A different worker running the model that
           * wrote the change is not an independent review, whichever account or route served it.
           */
          if (r.reviewerModel && r.writerModel && sameEffectiveModel(r.reviewerModel, r.writerModel))
            return {
              decision: "NEEDS_HUMAN_APPROVAL",
              reasons: [
                `auto-revue : même modèle en écriture (${r.writerModel}) et en revue (${r.reviewerModel})`,
              ],
            };
          /*
           * UNKNOWN IS SAID, NOT HIDDEN. When either effective model is unknown (an unsteered
           * writer running a CLI default, an unrouted command reviewer) independence could not
           * be verified. The decision is unchanged — refusing on unknown would stop every
           * pre-0054 deployment — but the report says so, durably.
           */
          if (r.reviewer === "llm" && (!r.reviewerModel || !r.writerModel))
            return { reasons: ["indépendance non vérifiée : modèle effectif inconnu (écriture ou revue)"] };
          return {};
        },
      ],
    ];

    let human = false;
    for (const [, run] of steps) {
      if (report.decision !== "ACCEPT" && report.decision !== "NEEDS_HUMAN_APPROVAL") break;
      const outcome = await run();
      report.reasons.push(...(outcome.reasons ?? []));
      if (stepStatus(outcome) === "FAIL") {
        report.decision = outcome.decision!;
      } else if (outcome.decision === "NEEDS_HUMAN_APPROVAL") human = true;
    }
    if (report.decision === "ACCEPT" && human) {
      if (options.humanApprovedBy) report.reasons.push(`approuvé par ${options.humanApprovedBy}`);
      else report.decision = "NEEDS_HUMAN_APPROVAL";
    }
    return report;
  }

  /**
   * Lance les commandes dans le worktree, SOUS LE BAC À SABLE du runner.
   *
   * L'environnement est CONSTRUIT, jamais hérité : ces commandes exécutent le code écrit par
   * le worker (tests, configurations, scripts), qui ne doit voir aucun secret du serveur.
   * Aucune étape n'a le réseau ; seule l'étape PostgreSQL reçoit une URL de base, celle de sa
   * base jetable (H1). `verify-deps-before-run` est coupé : l'installation est une étape
   * explicite (`install`), pas un effet de bord de `pnpm run`.
   */
  private async command(
    ws: Workspace,
    label: string,
    set: (s: StepStatus) => void,
    commands: string[][],
    {
      withInstall = false,
      database,
    }: { withInstall?: boolean; database?: GateDatabaseSession } = {},
  ): Promise<Outcome> {
    const env: Record<string, string> = {
      CI: "1",
      npm_config_verify_deps_before_run: "false",
      pnpm_config_verify_deps_before_run: "false",
      ...database?.env,
    };
    const list =
      withInstall && !existsSync(path.join(ws.worktreePath, "node_modules"))
        ? [this.commands.install, ...commands]
        : commands;
    const redact = (text: string) =>
      (database?.secrets ?? []).reduce((t, secret) => t.split(secret).join("***"), text);
    for (const command of list) {
      const run = await this.runner.run(database ? database.wrap(command) : command, {
        cwd: ws.worktreePath,
        env,
        network: false,
        ...(database ? { readWritePaths: database.readWritePaths } : {}),
      });
      const code = run.code;
      const output = redact(run.output);
      if (code !== 0) {
        set("FAIL");
        return {
          decision: "REJECT",
          reasons: [
            `${label} en échec (${command.join(" ")}) : ${output.slice(-300).replace(/\s+/g, " ")}`,
          ],
        };
      }
    }
    set("PASS");
    return {};
  }
}

/**
 * Parses deployment-configured gate commands (M9).
 *
 * THROWS on malformed configuration rather than silently keeping the pnpm defaults: a gate
 * that runs the wrong verification commands still reports PASS, which is the most dangerous
 * possible failure mode for the component that authorises integration.
 */
export function parseGateCommands(raw?: string | null): Partial<GateCommands> | undefined {
  if (!raw || raw.trim() === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `GATE_COMMANDS_INVALID_JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  /*
   * The EXECUTABLE must be non-empty; later arguments may legitimately be empty strings
   * (`node -e ""` is a valid command), so only the first element is constrained.
   */
  const isArgv = (v: unknown): v is string[] =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => typeof x === "string") &&
    typeof v[0] === "string" &&
    v[0].length > 0;

  const out: Partial<GateCommands> = {};
  const record = parsed as Record<string, unknown>;
  for (const key of ["install", "typecheck", "lint", "unit", "build"] as const) {
    if (record[key] === undefined) continue;
    if (!isArgv(record[key])) throw new Error(`GATE_COMMANDS_INVALID: ${key} must be a non-empty argv array`);
    out[key] = record[key] as string[];
  }
  if (record.postgres !== undefined) {
    const list = record.postgres;
    if (!Array.isArray(list) || !list.every(isArgv)) {
      throw new Error("GATE_COMMANDS_INVALID: postgres must be an array of argv arrays");
    }
    out.postgres = list as string[][];
  }
  return out;
}

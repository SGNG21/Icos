import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { checkMigrations, effectiveScope, scanSecrets, scanSecurity } from "./checks";
import type { Git } from "./git";
import { assertWorkerDatabaseName } from "./guards";
import type { WorkspaceManager } from "./manager";
import type { ConflictStatus, IntegrationReport, StepStatus } from "./report";
import { checkScope } from "./scope";
import { workerDatabaseUrl } from "./test-database";
import { WorkspaceError, type IntegrationDecision, type Workspace } from "./types";

export interface CommandRunner {
  run(
    command: string[],
    ctx: { cwd: string; env: NodeJS.ProcessEnv },
  ): Promise<{ code: number; output: string }>;
}

/** Exécute une commande sans shell. */
export class ProcessCommandRunner implements CommandRunner {
  run(
    command: string[],
    ctx: { cwd: string; env: NodeJS.ProcessEnv },
  ): Promise<{ code: number; output: string }> {
    const [bin, ...args] = command;
    return new Promise((resolve) => {
      execFile(
        bin!,
        args,
        { ...ctx, maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ code, output: `${stdout}\n${stderr}`.trim() });
        },
      );
    });
  }
}

export interface GateDatabase {
  /** Recrée la base dédiée à vide : les migrations sont ainsi prouvées depuis zéro. */
  reset(name: string): Promise<void>;
}

export interface GateOptions {
  review?: { verdict: "APPROVED" | "CHANGES_REQUESTED"; reviewer: string };
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

  constructor(deps: GateDeps) {
    ({ git: this.git, manager: this.manager, runner: this.runner, database: this.database } = deps);
    this.commands = { ...DEFAULT_COMMANDS, ...deps.commands };
  }

  async integrate(workspaceId: string, options: GateOptions): Promise<IntegrationReport> {
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
            true,
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
          assertWorkerDatabaseName(ws.testDatabase);
          await this.manager.assertLease(
            ws.workspaceId,
            options.lease.owner,
            options.lease.fencingToken,
          );
          await this.database.reset(ws.testDatabase);
          return this.command(
            ws,
            "tests PostgreSQL",
            (s) => (report.postgresTests = s),
            this.commands.postgres,
          );
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
              if (!(await git.branchExists(o.branch))) continue;
              for (const f of await git.changedFiles(o.baseCommit, o.branch))
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
          if (r.reviewer === ws.workerId)
            return {
              decision: "NEEDS_HUMAN_APPROVAL",
              reasons: ["auto-revue : le reviewer est le worker"],
            };
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

  /** Lance les commandes dans le worktree ; la DB de test dédiée remplace toute URL de base héritée. */
  private async command(
    ws: Workspace,
    label: string,
    set: (s: StepStatus) => void,
    commands: string[][],
    withInstall = false,
  ): Promise<Outcome> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env))
      if (/(^|_)(DATABASE_URL|POSTGRES_URL)$|^PGDATABASE$/.test(key)) delete env[key];
    env.ICOS_TEST_DATABASE_URL = workerDatabaseUrl(ws.testDatabase);
    const list =
      withInstall && !existsSync(path.join(ws.worktreePath, "node_modules"))
        ? [this.commands.install, ...commands]
        : commands;
    for (const command of list) {
      const { code, output } = await this.runner.run(command, { cwd: ws.worktreePath, env });
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

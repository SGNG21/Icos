/**
 * CLI du Workspace Manager / Integration Gate (docs/icos/workspace-manager.md).
 *   pnpm workspace:manager request --slug 7d --worker w1 --scope-file scope.json [--migrations 1]
 *   pnpm workspace:manager create <id> | list | transition <id> <status> --actor a
 *   pnpm workspace:manager gate <id> [--reviewer r] [--verdict APPROVED] [--approved-by human]
 *   pnpm workspace:manager cleanup <id>
 * Ne merge rien. Le registre vit hors dépôt : <racine des worktrees>/.registry.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Git } from "../src/server/workspace-manager/git";
import { DEFAULT_WORKTREE_ROOT } from "../src/server/workspace-manager/guards";
import {
  IntegrationGate,
  ProcessCommandRunner,
} from "../src/server/workspace-manager/integration-gate";
import { WorkspaceManager } from "../src/server/workspace-manager/manager";
import { FileWorkspaceRegistry } from "../src/server/workspace-manager/registry";
import { formatReport } from "../src/server/workspace-manager/report";
import { PostgresTestDatabaseProvisioner } from "../src/server/workspace-manager/test-database";
import { WORKSPACE_STATUSES, type WorkspaceStatus } from "../src/server/workspace-manager/types";

const EXIT = { ACCEPT: 0, REJECT: 10, NEEDS_REBASE: 11, NEEDS_HUMAN_APPROVAL: 12 } as const;

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      slug: { type: "string" },
      worker: { type: "string" },
      mission: { type: "string" },
      task: { type: "string" },
      "scope-file": { type: "string" },
      migrations: { type: "string" },
      target: { type: "string" },
      base: { type: "string" },
      actor: { type: "string" },
      reviewer: { type: "string" },
      verdict: { type: "string" },
      "approved-by": { type: "string" },
    },
  });
  const [command, id, status] = positionals;
  const git = new Git(process.cwd());
  const provisioner = new PostgresTestDatabaseProvisioner();
  const manager = new WorkspaceManager({
    git,
    provisioner,
    registry: new FileWorkspaceRegistry(
      path.join(DEFAULT_WORKTREE_ROOT, ".registry", "workspaces.json"),
    ),
  });
  const need = (v: string | undefined, what: string): string => {
    if (!v) throw new Error(`argument manquant : ${what}`);
    return v;
  };
  const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

  switch (command) {
    case "request":
      print(
        await manager.request({
          slug: need(values.slug, "--slug"),
          workerId: need(values.worker, "--worker"),
          missionId: values.mission,
          taskId: values.task,
          integrationTarget: values.target,
          baseCommit: values.base,
          migrations: values.migrations ? Number(values.migrations) : undefined,
          fileScope: JSON.parse(readFileSync(need(values["scope-file"], "--scope-file"), "utf8")),
        }),
      );
      return 0;
    case "create":
      print(await manager.create(need(id, "<id>"), values.actor));
      return 0;
    case "list":
      print(await manager.list());
      return 0;
    case "transition":
      if (!WORKSPACE_STATUSES.includes(status as WorkspaceStatus))
        throw new Error(`statut inconnu : ${status}`);
      print(
        await manager.transition(
          need(id, "<id>"),
          status as WorkspaceStatus,
          need(values.actor, "--actor"),
        ),
      );
      return 0;
    case "cleanup":
      print(await manager.cleanup(need(id, "<id>")));
      return 0;
    case "gate": {
      const gate = new IntegrationGate({
        git,
        manager,
        runner: new ProcessCommandRunner(),
        database: provisioner,
      });
      const report = await gate.integrate(need(id, "<id>"), {
        review: values.reviewer
          ? {
              reviewer: values.reviewer,
              verdict: values.verdict === "CHANGES_REQUESTED" ? "CHANGES_REQUESTED" : "APPROVED",
            }
          : undefined,
        humanApprovedBy: values["approved-by"],
      });
      const text = formatReport(report);
      console.log(text);
      mkdirSync(manager.archiveDir, { recursive: true });
      writeFileSync(
        path.join(manager.archiveDir, `${report.workspaceId}.report.txt`),
        `${text}\n`,
        { flag: "w" },
      );
      return EXIT[report.decision];
    }
    default:
      throw new Error("commande : request | create | list | transition | gate | cleanup");
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);

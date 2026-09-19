import type { Git } from "./git";
import { WorkspaceError, type MigrationReservation, type Workspace } from "./types";

const MIGRATION_FILE = /^(\d{4})_.+\.sql$/;

function maxNumber(files: readonly string[]): number {
  return files.reduce((max, f) => Math.max(max, Number(MIGRATION_FILE.exec(f)?.[1] ?? -1)), -1);
}

/**
 * Réserve `count` numéros consécutifs au-delà de tout ce qui existe dans la base du workspace,
 * la cible d'intégration et les réservations des workspaces actifs. Le worker nomme ses fichiers
 * `NNNN_<namespace>_<nom>.sql` ; l'Integration Agent renumérote si la cible a avancé.
 */
export async function reserveMigrations(
  git: Git,
  refs: { baseCommit: string; integrationTarget: string },
  active: readonly Workspace[],
  slug: string,
  count: number,
): Promise<MigrationReservation> {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new WorkspaceError("MIGRATION_INVALID", "count doit être un entier entre 1 et 20");
  }
  const [base, target] = await Promise.all([
    git.listDir(refs.baseCommit, "drizzle"),
    git.listDir(refs.integrationTarget, "drizzle"),
  ]);
  const reserved = active.map((w) => w.migrationReservation?.to ?? -1);
  const from = Math.max(maxNumber(base), maxNumber(target), ...reserved) + 1;
  return { from, to: from + count - 1, namespace: `ws_${slug.replace(/-/g, "_")}` };
}

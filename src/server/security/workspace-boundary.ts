import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";

/**
 * F4.1 (Phase 2 hardening) — Frontière du workspace autorisé.
 *
 * INVARIANT (fail-closed) : un worker n'exécute et n'écrit QUE dans le
 * worktree qui lui a été assigné. Un chemin de worktree vide, relatif,
 * inexistant, non-répertoire, ou égal à une racine interdite (racine du
 * dépôt principal) BLOQUE l'exécution. Il n'existe aucun repli implicite
 * vers la racine du dépôt.
 */

export type WorkspaceBoundaryViolation =
  | "empty_worktree_path"
  | "relative_worktree_path"
  | "unresolvable_worktree_path"
  | "not_a_directory"
  | "forbidden_root"
  | "path_outside_workspace";

export class WorkspaceBoundaryError extends Error {
  readonly code: WorkspaceBoundaryViolation;

  constructor(code: WorkspaceBoundaryViolation, message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
    this.code = code;
  }
}

/**
 * Résout et valide le workspace autorisé d'un worker.
 *
 * @param worktreePath chemin assigné (doit être absolu, existant, répertoire)
 * @param forbiddenRoots racines interdites (ex. racine du dépôt principal) ;
 *   toute égalité canonique avec l'une d'elles est une violation.
 * @returns le chemin canonique (realpath) du workspace
 * @throws WorkspaceBoundaryError — toujours fail-closed, jamais de repli.
 */
export async function resolveAuthorizedWorkspace(
  worktreePath: string | null | undefined,
  forbiddenRoots: readonly string[] = [],
): Promise<string> {
  if (!worktreePath || worktreePath.trim() === "") {
    throw new WorkspaceBoundaryError(
      "empty_worktree_path",
      "Worktree non assigné — exécution refusée (fail-closed, pas de repli vers la racine du dépôt)",
    );
  }

  if (!path.isAbsolute(worktreePath)) {
    throw new WorkspaceBoundaryError(
      "relative_worktree_path",
      `Chemin de worktree non absolu : ${worktreePath}`,
    );
  }

  let canonical: string;
  try {
    canonical = await realpath(worktreePath);
  } catch {
    throw new WorkspaceBoundaryError(
      "unresolvable_worktree_path",
      `Chemin de worktree non résolvable : ${worktreePath}`,
    );
  }

  const stats = await stat(canonical);
  if (!stats.isDirectory()) {
    throw new WorkspaceBoundaryError(
      "not_a_directory",
      `Le worktree n'est pas un répertoire : ${canonical}`,
    );
  }

  for (const root of forbiddenRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
    } catch {
      // Racine interdite non résolvable : ignorer cette entrée (elle ne
      // peut pas être le workspace) — la validation positive reste entière.
      continue;
    }
    if (canonical === canonicalRoot) {
      throw new WorkspaceBoundaryError(
        "forbidden_root",
        `Le worktree résolu est une racine interdite (racine du dépôt) : ${canonical}`,
      );
    }
  }

  return canonical;
}

/**
 * Résout un chemin de fichier relatif STRICTEMENT à l'intérieur du
 * workspace. Rejette toute traversée (`..`), tout chemin absolu et tout
 * chemin résolvant au workspace lui-même.
 */
export function resolveInsideWorkspace(workspaceRoot: string, relativePath: string): string {
  const absolute = path.resolve(workspaceRoot, relativePath);
  const relation = path.relative(workspaceRoot, absolute);

  if (relation === "" || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new WorkspaceBoundaryError(
      "path_outside_workspace",
      `Chemin hors du workspace autorisé : ${relativePath} (workspace ${workspaceRoot})`,
    );
  }

  return absolute;
}

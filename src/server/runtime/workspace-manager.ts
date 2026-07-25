import { access, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import * as path from "node:path";

import { createExecutionError } from "./errors";
import type { CredentialResolution } from "./ports";

/**
 * Erreur de workspace typée.
 */
export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * Gestionnaire de workspaces isolés pour D4.
 *
 * Chaque exécution reçoit un workspace isolé sous le root géré.
 * Le root est configurable et par défaut se trouve sous le répertoire
 * temporaire du système.
 *
 * SÉCURITÉ :
 * - Tous les chemins sont résolus en chemins canoniques avant validation
 * - Les traversées `../` sont détectées et refusées
 * - Les symlinks pointant hors du workspace sont détectés et refusés
 * - Le nettoyage vérifie que la cible est bien sous le root géré
 * - Aucune suppression hors du root n'est possible
 */
export class WorkspaceManager {
  /** Root où tous les workspaces sont créés. */
  public readonly workspaceRoot: string;

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot ?? path.join(
      // Selon la plateforme, utiliser un répertoire adapté
      process.env.ICOS_WORKSPACE_ROOT ?? path.join(osTmpDir(), "icos", "workspaces"),
    );
  }

  /**
   * Crée un workspace isolé pour un tenant et run.
   * Le chemin est : <root>/<tenantId>/<runId>/
   * Les répertoires parent sont créés si nécessaire.
   *
   * @throws WorkspaceError si la création échoue
   */
  async createWorkspace(tenantId: string, runId: string): Promise<string> {
    try {
      // Résoudre le root en canonique pour gérer les symlinks système
      // (ex: /tmp → /private/tmp sur macOS).
      const resolvedRoot = await resolveCanonical(this.workspaceRoot);

      // Construire le workspace à partir du root canonique pour garantir
      // que le préfixe correspond.
      const workspacePath = path.join(
        resolvedRoot,
        sanitizePathComponent(tenantId),
        sanitizePathComponent(runId),
      );

      await mkdir(workspacePath, { recursive: true });
      return workspacePath;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(
        `Impossible de créer le workspace: ${error instanceof Error ? error.message : String(error)}`,
        "WORKSPACE_CREATE_FAILED",
      );
    }
  }

  /**
   * Valide qu'un chemin est sûr pour une opération dans le workspace.
   *
   * Vérifications :
   * 1. Le chemin normalisé ne contient pas de `..` traversant hors du workspace
   * 2. Le chemin réel (après résolution des symlinks) est dans le workspace
   * 3. Si la cible est un symlink, elle ne pointe pas hors du workspace
   *
   * @param workspacePath - Chemin absolu du workspace
   * @param targetPath - Chemin (absolu ou relatif) à valider
   * @returns Le chemin canonique résolu
   * @throws WorkspaceError si le chemin n'est pas sûr
   */
  async validatePathInWorkspace(
    workspacePath: string,
    targetPath: string,
  ): Promise<string> {
    // Résoudre le workspace en chemin canonique
    let resolvedWorkspace: string;
    try {
      resolvedWorkspace = await resolveCanonical(workspacePath);
    } catch {
      throw new WorkspaceError(
        `Impossible de résoudre le workspace: ${workspacePath}`,
        "WORKSPACE_RESOLVE_FAILED",
      );
    }

    // Résoudre le chemin cible absolu
    const absoluteTarget = path.isAbsolute(targetPath)
      ? targetPath
      : path.join(resolvedWorkspace, targetPath);

    // Normaliser le chemin
    const normalizedTarget = path.normalize(absoluteTarget);

    // Vérifier que le chemin normalisé commence par le workspace
    // (cela détecte les `../` qui sortent du workspace)
    if (!normalizedTarget.startsWith(resolvedWorkspace + path.sep) &&
        normalizedTarget !== resolvedWorkspace) {
      throw new WorkspaceError(
        `Path traversal detecté: ${targetPath} sort du workspace`,
        "TRAVERSAL_DENIED",
      );
    }

    // Vérifier l'existence et résoudre les symlinks
    try {
      // Vérifier si le chemin ou ses composants sont des symlinks
      await checkPathComponents(absoluteTarget, resolvedWorkspace);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      // Si le fichier n'existe pas encore, on accepte le chemin normalisé
    }

    return normalizedTarget;
  }

  /**
   * Nettoie un workspace de façon sécurisée.
   *
   * Vérifie que le chemin est bien sous le root géré avant de supprimer.
   * Refuse de supprimer le root lui-même.
   *
   * @throws WorkspaceError si le chemin n'est pas sûr à nettoyer
   */
  async releaseWorkspace(workspacePath: string): Promise<void> {
    try {
      const resolvedRoot = await resolveCanonical(this.workspaceRoot);
      let resolvedWorkspace: string;

      try {
        resolvedWorkspace = await resolveCanonical(workspacePath);
      } catch {
        // Si le chemin n'existe plus, on vérifie quand même le path
        // avant de tenter une suppression
        resolvedWorkspace = path.resolve(workspacePath);
      }

      // SEC-D4-09: Vérifier que le workspace est sous le root
      if (!resolvedWorkspace.startsWith(resolvedRoot + path.sep)) {
        throw new WorkspaceError(
          `Cleanup safety: ${workspacePath} n'est pas sous le root géré ${resolvedRoot}`,
          "CLEANUP_ESCAPE_DENIED",
        );
      }

      // Ne jamais supprimer le root lui-même
      if (resolvedWorkspace === resolvedRoot) {
        throw new WorkspaceError(
          "Refus de supprimer le root workspace",
          "CLEANUP_ROOT_DENIED",
        );
      }

      await rm(resolvedWorkspace, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(
        `Erreur de nettoyage: ${error instanceof Error ? error.message : String(error)}`,
        "CLEANUP_FAILED",
      );
    }
  }
}

// ─────────────────────────────────────
// Utilitaires privés
// ─────────────────────────────────────

/**
 * Résout un chemin en chemin canonique (résout les symlinks).
 * Si le chemin n'existe pas, retourne le chemin résolu absolu.
 */
async function resolveCanonical(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Nettoie un composant de chemin pour éviter les injections.
 */
function sanitizePathComponent(component: string): string {
  // Enlever les séparateurs de chemin, les .. et les ./
  return component.replace(/[/\\:*?"<>|]/g, "_").replace(/\.\./g, "_");
}

/**
 * Vérifie les composants d'un chemin pour détecter les symlinks
 * pointant hors du workspace.
 *
 * Parcourt chaque composant du chemin et vérifie que :
 * - Aucun composant n'est un symlink pointant hors du workspace
 * - Le chemin final résolu est dans le workspace
 */
async function checkPathComponents(
  targetPath: string,
  workspacePath: string,
): Promise<void> {
  const resolved = path.resolve(targetPath);
  const parts = resolved.replace(workspacePath, "").split(path.sep).filter(Boolean);

  let current = workspacePath;

  for (const part of parts) {
    current = path.join(current, part);

    try {
      const stats = await import("node:fs").then((fs) =>
        fs.promises.lstat(current),
      );

      if (stats.isSymbolicLink()) {
        const linkTarget = await readlink(current);

        // Résoudre le lien relatif par rapport à son parent
        const resolvedLink = path.resolve(path.dirname(current), linkTarget);
        const canonicalLink = await resolveCanonical(resolvedLink);
        const canonicalWorkspace = await resolveCanonical(workspacePath);

        if (!canonicalLink.startsWith(canonicalWorkspace)) {
          throw new WorkspaceError(
            `Symlink escape detecté: ${current} → ${resolvedLink} hors du workspace`,
            "SYMLINK_ESCAPE_DENIED",
          );
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      // ENOENT = le composant n'existe pas encore, ce n'est pas une erreur
      if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  // Vérification finale : le chemin résolu doit être dans le workspace
  const finalResolved = await resolveCanonical(targetPath);
  const canonicalWorkspace = await resolveCanonical(workspacePath);

  if (!finalResolved.startsWith(canonicalWorkspace)) {
    throw new WorkspaceError(
      `Symlink escape detecté: ${targetPath} → ${finalResolved} hors du workspace`,
      "SYMLINK_ESCAPE_DENIED",
    );
  }
}

/**
 * Retourne le répertoire temporaire adapté à la plateforme.
 */
function osTmpDir(): string {
  return process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? "/tmp";
}

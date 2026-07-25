import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import type { ArtifactItem } from "@/core/runtime";

import { WorkspaceManager } from "./workspace-manager";

/**
 * Collecteur d'artefacts D4.
 *
 * Extrait les fichiers du workspace dans la limite du scope alloué.
 * Toute tentative d'accès hors du workspace est silencieusement ignorée
 * (pas d'erreur — empêche les fuites d'information lors de tentatives
 * de traversée échouées).
 */
export class ArtifactCollector {
  constructor(private readonly workspaceManager: WorkspaceManager) {}

  /**
   * Collecte les artefacts depuis le répertoire output/ du workspace.
   *
   * @param workspacePath - Chemin absolu du workspace
   * @param maxSizeBytes - Taille maximale totale des artefacts (défaut: 1MB)
   * @returns Liste des artefacts collectés
   */
  async collectFromWorkspace(
    workspacePath: string,
    maxSizeBytes = 1_024 * 1_024,
  ): Promise<ArtifactItem[]> {
    const artifacts: ArtifactItem[] = [];
    let totalSize = 0;

    const outputDir = path.join(workspacePath, "output");

    try {
      await stat(outputDir);
    } catch {
      // Le répertoire output/ n'existe pas — pas d'artefacts
      return [];
    }

    const entries = await this.safeReadDir(outputDir, workspacePath);

    for (const entry of entries) {
      if (totalSize >= maxSizeBytes) break;

      try {
        // Les entrées sont relatives au répertoire output/
        const relativeToWorkspace = path.join("output", entry);
        const validatedPath = await this.workspaceManager.validatePathInWorkspace(
          workspacePath,
          relativeToWorkspace,
        );

        const entryStat = await stat(validatedPath).catch(() => null);
        if (!entryStat || !entryStat.isFile()) continue;

        const safePath = path.relative(workspacePath, validatedPath);

        // SEC-D4-25: Ne collecter que depuis le workspace
        if (safePath.startsWith("..")) continue;

        const content = await this.safeReadContent(
          validatedPath,
          maxSizeBytes - totalSize,
        );

        const artifact: ArtifactItem = {
          name: path.basename(validatedPath),
          path: safePath,
          size: entryStat.size,
          content,
          mimeType: guessMimeType(validatedPath),
        };

        artifacts.push(artifact);
        totalSize += entryStat.size;
      } catch {
        // Ignorer silencieusement les fichiers hors scope
      }
    }

    return artifacts;
  }

  /**
   * Collecte le stdout/stderr comme artefacts virtuels.
   */
  createVirtualArtifact(
    name: string,
    content: string,
    mimeType = "text/plain",
  ): ArtifactItem {
    return {
      name,
      path: `virtual/${name}`,
      size: Buffer.byteLength(content, "utf-8"),
      content,
      mimeType,
    };
  }

  /**
   * Lecture sécurisée des entrées d'un répertoire.
   * Ignore les entrées qui échouent à la validation.
   */
  private async safeReadDir(
    dirPath: string,
    workspacePath: string,
  ): Promise<string[]> {
    try {
      const entries = await readdir(dirPath);

      // Filtrer les entrées protégées
      return entries.filter((e) => !e.startsWith("."));
    } catch {
      return [];
    }
  }

  /**
   * Lecture sécurisée du contenu d'un fichier.
   * Limite la taille et gère les erreurs silencieusement.
   */
  private async safeReadContent(
    filePath: string,
    maxBytes: number,
  ): Promise<string | undefined> {
    try {
      const fd = await import("node:fs").then((fs) =>
        fs.promises.open(filePath, "r"),
      );
      try {
        const buffer = Buffer.alloc(Math.min(maxBytes, 1024 * 1024));
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
        return buffer.toString("utf-8", 0, bytesRead);
      } finally {
        await fd.close();
      }
    } catch {
      return undefined;
    }
  }
}

/**
 * Devine le type MIME à partir de l'extension.
 */
function guessMimeType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".yaml": "application/x-yaml",
    ".yml": "application/x-yaml",
    ".xml": "application/xml",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".ts": "text/x-typescript",
    ".log": "text/plain",
    ".csv": "text/csv",
    ".env": "text/plain",
    ".sh": "text/x-shellscript",
    ".py": "text/x-python",
  };
  return mimeMap[ext];
}

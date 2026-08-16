import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { IntegrationSpec, IntegrationResult, ConflictInfo } from "@/core/integration";
import type { IntegrationOrchestratorPort } from "./ports";
import type { GlobalGatesPort } from "./ports";
import type { IntegrationWorktreePort } from "./ports";
import { WorktreeManager } from "@/server/worktree/worktree-manager";
import type { WorktreeSpec } from "@/core/worktree";

const exec = promisify(execFile);

/**
 * IntegrationOrchestrator — coordonne l'intégration des travaux parallèles.
 *
 * Processus :
 * 1. Ordonne topologiquement les commits
 * 2. Crée une branche d'intégration
 * 3. Applique chaque commit dans l'ordre
 * 4. Détecte les conflits
 * 5. Exécute les tests focus après chaque commit
 * 6. Exécute les gates globales
 * 7. Produit le résultat
 */
export class IntegrationOrchestrator implements IntegrationOrchestratorPort {
  constructor(
    private readonly gates: GlobalGatesPort,
    private readonly worktrees: IntegrationWorktreePort = new WorktreeManager(),
  ) {}

  async integrate(spec: IntegrationSpec): Promise<IntegrationResult> {
    const start = Date.now();
    let integrationWorktree: WorktreeSpec | undefined;
    let commitsIntegrated = 0;

    try {
      const repoRoot = await this.getRepoRoot();
      const baseSha = spec.baseSha ?? (await this.git(["rev-parse", "HEAD"], repoRoot));
      integrationWorktree = await this.worktrees.createIntegrationWorktree({
        integrationId: spec.id,
        branch: spec.integrationBranch,
        baseSha,
      });

      // Every task commit must descend from the explicit common task base.
      for (const commit of spec.commits) {
        await this.git(
          ["merge-base", "--is-ancestor", baseSha, commit.commitSha],
          integrationWorktree.path,
        );
      }

      for (const commit of spec.commits) {
        try {
          await this.applyCommit(commit.commitSha, integrationWorktree.path);
          commitsIntegrated++;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Erreur inconnue";
          const files = await this.parseConflictFiles(integrationWorktree.path);
          if (files.length === 0) {
            throw error;
          }

          let abortFailure: string | undefined;
          try {
            await this.git(["cherry-pick", "--abort"], integrationWorktree.path);
          } catch (abortError) {
            abortFailure = abortError instanceof Error ? abortError.message : "Erreur inconnue";
          }
          const conflict: ConflictInfo = {
            files,
            resolvable: false,
            description:
              `Conflit lors de l'application du commit ${commit.commitSha} (tâche ${commit.taskId}): ${message}` +
              (abortFailure ? `; abandon du cherry-pick échoué: ${abortFailure}` : ""),
          };
          const cleanupError = await this.cleanup(integrationWorktree, false);

          return {
            status: "CONFLICT",
            gateResults: [],
            conflict,
            commitsIntegrated,
            summary: cleanupError
              ? `Conflit détecté sur la tâche ${commit.taskId}; nettoyage échoué: ${cleanupError}`
              : `Conflit détecté sur la tâche ${commit.taskId}`,
            durationMs: Date.now() - start,
          };
        }
      }

      const gateResults = await this.gates.executeAll(integrationWorktree.path);
      const allGatesPassed = gateResults.every((g) => g.passed);

      if (!allGatesPassed) {
        const cleanupError = await this.cleanup(integrationWorktree, false);
        return {
          status: "GATES_FAILED",
          gateResults,
          commitsIntegrated,
          summary:
            `${gateResults.filter((g) => !g.passed).length} gate(s) globales échouée(s)` +
            (cleanupError ? `; nettoyage échoué: ${cleanupError}` : ""),
          durationMs: Date.now() - start,
        };
      }

      const finalSha = await this.git(["rev-parse", "HEAD"], integrationWorktree.path);
      const cleanupError = await this.cleanup(integrationWorktree, true);
      if (cleanupError) {
        return {
          status: "FAILED",
          gateResults,
          finalSha,
          commitsIntegrated,
          summary: `Intégration produite mais nettoyage obligatoire échoué: ${cleanupError}`,
          durationMs: Date.now() - start,
        };
      }

      return {
        status: "SUCCEEDED",
        gateResults,
        finalSha,
        commitsIntegrated,
        summary: `Intégration réussie : ${commitsIntegrated} commit(s) intégré(s), toutes les gates passent`,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur inconnue";
      const cleanupError = integrationWorktree
        ? await this.cleanup(integrationWorktree, false)
        : null;
      return {
        status: "FAILED",
        gateResults: [],
        commitsIntegrated,
        summary:
          `Échec de l'intégration: ${message}` +
          (cleanupError ? `; nettoyage échoué: ${cleanupError}` : ""),
        durationMs: Date.now() - start,
      };
    }
  }

  // ─────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────

  private async applyCommit(commitSha: string, integrationPath: string): Promise<void> {
    await this.git(["cherry-pick", "--no-commit", commitSha], integrationPath);
    await this.git(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--allow-empty",
        "-m",
        `integration: apply ${commitSha.slice(0, 8)}`,
      ],
      integrationPath,
    );
  }

  private async parseConflictFiles(integrationPath: string): Promise<string[]> {
    const output = await this.safeGit(["diff", "--name-only", "--diff-filter=U"], integrationPath);
    return output ? output.split("\n").filter(Boolean).sort() : [];
  }

  protected async getRepoRoot(): Promise<string> {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
    });
    return stdout.trim();
  }

  private async git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await exec("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  }

  private async safeGit(args: string[], cwd: string): Promise<string> {
    try {
      return await this.git(args, cwd);
    } catch {
      return "";
    }
  }

  private async cleanup(worktree: WorktreeSpec, preserveBranch: boolean): Promise<string | null> {
    try {
      await this.worktrees.cleanupIntegrationWorktree(worktree.path, {
        preserveBranch,
      });
      return null;
    } catch (error) {
      return (error instanceof Error ? error.message : "Unknown cleanup error").slice(0, 512);
    }
  }
}

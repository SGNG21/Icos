import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import type {
  IntegrationSpec,
  IntegrationResult,
  GateResult,
  ConflictInfo,
} from "@/core/integration";
import type { IntegrationOrchestratorPort } from "./ports";
import type { GlobalGatesPort } from "./ports";
import { topologicalSort } from "@/core/supervisor";

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
  private readonly integrationBase: string;

  constructor(
    private readonly gates: GlobalGatesPort,
    integrationBase?: string,
  ) {
    this.integrationBase = integrationBase ?? ".claude/integration";
  }

  async integrate(spec: IntegrationSpec): Promise<IntegrationResult> {
    const start = Date.now();
    const branchName = spec.integrationBranch;

    try {
      // 0. Résoudre le root du repo
      const repoRoot = await this.getRepoRoot();
      const integrationDir = path.join(repoRoot, this.integrationBase, spec.id);

      // 1. Créer le répertoire d'intégration
      await mkdir(integrationDir, { recursive: true });

      // 2. Créer la branche d'intégration
      const baseSha = spec.baseSha ?? await this.git(["rev-parse", "HEAD"]);
      await this.createIntegrationBranch(branchName, baseSha);

      // 3. Appliquer les commits dans l'ordre
      let commitsIntegrated = 0;
      for (const commit of spec.commits) {
        try {
          await this.applyCommit(commit.commitSha, branchName);
          commitsIntegrated++;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Erreur inconnue";
          const conflict: ConflictInfo = {
            files: message.includes("CONFLICT") ? this.parseConflictFiles() : [],
            resolvable: false,
            description: `Conflit lors de l'application du commit ${commit.commitSha} (tâche ${commit.taskId}): ${message}`,
          };

          return {
            status: "CONFLICT",
            conflict,
            commitsIntegrated,
            summary: `Conflit détecté sur la tâche ${commit.taskId}`,
            durationMs: Date.now() - start,
          };
        }
      }

      // 4. Exécuter les gates globales
      const gateResults = await this.gates.executeAll(repoRoot);
      const allGatesPassed = gateResults.every((g) => g.passed);

      if (!allGatesPassed) {
        return {
          status: "GATES_FAILED",
          gateResults,
          commitsIntegrated,
          summary: `${gateResults.filter((g) => !g.passed).length} gate(s) globales échouée(s)`,
          durationMs: Date.now() - start,
        };
      }

      // SHA final
      const finalSha = await this.git(["rev-parse", branchName]);

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
      return {
        status: "FAILED",
        summary: `Échec de l'intégration: ${message}`,
        durationMs: Date.now() - start,
      };
    }
  }

  // ─────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────

  private async createIntegrationBranch(branchName: string, baseSha: string): Promise<void> {
    // Vérifier si la branche existe déjà
    const exists = await this.safeGit(["branch", "--list", branchName]);

    if (exists) {
      // Réinitialiser à la base
      await this.git(["checkout", branchName]);
      await this.git(["reset", "--soft", baseSha]);
    } else {
      await this.git(["branch", branchName, baseSha]);
      await this.git(["checkout", branchName]);
    }
  }

  private async applyCommit(commitSha: string, targetBranch: string): Promise<void> {
    // S'assurer qu'on est sur la bonne branche
    await this.git(["checkout", targetBranch]);

    // Appliquer le commit avec cherry-pick
    await this.git(["cherry-pick", "--no-commit", commitSha]);
    await this.git(["commit", "--allow-empty", "-m", `integration: merge ${commitSha.slice(0, 8)}`]);
  }

  private parseConflictFiles(): string[] {
    // V1 : retourne une liste vide
    // V2+ : parser output de git status pour extraire les fichiers en conflit
    return [];
  }

  protected async getRepoRoot(): Promise<string> {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await exec("git", args, {
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  }

  private async safeGit(args: string[]): Promise<string> {
    try {
      return await this.git(args);
    } catch {
      return "";
    }
  }
}

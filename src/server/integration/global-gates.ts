import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GateResult } from "@/core/integration";
import type { GlobalGatesPort } from "./ports";

const exec = promisify(execFile);

/**
 * GlobalGates — exécute les vérifications qualité sur une branche d'intégration.
 *
 * Gates exécutées (dans cet ordre déterministe) :
 * - git diff --check
 * - pnpm lint
 * - pnpm typecheck
 * - pnpm test
 * - pnpm build
 *
 * Déterminisme (GLOBAL-GATES-1) :
 * 1. Le **statut de sortie structuré** du process fait autorité. `promisify(execFile)`
 *    rejette sur code de sortie non-zéro et résout sinon. On ne classe JAMAIS le
 *    succès/échec à partir de mots arbitraires ("error", "failed") dans stdout/stderr :
 *    une commande qui réussit (exit 0) avec du texte diagnostique passe.
 * 2. Les gates s'exécutent **séquentiellement**, pas via Promise.all. La contention
 *    de ressources sous exécution concurrente est démontrée ; l'échec Turbopack
 *    reproduit séparément est lié au sandbox et ne lui est pas attribué. Chaque
 *    gate est quand même exécutée et rapportée (pas de court-circuit).
 */
export class GlobalGates implements GlobalGatesPort {
  private readonly timeoutMs: number;

  /** Ordre déterministe des gates lancées par executeAll. */
  private static readonly GATE_ORDER = ["lint", "typecheck", "test", "build"] as const;

  constructor(timeoutMs = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  async executeAll(workspacePath: string): Promise<GateResult[]> {
    // Exécution SÉQUENTIELLE et ordonnée : borne à 1 la concurrence entre gates
    // lourdes et évite leur contention démontrée. Toutes les gates restent
    // exécutées et rapportées — aucun court-circuit sur premier échec.
    const results: GateResult[] = [];
    results.push(await this.gitDiffCheck(workspacePath));
    for (const gate of GlobalGates.GATE_ORDER) {
      results.push(await this.executeGate(gate, workspacePath));
    }
    return results;
  }

  async executeGate(gate: string, workspacePath: string): Promise<GateResult> {
    const start = Date.now();

    try {
      const { stdout, stderr } = await this.run("pnpm", [gate], workspacePath, this.timeoutMs);

      // Statut de sortie structuré = autorité. On atteint cette branche
      // uniquement si le process a rendu exit 0. Le texte n'est que diagnostique.
      return {
        gate,
        passed: true,
        output: stdout || stderr,
        durationMs: Date.now() - start,
        errors: [],
      };
    } catch (error) {
      // Rejet = exit non-zéro OU erreur de spawn/timeout → échec fermé.
      const message = error instanceof Error ? error.message : "Erreur inconnue";
      return {
        gate,
        passed: false,
        output: message,
        durationMs: Date.now() - start,
        errors: [message],
      };
    }
  }

  async gitDiffCheck(workspacePath: string): Promise<GateResult> {
    const start = Date.now();

    try {
      const { stdout, stderr } = await this.run("git", ["diff", "--check"], workspacePath, 30_000);

      // `git diff --check` sort non-zéro en cas de problème (whitespace, conflit).
      // Exit 0 (branche résolue) = propre → passe, indépendamment du texte.
      return {
        gate: "git-diff-check",
        passed: true,
        output: stdout || stderr || "Aucun problème de formatage détecté",
        durationMs: Date.now() - start,
        errors: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur inconnue";
      return {
        gate: "git-diff-check",
        passed: false,
        output: message,
        durationMs: Date.now() - start,
        errors: [message],
      };
    }
  }

  /**
   * Seam d'exécution de process, injectable en test.
   * Enveloppe `promisify(execFile)` qui **rejette sur exit non-zéro** et
   * résout sinon — c'est ce contrat de rejet/résolution qui rend le statut
   * de sortie autoritaire pour les gates.
   */
  protected async run(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return exec(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
  }
}

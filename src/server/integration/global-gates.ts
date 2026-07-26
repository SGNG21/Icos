import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GateResult } from "@/core/integration";
import type { GlobalGatesPort } from "./ports";

const exec = promisify(execFile);

/**
 * GlobalGates — exécute les vérifications qualité sur une branche d'intégration.
 *
 * Gates exécutées :
 * - pnpm lint
 * - pnpm typecheck
 * - pnpm test
 * - pnpm build
 * - git diff --check
 */
export class GlobalGates implements GlobalGatesPort {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  async executeAll(workspacePath: string): Promise<GateResult[]> {
    const gates = [
      this.gitDiffCheck(workspacePath),
      this.executeGate("lint", workspacePath),
      this.executeGate("typecheck", workspacePath),
      this.executeGate("test", workspacePath),
      this.executeGate("build", workspacePath),
    ];

    const results = await Promise.all(gates);
    return results;
  }

  async executeGate(gate: string, workspacePath: string): Promise<GateResult> {
    const start = Date.now();

    try {
      const { stdout, stderr } = await exec(
        "pnpm",
        [gate],
        {
          cwd: workspacePath,
          timeout: this.timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      const passed = stderr.length === 0 || !stderr.toLowerCase().includes("error");

      return {
        gate,
        passed,
        output: stdout || stderr,
        durationMs: Date.now() - start,
        errors: passed ? [] : [stderr || "Erreur inconnue"],
      };
    } catch (error) {
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
      const { stdout, stderr } = await exec(
        "git",
        ["diff", "--check"],
        {
          cwd: workspacePath,
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      const passed = stdout.length === 0 && stderr.length === 0;

      return {
        gate: "git-diff-check",
        passed,
        output: stdout || stderr || "Aucun problème de formatage détecté",
        durationMs: Date.now() - start,
        errors: passed ? [] : [stderr || stdout || "Erreur de formatage"],
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
}

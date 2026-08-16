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

  /**
   * Allowlist explicite des variables d'environnement transmises aux
   * sous-processus de gate (F6.1, Phase 2 hardening).
   *
   * Les gates s'exécutent sur du code fraîchement intégré par des workers :
   * l'environnement parent (clés API, credentials, tokens) ne doit JAMAIS
   * se propager par défaut. Seul le strict nécessaire au fonctionnement de
   * pnpm/node/git est transmis. NODE_ENV est volontairement exclu
   * (empoisonnement d'environnement démontré sur les gates du dépôt).
   *
   * RÉSIDU DOCUMENTÉ NF-5 (Phase 2B) : PATH / PNPM_HOME / COREPACK_HOME /
   * XDG_* restent transmis — un PARENT compromis pourrait pointer vers des
   * outillages ou caches empoisonnés (provenance des outils non vérifiée).
   * Ce résidu exige déjà la compromission de l'environnement de
   * l'opérateur (pas des workers : ils ne définissent pas l'env parent des
   * gates). Correctif minimal sans expansion d'architecture indisponible :
   * épingler PATH est spécifique à l'hôte et casserait les gates ; une
   * chaîne d'outils hermétique (provenance vérifiée) est une évolution
   * d'architecture — suivi requis (voir PHASE2B_HARDENING_REPORT, NF-5).
   */
  private static readonly ENV_ALLOWLIST = [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PNPM_HOME",
    "COREPACK_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ] as const;

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
      // F6.1 : jamais l'environnement parent complet — allowlist explicite.
      // (même idiome de cast que local-runtime-adapter.ts : ProcessEnv est
      // augmenté avec NODE_ENV requis, exclu ici volontairement)
      env: this.buildGateEnv() as NodeJS.ProcessEnv,
    });
  }

  /**
   * Construit l'environnement minimal des sous-processus de gate à partir
   * de l'allowlist explicite. Toute variable absente de l'allowlist
   * (clés API, secrets, credentials) est exclue par construction.
   */
  protected buildGateEnv(
    source: Record<string, string | undefined> = process.env,
  ): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const key of GlobalGates.ENV_ALLOWLIST) {
      const value = source[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return env;
  }
}

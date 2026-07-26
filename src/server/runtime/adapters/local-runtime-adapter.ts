import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { RuntimeAdapterInput, RuntimeAdapterResult } from "@/core/runtime";

import type { AgentRuntimeAdapter } from "./runtime-adapter";
import { WorkspaceManager } from "../workspace-manager";

/**
 * Adaptateur d'exécution locale (D4.1).
 *
 * Exécute une étape via un vrai subprocess avec :
 * - Command et args séparés (pas de shell)
 * - Workspace isolé comme cwd via WorkspaceManager
 * - Environnement filtré par allowlist
 * - stdout/stderr capturés avec limite mémoire configurable
 * - Process group détaché pour kill arbre complet
 * - Timeout réel via AbortSignal → SIGTERM → SIGKILL
 * - Annulation réelle via AbortSignal → SIGTERM → SIGKILL
 *
 * SÉCURITÉ :
 * - Toute opération est confinée au workspace validé
 * - Aucune variable d'env non-allowlistée n'est transmise
 * - Les limites de sortie empêchent le DoS mémoire
 * - Le process group est tué en totalité (grace + force)
 * - Pas de zombie : toujours await close
 * - Pas de shell implicite
 *
 * LIMITATION CONNUE :
 * Un descendant qui appelle setsid() peut échapper au process group.
 * Acceptable V1.
 */
export class LocalRuntimeAdapter implements AgentRuntimeAdapter {
  readonly name = "local";

  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly gracePeriodMs: number;
  private readonly allowedEnvVars: ReadonlySet<string>;
  private readonly workspaceManager: WorkspaceManager | undefined;

  constructor(options?: {
    /** Limite stdout en bytes (défaut: 1 MiB). */
    maxStdoutBytes?: number;
    /** Limite stderr en bytes (défaut: 1 MiB). */
    maxStderrBytes?: number;
    /** Période de grâce entre SIGTERM et SIGKILL en ms (défaut: 5000). */
    gracePeriodMs?: number;
    /** Variables d'env autorisées depuis process.env. */
    allowedEnvVars?: string[];
    /** WorkspaceManager pour validation des chemins. */
    workspaceManager?: WorkspaceManager;
  }) {
    this.maxStdoutBytes = options?.maxStdoutBytes ?? 1_024 * 1_024;
    this.maxStderrBytes = options?.maxStderrBytes ?? 1_024 * 1_024;
    this.gracePeriodMs = options?.gracePeriodMs ?? 5_000;
    this.allowedEnvVars = new Set(
      options?.allowedEnvVars ?? ["PATH", "HOME", "TMPDIR", "NODE_NO_WARNINGS"],
    );
    this.workspaceManager = options?.workspaceManager;
  }

  async execute(
    input: RuntimeAdapterInput,
    abortSignal?: AbortSignal,
  ): Promise<RuntimeAdapterResult> {
    // ── Pre-abort check ──
    if (abortSignal?.aborted) {
      return {
        ok: false,
        errorCode: "CANCELLED",
        message: "Exécution annulée avant le démarrage",
        retryable: false,
      };
    }

    // ── Backward compat: no command → simulation ──
    if (!input.command) {
      return this.simulateSuccess(input);
    }

    // ── Validate workspace path ──
    const validatedWorkspace = await this.validateWorkspace(input);
    if (!validatedWorkspace) {
      return {
        ok: false,
        errorCode: "WORKSPACE_ERROR",
        message: `Workspace invalide: ${input.workspacePath}`,
        retryable: false,
      };
    }

    // ── Create output directory ──
    const outputDir = path.join(validatedWorkspace, "output");
    await mkdir(outputDir, { recursive: true });

    // ── Build environment ──
    const childEnv = this.buildChildEnv(input.env);

    // ── Write execution metadata ──
    const startedAt = new Date().toISOString();
    await writeFile(
      path.join(outputDir, "execution.json"),
      JSON.stringify(
        {
          runId: input.runId,
          missionId: input.missionId,
          tenantId: input.tenantId,
          correlationId: input.correlationId,
          stepDescription: input.stepDescription,
          skillKey: input.skillKey,
          toolRef: input.toolRef,
          agentId: input.agentId,
          command: input.command,
          args: input.args,
          startedAt,
        },
        null,
        2,
      ),
    );

    // ── Spawn subprocess ──
    const child = spawn(input.command, input.args ?? [], {
      cwd: validatedWorkspace,
      env: childEnv as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      // detached: true creates a new process group (PGID = child.pid)
      // Required so process.kill(-pgid, sig) kills the whole tree.
      detached: true,
    });

    const pgid = child.pid;

    // ── Capture stdout/stderr with bounds ──
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;

    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let stderrTruncated = false;

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutTruncated) return;
        const remaining = this.maxStdoutBytes - stdoutBytes;
        if (remaining <= 0) {
          stdoutTruncated = true;
          return;
        }
        if (chunk.length <= remaining) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        } else {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes = this.maxStdoutBytes;
          stdoutTruncated = true;
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrTruncated) return;
        const remaining = this.maxStderrBytes - stderrBytes;
        if (remaining <= 0) {
          stderrTruncated = true;
          return;
        }
        if (chunk.length <= remaining) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        } else {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes = this.maxStderrBytes;
          stderrTruncated = true;
        }
      });
    }

    // ── Track spawn error (ENOENT, permission denied) ──
    let spawnError: Error | null = null;
    child.on("error", (err: Error) => {
      spawnError = err;
    });

    // ── Set up abort-triggered kill ──
    // When the abort signal fires, we kill the process group.
    // The close event (after kill) will then resolve `closePromise`.
    let abortHandler: (() => void) | null = null;

    if (abortSignal && !abortSignal.aborted) {
      abortHandler = () => {
        // Fire-and-forget: kill is async, we don't await inside the handler
        this.killProcessGroup(pgid).catch(() => {});
      };
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    // ── Wait for close (natural exit or killed by abort) ──
    const { code: exitCode, signal: exitSignal } = await new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) => {
      child.on("close", (code, sig) => {
        resolve({ code, signal: sig });
      });
    });

    // Clean up abort listener if it never fired
    if (abortHandler && abortSignal) {
      abortSignal.removeEventListener("abort", abortHandler);
    }

    // ── Write output files ──
    const durationMs = Date.now() - new Date(startedAt).getTime();
    await writeFile(
      path.join(outputDir, "stdout.log"),
      Buffer.concat(stdoutChunks).toString("utf-8") || "",
    );
    await writeFile(
      path.join(outputDir, "stderr.log"),
      Buffer.concat(stderrChunks).toString("utf-8") || "",
    );
    await writeFile(
      path.join(outputDir, "result.json"),
      JSON.stringify(
        {
          exitCode,
          signal: exitSignal,
          stdoutBytes,
          stderrBytes,
          truncated: stdoutTruncated || stderrTruncated,
          durationMs,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    // ── Map result ──

    // Spawn failure (ENOENT, permission denied)
    if (spawnError) {
      const errMsg = (spawnError as Error).message;
      return {
        ok: false,
        errorCode: "PROCESS_ERROR",
        message: `Échec du démarrage: ${errMsg}`,
        retryable: false,
      };
    }

    // Exit with signal (killed by our abort handler or external signal)
    if (exitSignal !== null) {
      return {
        ok: false,
        errorCode: "PROCESS_ERROR",
        message: `Processus terminé par le signal ${exitSignal}`,
        retryable: false,
      };
    }

    // Non-zero exit
    if (exitCode !== 0) {
      return {
        ok: false,
        errorCode: "PROCESS_ERROR",
        message: `Processus terminé avec le code ${exitCode}`,
        retryable: false,
      };
    }

    // Success (exit code 0)
    return {
      ok: true,
      output: {
        exitCode: 0,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8") || "",
        stderr: Buffer.concat(stderrChunks).toString("utf-8") || "",
        stdoutBytes,
        stderrBytes,
        truncated: stdoutTruncated || stderrTruncated,
        durationMs,
        completedAt: new Date().toISOString(),
      },
    };
  }

  // ─────────────────────────────────────
  // Private: Process group killing
  // ─────────────────────────────────────

  /**
   * Tue le process group complet avec grâce.
   *
   * 1. SIGTERM au process group
   * 2. Attente gracePeriodMs
   * 3. SIGKILL si encore vivant
   *
   * LIMITATION : un descendant ayant appelé setsid() peut échapper
   * au process group. Acceptable V1.
   */
  private async killProcessGroup(pgid: number | undefined): Promise<void> {
    if (pgid === undefined) return;

    // First SIGTERM to the group
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      // Group already dead
    }

    await sleep(this.gracePeriodMs);

    // Check if still alive; if so, SIGKILL
    try {
      process.kill(-pgid, 0); // 0 = test only
      // Still alive → force kill
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Died between test and kill
      }
    } catch {
      // Group already dead (ESRCH)
    }
  }

  // ─────────────────────────────────────
  // Private: Workspace validation
  // ─────────────────────────────────────

  /**
   * Valide le workspace en utilisant le WorkspaceManager si disponible,
   * ou par vérification basique de chemin absolu.
   *
   * Quand le WorkspaceManager est disponible, on vérifie que le chemin
   * demandé est dans le répertoire attendu (root/tenantId/runId), pas
   * seulement dans le root — empêche les traversées `../..` qui restent
   * sous le root mais fuient le workspace spécifique.
   *
   * @returns Le chemin canonique validé, ou null si invalide.
   */
  private async validateWorkspace(
    input: RuntimeAdapterInput,
  ): Promise<string | null> {
    if (this.workspaceManager) {
      try {
        const expectedWorkspace = path.join(
          this.workspaceManager.workspaceRoot,
          input.tenantId,
          input.runId,
        );
        return await this.workspaceManager.validatePathInWorkspace(
          expectedWorkspace,
          input.workspacePath,
        );
      } catch {
        return null;
      }
    }

    if (!path.isAbsolute(input.workspacePath)) return null;
    const normalized = path.normalize(input.workspacePath);
    if (normalized.includes("..")) return null;
    return normalized;
  }

  // ─────────────────────────────────────
  // Private: Environment allowlist
  // ─────────────────────────────────────

  /**
   * Construit l'environnement du subprocess en ne passant que les
   * variables autorisées depuis process.env, surchargées par les
   * variables explicites (ex: credentials résolus).
   */
  private buildChildEnv(
    extraEnv?: Record<string, string>,
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of this.allowedEnvVars) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key]!;
      }
    }
    if (extraEnv) {
      Object.assign(env, extraEnv);
    }
    return env;
  }

  // ─────────────────────────────────────
  // Private: Simulation (backward compat)
  // ─────────────────────────────────────

  /**
   * Comportement de simulation pour rétrocompatibilité.
   * Utilisé quand input.command n'est pas fourni.
   */
  private async simulateSuccess(
    input: RuntimeAdapterInput,
  ): Promise<RuntimeAdapterResult> {
    const outputDir = path.join(input.workspacePath, "output");
    await mkdir(outputDir, { recursive: true });

    await writeFile(
      path.join(outputDir, "execution.json"),
      JSON.stringify(
        {
          runId: input.runId,
          missionId: input.missionId,
          tenantId: input.tenantId,
          correlationId: input.correlationId,
          stepDescription: input.stepDescription,
          skillKey: input.skillKey,
          toolRef: input.toolRef,
          agentId: input.agentId,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    await sleep(5);

    await writeFile(
      path.join(outputDir, "result.json"),
      JSON.stringify(
        {
          status: "completed",
          description: input.stepDescription,
          output: `Étape "${input.stepDescription}" exécutée avec succès`,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    await writeFile(
      path.join(outputDir, "stdout.log"),
      `[D4] Démarrage de l'exécution: ${input.stepDescription}\n[D4] Workspace: ${input.workspacePath}\n[D4] Exécution terminée avec succès\n`,
    );

    return {
      ok: true,
      output: {
        description: input.stepDescription,
        result: `Étape "${input.stepDescription}" exécutée avec succès`,
      },
    };
  }
}

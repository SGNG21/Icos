import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { RuntimeAdapterInput, RuntimeAdapterResult } from "@/core/runtime";

import type { AgentRuntimeAdapter } from "./runtime-adapter";

/**
 * Adaptateur d'exécution locale (V1).
 *
 * Exécute une étape localement en :
 * 1. Créant le répertoire output/ dans le workspace
 * 2. Écrivant les métadonnées d'exécution
 * 3. Simulant l'exécution (V1 : écrit les résultats, V2+ : lance des processus)
 *
 * Le timeout est géré via AbortSignal.
 * L'annulation est gérée via AbortSignal.
 *
 * SÉCURITÉ :
 * - Toute opération est confinée au workspace fourni
 * - Aucune sortie n'est produite hors du workspace
 * - Le timeout empêche les exécutions infinies
 * - L'annulation est immédiate (pas de zombie)
 */
export class LocalRuntimeAdapter implements AgentRuntimeAdapter {
  readonly name = "local";

  async execute(
    input: RuntimeAdapterInput,
    abortSignal?: AbortSignal,
  ): Promise<RuntimeAdapterResult> {
    try {
      // Vérifier l'annulation avant de commencer
      if (abortSignal?.aborted) {
        return {
          ok: false,
          errorCode: "CANCELLED",
          message: "Exécution annulée avant le démarrage",
          retryable: false,
        };
      }

      // Créer le répertoire output dans le workspace
      const outputDir = path.join(input.workspacePath, "output");
      await mkdir(outputDir, { recursive: true });

      // Écrire les métadonnées d'exécution
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

      // V1 : simuler l'exécution avec un délai minimal
      // Dans les versions futures, ceci exécutera un processus réel.
      const executionPromise = simulateExecution(input, outputDir);

      // Gérer le timeout si présent
      const result = await Promise.race([
        executionPromise,
        abortSignal
          ? waitForAbort(abortSignal).then((): RuntimeAdapterResult => ({
              ok: false,
              errorCode: "CANCELLED",
              message: "Exécution annulée",
              retryable: false,
            }))
          : new Promise<never>(() => {}), // Ne résout jamais sans timeout/annulation
      ]);

      return result;
    } catch (error) {
      return {
        ok: false,
        errorCode: "PROCESS_ERROR",
        message: `Erreur d'exécution: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      };
    }
  }
}

/**
 * Simule l'exécution d'une étape en écrivant des résultats dans le workspace.
 * Dans V2+, ceci exécutera un processus réel.
 */
async function simulateExecution(
  input: RuntimeAdapterInput,
  outputDir: string,
): Promise<RuntimeAdapterResult> {
  // Petit délai pour simuler le travail
  await sleep(10);

  // Écrire un fichier de résultats
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

  // Écrire stdout simulé
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

/**
 * Attend que le signal AbortSignal soit déclenché.
 */
async function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

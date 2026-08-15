import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeAdapterInput } from "@/core/runtime";

import { LocalRuntimeAdapter } from "./local-runtime-adapter";
import { WorkspaceManager } from "../workspace-manager";

// ─────────────────────────────────────
// Helpers
// ─────────────────────────────────────

function createInput(overrides: Partial<RuntimeAdapterInput> = {}): RuntimeAdapterInput {
  return {
    runId: "run-adapter-test-1",
    missionId: "mission-adapter-test-1",
    tenantId: "tenant-adapter-test",
    correlationId: "corr-adapter-test-1",
    stepDescription: "Adapter test step",
    workspacePath: "",
    timeoutMs: 60_000,
    ...overrides,
  };
}

/** Attend qu'un PID n'existe plus (poll court, borné). */
async function waitForProcessGone(pid: number, maxWaitMs = 3_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 25));
    } catch {
      return true; // ESRCH → process gone
    }
  }
  return false;
}

// ─────────────────────────────────────
// Tests
// ─────────────────────────────────────

describe("D4.1 — LocalRuntimeAdapter (real subprocess)", () => {
  let testRoot: string;
  let workspaceManager: WorkspaceManager;
  let workspacePath: string;
  let adapter: LocalRuntimeAdapter;

  beforeEach(async () => {
    testRoot = await mkdtemp("/tmp/d4-adapter-test-");
    workspaceManager = new WorkspaceManager(testRoot);
    workspacePath = await workspaceManager.createWorkspace(
      "tenant-adapter-test",
      "run-adapter-test-1",
    );
    adapter = new LocalRuntimeAdapter({
      workspaceManager,
      gracePeriodMs: 200,
    });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("D4.1-01: exécute une vraie commande et capture stdout", async () => {
    const result = await adapter.execute(
      createInput({
        workspacePath,
        command: "node",
        args: ["-e", "console.log('hello-from-child')"],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.output as { exitCode: number; stdout: string };
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toContain("hello-from-child");
    }

    const stdoutLog = await readFile(path.join(workspacePath, "output", "stdout.log"), "utf-8");
    expect(stdoutLog).toContain("hello-from-child");
  });

  it("D4.1-02: code de sortie non-zéro → PROCESS_ERROR", async () => {
    const result = await adapter.execute(
      createInput({
        workspacePath,
        command: "node",
        args: ["-e", "process.exit(7)"],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("PROCESS_ERROR");
      expect(result.message).toContain("7");
    }
  });

  it("D4.1-03: commande introuvable (ENOENT) → PROCESS_ERROR, pas de throw", async () => {
    const result = await adapter.execute(
      createInput({
        workspacePath,
        command: "this-command-does-not-exist-xyz",
        args: [],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("PROCESS_ERROR");
    }
  });

  it("D4.1-04: stdout est tronqué au-delà de maxStdoutBytes", async () => {
    const smallAdapter = new LocalRuntimeAdapter({
      workspaceManager,
      maxStdoutBytes: 100,
      gracePeriodMs: 200,
    });

    const result = await smallAdapter.execute(
      createInput({
        workspacePath,
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(10_000))"],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.output as { stdoutBytes: number; truncated: boolean };
      expect(output.stdoutBytes).toBe(100);
      expect(output.truncated).toBe(true);
    }
  });

  it("D4.1-05: env allowlist — seules les variables autorisées sont transmises", async () => {
    process.env.D4_TEST_SECRET_NOT_ALLOWED = "should-not-leak";

    try {
      const scopedAdapter = new LocalRuntimeAdapter({
        workspaceManager,
        allowedEnvVars: ["PATH"],
        gracePeriodMs: 200,
      });

      const result = await scopedAdapter.execute(
        createInput({
          workspacePath,
          command: "node",
          args: [
            "-e",
            "console.log(JSON.stringify({hasSecret: 'D4_TEST_SECRET_NOT_ALLOWED' in process.env, hasPath: 'PATH' in process.env}))",
          ],
        }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const output = result.output as { stdout: string };
        const parsed = JSON.parse(output.stdout.trim()) as {
          hasSecret: boolean;
          hasPath: boolean;
        };
        expect(parsed.hasSecret).toBe(false);
        expect(parsed.hasPath).toBe(true);
      }
    } finally {
      delete process.env.D4_TEST_SECRET_NOT_ALLOWED;
    }
  });

  it("D4.1-06: env explicite (extraEnv) est transmis même hors allowlist", async () => {
    const scopedAdapter = new LocalRuntimeAdapter({
      workspaceManager,
      allowedEnvVars: [],
      gracePeriodMs: 200,
    });

    const result = await scopedAdapter.execute(
      createInput({
        workspacePath,
        command: process.execPath,
        args: ["-e", "console.log(process.env.INJECTED_CRED ?? '')"],
        env: { INJECTED_CRED: "resolved-value" },
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const output = result.output as { stdout: string };
      expect(output.stdout).toContain("resolved-value");
    }
  });

  it("D4.1-07: workspace path traversal (`..`) est rejeté", async () => {
    const result = await adapter.execute(
      createInput({
        workspacePath: path.join(workspacePath, "..", "..", "etc"),
        command: "node",
        args: ["-e", "console.log('should-not-run')"],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("WORKSPACE_ERROR");
    }
  });

  it("D4.1-08 (SEC-D4-05 REAL PASS): le timeout tue l'arbre de processus complet", async () => {
    // Un enfant qui lui-même spawn un petit-enfant qui dort longtemps.
    // On vérifie que l'annulation via AbortSignal tue le groupe entier,
    // pas seulement le process direct.
    const script = `
      const { spawn } = require('child_process');
      const grandchild = spawn('sleep', ['30']);
      console.log('GRANDCHILD_PID=' + grandchild.pid);
      setTimeout(() => {}, 30_000);
    `;

    const abortController = new AbortController();

    const resultPromise = adapter.execute(
      createInput({
        workspacePath,
        command: "node",
        args: ["-e", script],
      }),
      abortController.signal,
    );

    // Laisser le temps au process + petit-enfant de démarrer et d'écrire le PID.
    await new Promise((r) => setTimeout(r, 300));

    // Simuler le déclenchement du timeout de l'orchestrateur.
    abortController.abort("timeout");

    const result = await resultPromise;

    // Lire stdout.log APRÈS la fin du process — le fichier n'est écrit
    // que lorsque l'adaptateur ferme les streams après le close event.
    const stdoutLog = await readFile(
      path.join(workspacePath, "output", "stdout.log"),
      "utf-8",
    ).catch(() => "");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Le process a été tué par signal (SIGTERM ou SIGKILL), pas un exit normal.
      expect(result.errorCode).toBe("PROCESS_ERROR");
    }

    const grandchildMatch = stdoutLog.match(/GRANDCHILD_PID=(\d+)/);
    expect(grandchildMatch).not.toBeNull();
    if (grandchildMatch) {
      const grandchildPid = Number(grandchildMatch[1]);
      const gone = await waitForProcessGone(grandchildPid);
      expect(gone).toBe(true);
    }
  }, 15_000);

  it("D4.1-09 (SEC-D4-06 REAL PASS): l'annulation ne laisse aucun zombie", async () => {
    const abortController = new AbortController();

    const resultPromise = adapter.execute(
      createInput({
        workspacePath,
        command: "sleep",
        args: ["30"],
      }),
      abortController.signal,
    );

    // Laisser le process démarrer avant d'annuler.
    await new Promise((r) => setTimeout(r, 200));

    abortController.abort("cancelled");

    const result = await resultPromise;

    expect(result.ok).toBe(false);

    // Vérifier qu'aucun process "sleep 30" résiduel ne subsiste
    // (le `close` event de child_process garantit déjà le reaping —
    // ici on vérifie l'absence de zombie applicatif au niveau OS).
    const { execSync } = await import("node:child_process");
    let psOutput = "";
    try {
      psOutput = execSync("ps -eo pid,stat,command").toString();
    } catch {
      // ps non disponible sur certaines plateformes — ne pas faire échouer le test
      return;
    }
    const zombieLines = psOutput
      .split("\n")
      .filter((line) => line.includes("sleep 30") && / Z/.test(line));
    expect(zombieLines).toHaveLength(0);
  }, 15_000);

  it("D4.1-10: pré-abort (signal déjà déclenché) → CANCELLED sans spawn", async () => {
    const abortController = new AbortController();
    abortController.abort("cancelled");

    const result = await adapter.execute(
      createInput({
        workspacePath,
        command: "node",
        args: ["-e", "console.log('should-not-run')"],
      }),
      abortController.signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("CANCELLED");
    }
  });
});

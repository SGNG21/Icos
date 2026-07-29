import { execFile } from "node:child_process";
import { mkdir, realpath, rm } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import type { WorktreeSpec, WorktreeResult, WorktreeEntry } from "@/core/worktree";
import type { WorktreeManagerPort } from "./ports";
import type { IntegrationWorktreePort } from "@/server/integration/ports";

const execGit = promisify(execFile);

/**
 * Gestionnaire de worktrees Git.
 *
 * Crée des worktrees isolés pour chaque tâche d'implémentation.
 * Garantit qu'un worker n'écrit pas dans le workspace d'un autre.
 *
 * INVARIANTS :
 * - Chaque worktree a sa propre branche
 * - Pas d'écriture croisée
 * - Pas de push/merge main
 * - Nettoyage garanti
 */
export class WorktreeManager implements WorktreeManagerPort, IntegrationWorktreePort {
  private readonly entries = new Map<string, WorktreeEntry>();
  private resolvedRoot: string | null;

  constructor(
    private readonly worktreeBase: string = ".claude/worktrees",
    repoRoot?: string,
  ) {
    this.resolvedRoot = repoRoot ? path.resolve(repoRoot) : null;
  }

  private async getRepoRoot(): Promise<string> {
    if (this.resolvedRoot) {
      this.resolvedRoot = await realpath(this.resolvedRoot);
    } else {
      const { stdout } = await execGit("git", ["rev-parse", "--show-toplevel"]);
      this.resolvedRoot = await realpath(stdout.trim());
    }
    return this.resolvedRoot;
  }

  private async git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execGit("git", args, {
      cwd: cwd ?? (await this.getRepoRoot()),
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  }

  private async safeGit(args: string[], cwd?: string): Promise<string> {
    try {
      return await this.git(args, cwd);
    } catch {
      return "";
    }
  }

  private getWorktreeDir(repoRoot: string): string {
    return path.join(repoRoot, this.worktreeBase);
  }

  // ─────────────────────────────────────
  // Create worktree
  // ─────────────────────────────────────

  async createWorktree(taskId: string, baseSha?: string): Promise<WorktreeSpec> {
    const repoRoot = await this.getRepoRoot();
    const sanitizedTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const branchName = `worktree-${sanitizedTaskId}`;
    const worktreeDir = this.getWorktreeDir(repoRoot);
    const worktreePath = path.join(worktreeDir, sanitizedTaskId);

    // Déterminer le SHA de base
    let effectiveBaseSha: string;
    if (baseSha) {
      effectiveBaseSha = baseSha;
    } else {
      effectiveBaseSha = await this.git(["rev-parse", "HEAD"]);
    }

    // Créer le répertoire parent si nécessaire
    await mkdir(worktreeDir, { recursive: true });

    // Collision de worktree résiduel : un run précédent interrompu peut avoir
    // laissé un worktree au chemin task-scoped (potentiellement dirty ou sur un
    // SHA obsolète). Le manager est propriétaire exclusif de ce chemin
    // déterministe, donc un résidu est par définition périmé : on le retire
    // canoniquement avant de recréer un workspace frais.
    //
    // On NE FAIT JAMAIS `git checkout <baseSha>` sur un worktree existant : si
    // l'arbre est dirty, git lève « local changes would be overwritten by
    // checkout » et la tâche reste bloquée (jamais dispatchée à un worker).
    const existing = await this.safeGit(["worktree", "list", "--porcelain"]);
    if (existing.includes(worktreePath)) {
      await this.safeGit(["worktree", "remove", "--force", worktreePath]);
      await this.safeGit(["worktree", "prune"]);
    }

    // Crée le worktree frais de façon atomique et déterministe. `-B` crée la
    // branche task-scoped OU la réinitialise sur `effectiveBaseSha` si elle
    // existe déjà (résidu d'un run précédent pointant sur un ancien SHA),
    // garantissant que le worker part toujours d'un arbre propre au bon SHA.
    await this.git(["worktree", "add", "-B", branchName, worktreePath, effectiveBaseSha]);

    const now = new Date().toISOString();
    const spec: WorktreeSpec = {
      path: worktreePath,
      branch: branchName,
      baseSha: effectiveBaseSha,
      taskId,
    };

    this.entries.set(taskId, {
      spec,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });

    return spec;
  }

  async createIntegrationWorktree(input: {
    integrationId: string;
    branch: string;
    baseSha: string;
  }): Promise<WorktreeSpec> {
    const repoRoot = await this.getRepoRoot();
    const sanitizedId = input.integrationId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const worktreePath = path.join(repoRoot, ".claude", "integration", sanitizedId);
    await this.git(["check-ref-format", "--branch", input.branch], repoRoot);
    if (!input.branch.startsWith("integration/")) {
      throw new Error("Integration branch must use the integration/ namespace");
    }
    await mkdir(path.dirname(worktreePath), { recursive: true });

    const existing = await this.safeGit(["worktree", "list", "--porcelain"], repoRoot);
    if (existing.includes(`worktree ${worktreePath}`)) {
      await this.git(["worktree", "remove", "--force", worktreePath], repoRoot);
      await this.safeGit(["worktree", "prune"], repoRoot);
    }
    // A crash may leave an unregistered directory after Git metadata was
    // pruned. This path is deterministic and manager-owned.
    await rm(worktreePath, { recursive: true, force: true });

    await this.git(["worktree", "add", "-B", input.branch, worktreePath, input.baseSha], repoRoot);
    const now = new Date().toISOString();
    const spec: WorktreeSpec = {
      path: worktreePath,
      branch: input.branch,
      baseSha: input.baseSha,
      taskId: input.integrationId,
    };
    this.entries.set(`integration:${input.integrationId}`, {
      spec,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    return spec;
  }

  // ─────────────────────────────────────
  // Assign to task
  // ─────────────────────────────────────

  async assignToTask(worktreePath: string, taskId: string): Promise<void> {
    const repoRoot = await this.getRepoRoot();
    const sanitizedTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const expectedPath = path.join(this.getWorktreeDir(repoRoot), sanitizedTaskId);
    const resolvedPath = await realpath(worktreePath);
    const resolvedExpected = path.resolve(expectedPath);
    if (resolvedPath !== resolvedExpected) {
      throw new Error(`Refus d'enregistrer un chemin de worktree non canonique: ${resolvedPath}`);
    }
    const registered = await this.git(["worktree", "list", "--porcelain"], repoRoot);
    if (!registered.split("\n").includes(`worktree ${resolvedPath}`)) {
      throw new Error(
        `Refus d'enregistrer un chemin qui n'est pas un worktree Git: ${resolvedPath}`,
      );
    }

    const now = new Date().toISOString();
    const branchName = `worktree-${sanitizedTaskId}`;
    const actualBranch = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], resolvedPath);
    if (actualBranch !== branchName) {
      throw new Error(`Le worktree n'utilise pas la branche canonique attendue: ${branchName}`);
    }
    const baseSha = await this.git(["rev-parse", "HEAD"], resolvedPath);
    this.entries.set(taskId, {
      spec: { path: resolvedPath, branch: branchName, baseSha, taskId },
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
  }

  // ─────────────────────────────────────
  // Capture result
  // ─────────────────────────────────────

  async captureResult(worktreePath: string): Promise<WorktreeResult> {
    const headSha = await this.git(["rev-parse", "HEAD"], worktreePath);

    // Récupérer le baseSha stocké (le SHA au moment de la création du worktree)
    const storedBase = this.findEntryByPath(worktreePath)?.spec.baseSha;
    const effectiveBase = storedBase && storedBase.length === 40 ? storedBase : headSha;

    const changedOut = await this.git(
      ["diff", "--name-only", `${effectiveBase}..HEAD`],
      worktreePath,
    ).catch(() => "");
    const changedList = changedOut ? changedOut.split("\n").filter(Boolean) : [];

    // État dirty
    const statusOut = await this.git(["status", "--porcelain"], worktreePath);
    const isDirty = statusOut.length > 0;
    const uncommittedFiles = statusOut
      ? statusOut
          .split("\n")
          .filter(Boolean)
          .map((line) => line.slice(3).trim())
      : [];

    // Commits depuis la base
    const logOut = await this.safeGit(["log", `${effectiveBase}..HEAD`, "--oneline"], worktreePath);
    const commitLines = logOut ? logOut.split("\n").filter(Boolean) : [];
    const commitMessages = commitLines.map((l) => l.replace(/^[0-9a-f]{7,40}\s+/, ""));
    const commitShas = commitLines.map((l) => l.slice(0, l.indexOf(" "))).filter(Boolean);

    // Mettre à jour l'entrée locale
    for (const entry of this.entries.values()) {
      if (entry.spec.path === worktreePath) {
        entry.status = isDirty ? "DIRTY" : "COMMITTED";
        entry.updatedAt = new Date().toISOString();
      }
    }

    return {
      baseSha: effectiveBase,
      headSha,
      changedFiles: changedList,
      isDirty,
      uncommittedFiles,
      commitMessages,
      commitShas,
    };
  }

  private findEntryByPath(worktreePath: string): WorktreeEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.spec.path === worktreePath) return entry;
    }
    return undefined;
  }

  // ─────────────────────────────────────
  // Detect changes
  // ─────────────────────────────────────

  async detectChanges(worktreePath: string): Promise<string[]> {
    const status = await this.git(["status", "--porcelain"], worktreePath);
    if (!status) return [];
    return status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
  }

  // ─────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────

  async cleanupWorktree(worktreePath: string): Promise<void> {
    const repoRoot = await this.getRepoRoot();
    const resolvedWt = await realpath(worktreePath).catch(() => path.resolve(worktreePath));
    const resolvedRoot = path.resolve(repoRoot);
    const ownedEntry = this.findEntryByPath(resolvedWt);

    if (resolvedWt === resolvedRoot) {
      throw new Error("Refus de supprimer le répertoire racine du repo");
    }
    if (!ownedEntry) {
      throw new Error(`Refus de nettoyer un worktree non géré: ${resolvedWt}`);
    }
    if (ownedEntry.status === "CLEANED") return;

    const registered = await this.safeGit(["worktree", "list", "--porcelain"]);
    if (!registered.split("\n").includes(`worktree ${resolvedWt}`)) {
      await rm(resolvedWt, { recursive: true, force: true });
    } else {
      await this.git(["worktree", "remove", "--force", resolvedWt]);
    }

    const branchName = ownedEntry.spec.branch;

    // Supprimer la branche associée (jamais les branches feat/ ou main)
    if (branchName && branchName !== "HEAD" && !branchName.startsWith("feat/")) {
      await this.deleteBranchIfPresent(branchName, repoRoot);
    }

    ownedEntry.status = "CLEANED";
    ownedEntry.updatedAt = new Date().toISOString();
  }

  async cleanupIntegrationWorktree(
    worktreePath: string,
    options: { preserveBranch: boolean },
  ): Promise<void> {
    const repoRoot = await this.getRepoRoot();
    const resolvedWt = await realpath(worktreePath).catch(() => path.resolve(worktreePath));
    const ownedEntry = this.findEntryByPath(resolvedWt);
    if (!ownedEntry || !ownedEntry.spec.branch.startsWith("integration/")) {
      throw new Error(`Refus de nettoyer un worktree d'intégration non géré: ${resolvedWt}`);
    }
    if (ownedEntry.status === "CLEANED") return;

    const registered = await this.safeGit(["worktree", "list", "--porcelain"], repoRoot);
    if (registered.split("\n").includes(`worktree ${resolvedWt}`)) {
      await this.git(["worktree", "remove", "--force", resolvedWt], repoRoot);
    }
    await rm(resolvedWt, { recursive: true, force: true });
    if (!options.preserveBranch) {
      await this.deleteBranchIfPresent(ownedEntry.spec.branch, repoRoot);
    }
    ownedEntry.status = "CLEANED";
    ownedEntry.updatedAt = new Date().toISOString();
  }

  private async deleteBranchIfPresent(branchName: string, repoRoot: string): Promise<void> {
    const listed = await this.git(
      ["branch", "--list", "--format=%(refname:short)", "--", branchName],
      repoRoot,
    );
    if (listed.split("\n").includes(branchName)) {
      await this.git(["branch", "-D", branchName], repoRoot);
    }
  }

  // ─────────────────────────────────────
  // List active
  // ─────────────────────────────────────

  async listActive(): Promise<WorktreeEntry[]> {
    return Array.from(this.entries.values()).filter((e) => e.status !== "CLEANED");
  }
}

import type { WorktreeSpec, WorktreeResult, WorktreeEntry } from "@/core/worktree";

/**
 * Port du gestionnaire de worktrees Git.
 *
 * Chaque worker d'implémentation reçoit un worktree Git isolé.
 * Un worktree = une branche = un répertoire isolé.
 *
 * INVARIANTS :
 * 1. Un worker d'écriture = un worktree isolé par défaut
 * 2. Pas d'écriture croisée entre workers
 * 3. Pas de push main, pas de merge main, pas de force push
 * 4. Nettoyage après intégration
 */
export interface WorktreeManagerPort {
  /**
   * Crée un worktree isolé pour une tâche.
   * Crée une branche depuis baseSha et un répertoire worktree.
   */
  createWorktree(taskId: string, baseSha?: string): Promise<WorktreeSpec>;

  /**
   * Assigne un worktree existant à une tâche.
   */
  assignToTask(worktreePath: string, taskId: string): Promise<void>;

  /**
   * Capture l'état actuel du worktree :
   * base SHA, head SHA, fichiers modifiés, état dirty, commits.
   */
  captureResult(worktreePath: string): Promise<WorktreeResult>;

  /**
   * Détecte les fichiers modifiés dans le worktree.
   */
  detectChanges(worktreePath: string): Promise<string[]>;

  /**
   * Nettoie un worktree de façon sécurisée.
   */
  cleanupWorktree(worktreePath: string): Promise<void>;

  /**
   * Liste tous les worktrees actifs.
   */
  listActive(): Promise<WorktreeEntry[]>;
}

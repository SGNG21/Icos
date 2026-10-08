import {
  deleteRefIfAt,
  preserveWorktreeChanges,
  runGuardedGit,
  type GitExecResult,
} from "./git-authority";
import { WorkspaceError } from "./types";

/*
 * Le filtre de verbes, l'environnement durci et la dérivation du gitdir vivent dans
 * `git-authority.ts`, l'unique endroit qui lance `git`. Ce port n'en est qu'un client : une
 * sous-classe ne peut plus contourner le garde en relançant `git` elle-même.
 */
export { ALLOWED_GIT_SUBCOMMANDS, FORBIDDEN_GIT_FLAGS } from "./git-authority";

export interface ChangedFile {
  status: string;
  path: string;
}
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
}
export interface AddedLine {
  file: string;
  line: string;
}

type ExecResult = GitExecResult;

/**
 * Accès git minimal, sans shell, fail-closed. Ne modifie jamais le dépôt maître :
 * seules `worktree add/remove` et `branch -d` écrivent, jamais avec --force.
 */
export class Git {
  /** @param repoDir le checkout CANONIQUE : le seul que git ait jamais le droit de découvrir. */
  constructor(readonly repoDir: string) {}

  /**
   * `cwd` désigne un WORKTREE dès qu'il diffère du canonique : son gitdir est alors dérivé
   * du canonique, et le `.git` qu'il contient n'est jamais lu (ADR 0072, phase 0).
   */
  async exec(args: string[], cwd = this.repoDir, okCodes: number[] = [0]): Promise<ExecResult> {
    return runGuardedGit(args, {
      repoDir: this.repoDir,
      ...(cwd === this.repoDir ? {} : { worktree: cwd }),
      okCodes,
    });
  }

  /** Internal helper for git commands that return stdout. */
  protected async out(args: string[], cwd?: string): Promise<string> {
    return (await this.exec(args, cwd)).stdout.trim();
  }

  async resolveCommit(ref: string, cwd?: string): Promise<string> {
    return this.out(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
  }

  async commitExists(ref: string): Promise<boolean> {
    return (
      (
        await this.exec(
          ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
          this.repoDir,
          [0, 1],
        )
      ).code === 0
    );
  }

  async branchExists(branch: string): Promise<boolean> {
    return (
      (
        await this.exec(
          ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          this.repoDir,
          [0, 1],
        )
      ).code === 0
    );
  }

  /**
   * Atomically moves a branch ref from `expectedOld` to `next` (M8, defect 19).
   *
   * COMPARE-AND-SWAP: git fails the update if the ref is not exactly `expectedOld`, so two
   * integrators racing on the same target cannot both win, and no read-then-write window
   * exists. Returns false on a lost race rather than throwing — a lost race is an expected
   * outcome to be retried, not an error.
   *
   * Refuses a branch that is CHECKED OUT anywhere. Moving a ref under a live worktree
   * would desynchronise that worktree's index and working tree from HEAD, silently making
   * every later `git status` there wrong.
   */
  async compareAndSwapBranch(branch: string, expectedOld: string, next: string): Promise<boolean> {
    const checkedOut = (await this.worktrees()).find((w) => w.branch === branch);
    if (checkedOut) {
      throw new WorkspaceError(
        "BRANCH_CHECKED_OUT",
        `${branch} est monté dans ${checkedOut.path} : déplacer la ref désynchroniserait ce worktree`,
      );
    }

    const result = await this.exec(
      ["update-ref", `refs/heads/${branch}`, next, expectedOld],
      this.repoDir,
      [0, 1, 128],
    );
    return result.code === 0;
  }

  async worktrees(): Promise<WorktreeInfo[]> {
    const text = await this.out(["worktree", "list", "--porcelain"]);
    return text
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const lines = block.split("\n");
        const field = (k: string) =>
          lines.find((l) => l.startsWith(`${k} `))?.slice(k.length + 1) ?? null;
        return {
          path: field("worktree") ?? "",
          head: field("HEAD") ?? "",
          branch: field("branch")?.replace(/^refs\/heads\//, "") ?? null,
        };
      });
  }

  async addWorktree(worktreePath: string, branch: string, baseCommit: string): Promise<void> {
    await this.exec(["worktree", "add", worktreePath, "-b", branch, baseCommit]);
  }

  /** Sans --force : git refuse si le worktree contient des changements. */
  async removeWorktree(worktreePath: string): Promise<void> {
    await this.exec(["worktree", "remove", worktreePath]);
  }

  /** `branch -d` : git refuse si la branche n'est pas fusionnée. Retourne false dans ce cas. */
  async deleteBranchIfMerged(branch: string): Promise<boolean> {
    return (await this.exec(["branch", "-d", branch], this.repoDir, [0, 1])).code === 0;
  }

  /**
   * Deletes a branch ONLY if it is already contained in `target` (M8, defect 19).
   *
   * WHY `deleteBranchIfMerged` IS NOT ENOUGH
   * `git branch -d` checks the branch against HEAD (and its upstream), not against an
   * arbitrary ref. A worker branch that was fast-forwarded into `integration/phase-7`
   * while the repository's HEAD sits on another branch is therefore reported "not fully
   * merged" and kept — forever. That is why worker branches accumulated even after a
   * successful integration: cleanup was asking git the wrong question.
   *
   * The question asked here is the one that matters: is every commit on this branch
   * already reachable from the ref we integrate into? If yes, the branch is a pointer to
   * commits that live on elsewhere and deleting it destroys nothing. If no, it is the ONLY
   * copy and it is kept.
   *
   * Returns false rather than throwing when the branch is not contained: an unmerged
   * branch is a normal outcome (a rejected result), not an error.
   */
  async deleteBranchMergedInto(branch: string, target: string): Promise<boolean> {
    if (!(await this.branchExists(branch))) return false;

    const tip = await this.resolveCommit(branch);
    /* THE safety check, and a stricter one than `branch -d` performs. */
    if (!(await this.isAncestor(tip, target))) return false;

    const checkedOut = (await this.worktrees()).find((w) => w.branch === branch);
    if (checkedOut) {
      throw new WorkspaceError(
        "BRANCH_CHECKED_OUT",
        `${branch} est monté dans ${checkedOut.path}`,
      );
    }

    /*
     * `update-ref -d <ref> <oldValue>` is a compare-and-swap DELETE: it removes the ref
     * only if it still points where we checked. Safer than `branch -D`, which deletes
     * unconditionally.
     *
     * This bypasses the FORBIDDEN_GIT_FLAGS guard deliberately and narrowly, inside the git
     * authority (`deleteRefIfAt`). That guard exists to stop a CALLER smuggling a
     * destructive flag into an arbitrary command; here the argv is built entirely from
     * validated inputs, no caller can influence it, and the precondition above is strictly
     * stronger than the one the blocked command would have applied itself. The hardening
     * (environment, `-c` neutralisation, config audit) is NOT bypassed.
     */
    return deleteRefIfAt(this.repoDir, `refs/heads/${branch}`, tip);
  }

  /**
   * Commite le travail non commité d'un worktree sur SA branche, pour le préserver avant
   * un retrait (SUPERSEDED_DIRTY_WORKSPACE_HELD). Opération interne, durcie.
   */
  async preserveWorktreeChanges(worktreePath: string, message: string): Promise<void> {
    await preserveWorktreeChanges(this.repoDir, worktreePath, message);
  }

  /**
   * `--ignore-submodules=dirty` : un sous-module ENREGISTRÉ n'est pas visité, donc aucun git
   * n'est lancé dans un `.git` qu'un worker aurait pu y créer. Un changement de gitlink
   * reste visible.
   */
  async statusPorcelain(cwd: string): Promise<string[]> {
    const text = (
      await this.exec(
        ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"],
        cwd,
      )
    ).stdout;
    return text.split("\n").filter(Boolean);
  }

  async headCommit(cwd: string): Promise<string> {
    return this.resolveCommit("HEAD", cwd);
  }

  async changedFiles(from: string, to: string): Promise<ChangedFile[]> {
    const text = await this.out(["diff", "--name-status", "--no-renames", from, to]);
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [status = "", ...rest] = l.split("\t");
        return { status, path: rest.join("\t") };
      });
  }

  /** Lignes ajoutées par le diff (sans les en-têtes), avec leur fichier. */
  async addedLines(from: string, to: string): Promise<AddedLine[]> {
    const text = await this.out(["diff", "-U0", "--no-renames", "--no-color", from, to]);
    const added: AddedLine[] = [];
    let file = "";
    for (const line of text.split("\n")) {
      if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
      else if (line.startsWith("+") && !line.startsWith("+++"))
        added.push({ file, line: line.slice(1) });
    }
    return added;
  }

  /** `git diff --check` : erreurs d'espaces / marqueurs de conflit. */
  async diffCheck(from: string, to: string): Promise<{ ok: boolean; output: string }> {
    const r = await this.exec(["diff", "--check", from, to], this.repoDir, [0, 2]);
    return { ok: r.code === 0, output: r.stdout.trim() };
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (
      (await this.exec(["merge-base", "--is-ancestor", ancestor, descendant], this.repoDir, [0, 1]))
        .code === 0
    );
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return this.out(["merge-base", a, b]);
  }

  async countCommits(range: string): Promise<number> {
    return Number(await this.out(["rev-list", "--count", range]));
  }

  /** Fichiers en conflit d'un merge simulé (aucune modification d'arbre ni de ref). */
  async mergeConflicts(target: string, head: string): Promise<string[]> {
    const r = await this.exec(
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", target, head],
      this.repoDir,
      [0, 1],
    );
    if (r.code === 0) return [];
    return r.stdout.split("\n").slice(1).filter(Boolean);
  }

  async listDir(ref: string, dir: string): Promise<string[]> {
    const text = await this.out(["ls-tree", "--name-only", ref, `${dir}/`]);
    return text
      .split("\n")
      .filter(Boolean)
      .map((p) => p.slice(dir.length + 1));
  }

  async showFile(ref: string, file: string): Promise<string> {
    return (await this.exec(["show", `${ref}:${file}`])).stdout;
  }
}

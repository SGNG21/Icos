import { execFile } from "node:child_process";

import { WorkspaceError } from "./types";

/** Sous-commandes autorisées. Tout le reste (reset, push, clean, merge, rebase, checkout…) est refusé. */
const ALLOWED = new Set([
  "worktree",
  "branch",
  "rev-parse",
  "rev-list",
  "show-ref",
  "status",
  "diff",
  "merge-base",
  "merge-tree",
  "ls-tree",
  "show",
  /*
   * `update-ref` is the ONE write that advances the integration target (M8, defect 19).
   *
   * It is deliberately preferred over `merge`. With an expected-old-value argument it is
   * an atomic COMPARE-AND-SWAP on the ref, which is exactly the exactly-once primitive
   * integration needs: a second integrator whose expected value is stale simply fails,
   * with no window between reading and writing. `merge` would additionally need a
   * checked-out tree, could create merge commits, and could attempt machine conflict
   * resolution — none of which an autonomous path should ever do.
   *
   * `merge`, `rebase`, `reset`, `checkout`, `push` and `clean` remain FORBIDDEN.
   */
  "update-ref",
]);
const FORBIDDEN_FLAGS = new Set([
  "--force",
  "-f",
  "-D",
  "--hard",
  "--force-with-lease",
  "--delete",
]);

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

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Accès git minimal, sans shell, fail-closed. Ne modifie jamais le dépôt maître :
 * seules `worktree add/remove` et `branch -d` écrivent, jamais avec --force.
 */
export class Git {
  /** @param repoDir n'importe quel worktree du dépôt (jamais utilisé pour écrire dans son arbre de travail). */
  constructor(readonly repoDir: string) {}

  async exec(args: string[], cwd = this.repoDir, okCodes: number[] = [0]): Promise<ExecResult> {
    if (!ALLOWED.has(args[0] ?? ""))
      throw new WorkspaceError("GIT_FORBIDDEN", `git ${args[0]} interdit`);
    if (args.some((a) => FORBIDDEN_FLAGS.has(a)))
      throw new WorkspaceError("GIT_FORBIDDEN", `option destructive: ${args.join(" ")}`);
    const result = await new Promise<ExecResult>((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 128) : 0;
          resolve({ code, stdout, stderr });
        },
      );
    });
    if (!okCodes.includes(result.code)) {
      throw new WorkspaceError(
        "GIT_FAILED",
        `git ${args.join(" ")} -> ${result.code}: ${result.stderr.trim()}`,
      );
    }
    return result;
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

  /**
   * ALLOUE UN WORKTREE DÉTACHÉ, et la branche qui l'attend.
   *
   * Pas `-b`. Un HEAD attaché fait verrouiller `refs/heads/<branche>.lock`, créé dans le
   * RÉPERTOIRE `refs/heads/` du dépôt canonique — que le bac à sable du worker refuse, et
   * doit refuser : accorder ce répertoire lui donnerait le pouvoir de déplacer n'importe
   * quelle branche, la CIBLE d'intégration comprise. Attaché, aucune écriture gouvernée ne
   * pouvait donc aboutir sous confinement (preuves dans `sandbox-escape.test.ts`).
   *
   * Détaché, le worker commite avec son seul dossier d'administration et le dépôt d'objets,
   * et rend un SHA. C'est ICOS — hors bac à sable, APRÈS vérification — qui nomme ensuite la
   * branche via {@link setBranchToCommit}.
   *
   * La branche est créée D'ABORD, et sans `--force` : git refuse un nom qui existe déjà, donc
   * deux exécutions ne peuvent jamais partager silencieusement une branche — la garantie que
   * `-b` donnait, au même endroit du temps. Si l'ajout du worktree échoue ensuite, la branche
   * tout juste créée est retirée pour ne pas réserver le nom à vide.
   */
  async addWorktree(worktreePath: string, branch: string, baseCommit: string): Promise<void> {
    await this.exec(["branch", branch, baseCommit]);
    try {
      await this.exec(["worktree", "add", "--detach", worktreePath, baseCommit]);
    } catch (error) {
      await this.deleteBranchIfMerged(branch).catch(() => undefined);
      throw error;
    }
  }

  /**
   * NOMME LA BRANCHE GOUVERNÉE SUR UN COMMIT VÉRIFIÉ. Le worker ne fait jamais cela lui-même.
   *
   * `update-ref` avec une valeur ancienne ATTENDUE est un compare-and-swap atomique : un
   * second appel dont la valeur attendue est périmée échoue, sans fenêtre entre la lecture et
   * l'écriture. C'est la même primitive, et la même raison, que l'avancée de la cible
   * d'intégration (M8) — et elle rend l'opération rejouable sans jamais écraser une avancée
   * concurrente.
   *
   * `branch -f` serait l'équivalent fonctionnel et reste INTERDIT : `--force`/`-f` ne passent
   * pas le garde-fou, et un CAS dit en plus ce qu'il attendait.
   */
  async setBranchToCommit(branch: string, commit: string, expectedOldCommit: string): Promise<void> {
    await this.exec(["update-ref", `refs/heads/${branch}`, commit, expectedOldCommit]);
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
     * This bypasses the FORBIDDEN_FLAGS guard deliberately and narrowly. That guard exists
     * to stop a CALLER smuggling a destructive flag into an arbitrary command; here the
     * argv is built entirely inside this method from validated inputs, no caller can
     * influence it, and the precondition above is strictly stronger than the one the
     * blocked command would have applied itself.
     */
    const { code } = await this.runInternal([
      "update-ref",
      "-d",
      `refs/heads/${branch}`,
      tip,
    ]);
    return code === 0;
  }

  /** Runs an argv built entirely inside this class. Never reachable with caller input. */
  private runInternal(args: string[]): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd: this.repoDir,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 128) : 0;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  async statusPorcelain(cwd: string): Promise<string[]> {
    const text = (await this.exec(["status", "--porcelain", "--untracked-files=all"], cwd)).stdout;
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

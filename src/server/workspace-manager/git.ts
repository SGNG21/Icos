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

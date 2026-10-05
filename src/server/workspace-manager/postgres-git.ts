import { WorkspaceError } from "./types";
import { Git } from "./git";
import postgres from "postgres";

import { TEST_DATABASE_URL, assertSafeTestDatabaseUrl } from "@/server/database/test-database-guard";

/** PostgreSQL-backed git implementation. */
export class PostgresGit extends Git {
  private readonly sql: postgres.Sql<Record<string, postgres.PostgresType>>;

  constructor(
    private readonly dbUrl: string = TEST_DATABASE_URL,
    repoDir: string = process.cwd(),
  ) {
    super(repoDir);
    const url = new URL(dbUrl);
    url.pathname = "/postgres";
    this.sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  }

  /**
   * THE SAME CONTRACT AS THE BASE CLASS, including the part that FAILS.
   *
   * This override delegated to git and resolved with whatever exit code came back — it
   * never threw, whatever `okCodes` said, while `Git.exec` throws GIT_FAILED for a code it
   * was not told to expect. Two implementations of one method disagreeing about whether a
   * failed write is an error made every unchecked write on this adapter silent: the
   * superseded-work commit and the branch compare-and-swap both resolved "fine" having
   * done nothing, and the work was simply missing from the branch afterwards.
   *
   * It keeps the command allow-list OFF deliberately — the coordinator's preserve path
   * needs `add` and `commit`, which the governed list forbids — but refusing to notice a
   * failure was never part of that, and a write whose outcome nobody checks is not a
   * write.
   */
  async exec(args: string[], cwd = this.repoDir, okCodes: number[] = [0]): Promise<{ code: number; stdout: string; stderr: string }> {
    const { execFile } = await import("node:child_process");
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
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

  protected async out(args: string[], cwd?: string): Promise<string> {
    const result = await this.exec(args, cwd);
    return result.stdout.trim();
  }

  async resolveCommit(ref: string, cwd?: string): Promise<string> {
    return this.out(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
  }

  async commitExists(ref: string): Promise<boolean> {
    return (
      (await this.exec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], this.repoDir, [0, 1])).code === 0
    );
  }

  async branchExists(branch: string): Promise<boolean> {
    return (
      (await this.exec(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.repoDir, [0, 1])).code === 0
    );
  }

  async worktrees(): Promise<{ path: string; branch: string | null; head: string }[]> {
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

  /*
   * `addWorktree` et `setBranchToCommit` sont HÉRITÉS : la forme détachée est la même pour
   * tout adaptateur réel, et `exec` redéfini ici reste celui qu'ils appellent.
   */

  async removeWorktree(worktreePath: string): Promise<void> {
    await this.exec(["worktree", "remove", worktreePath]);
  }

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

  async changedFiles(from: string, to: string): Promise<{ status: string; path: string }[]> {
    const text = await this.out(["diff", "--name-status", "--no-renames", from, to]);
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [status = "", ...rest] = l.split("\t");
        return { status, path: rest.join("\t") };
      });
  }

  async addedLines(from: string, to: string): Promise<{ file: string; line: string }[]> {
    const text = await this.out(["diff", "-U0", "--no-renames", "--no-color", from, to]);
    const added: { file: string; line: string }[] = [];
    let file = "";
    for (const line of text.split("\n")) {
      if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
      else if (line.startsWith("+") && !line.startsWith("+++"))
        added.push({ file, line: line.slice(1) });
    }
    return added;
  }

  async diffCheck(from: string, to: string): Promise<{ ok: boolean; output: string }> {
    const result = await this.exec(["merge-tree", from, to], this.repoDir, [0, 1]);
    return { ok: result.code === 0, output: result.stdout };
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await this.exec(["merge-base", "--is-ancestor", ancestor, descendant], this.repoDir, [0, 1])).code === 0;
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return this.out(["merge-base", a, b]);
  }

  async countCommits(range: string): Promise<number> {
    const text = await this.out(["rev-list", "--count", range]);
    return parseInt(text.trim(), 10) || 0;
  }

  async mergeConflicts(target: string, head: string): Promise<string[]> {
    const text = await this.out(["merge-tree", target, head]);
    const conflicts: string[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("<<<<<<< ")) {
        // Find the file path from the merge-tree output
        for (let j = i - 1; j >= 0; j--) {
          if (lines[j].startsWith("changed in ")) {
            conflicts.push(lines[j].slice("changed in ".length));
            break;
          }
        }
      }
    }
    return [...new Set(conflicts)];
  }

  async listDir(ref: string, dir: string): Promise<string[]> {
    const text = await this.out(["ls-tree", "--name-only", ref, dir]);
    return text.split("\n").filter(Boolean);
  }

  async showFile(ref: string, file: string): Promise<string> {
    return this.out(["show", `${ref}:${file}`]);
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
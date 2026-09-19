import { assertWorkerDatabaseName } from "./guards";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Dépôt git jetable + racine de worktrees, pour tester contre du vrai git. Tests uniquement. */
export interface RepoFixture {
  tmp: string;
  master: string;
  root: string;
  git(cwd: string, ...args: string[]): string;
  write(cwd: string, file: string, content: string): void;
  commit(cwd: string, message: string): string;
  cleanup(): void;
}

export function makeRepoFixture(): RepoFixture {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "wm-fixture-")));
  const master = path.join(tmp, "master");
  const root = path.join(tmp, "trees");
  mkdirSync(master);
  mkdirSync(root);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
      {
        cwd,
        encoding: "utf8",
      },
    ).trim();
  const write = (cwd: string, file: string, content: string) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content);
  };
  const commit = (cwd: string, message: string) => {
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  git(master, "init", "-q", "-b", "main");
  write(master, "src/a.ts", "export const a = 1;\n");
  write(master, "drizzle/0000_init.sql", "create table a (id int);\n");
  write(master, "drizzle/0001_more.sql", "create table b (id int);\n");
  write(master, "drizzle/meta/_journal.json", "{}\n");
  commit(master, "init");
  git(master, "branch", "integration/phase-7");
  return {
    tmp,
    master,
    root,
    git,
    write,
    commit,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

/** Faux provisionneur (mémoire) : mêmes gardes de nom que le vrai. */
export class FakeProvisioner {
  readonly databases = new Set<string>();
  async create(name: string): Promise<void> {
    assertWorkerDatabaseName(name);
    this.databases.add(name);
  }
  async drop(name: string): Promise<void> {
    assertWorkerDatabaseName(name);
    this.databases.delete(name);
  }
  readonly resets: string[] = [];
  async reset(name: string): Promise<void> {
    assertWorkerDatabaseName(name);
    this.resets.push(name);
  }
}

/** Faux exécuteur de commandes : enregistre les appels, échoue sur demande. */
export class FakeRunner {
  readonly calls: { command: string; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  failing: string[] = [];
  async run(command: string[], ctx: { cwd: string; env: NodeJS.ProcessEnv }) {
    const text = command.join(" ");
    this.calls.push({ command: text, cwd: ctx.cwd, env: ctx.env });
    const fail = this.failing.some((f) => text.includes(f));
    return { code: fail ? 1 : 0, output: fail ? "boom" : "ok" };
  }
}

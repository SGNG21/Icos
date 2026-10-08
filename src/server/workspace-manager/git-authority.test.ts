import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git } from "./git";
import {
  GIT_HARDENING_CONFIG,
  hardenedGitArgv,
  hardenedGitEnv,
  resolveWorktreeTarget,
  runGuardedGit,
} from "./git-authority";
import { PostgresGit } from "./postgres-git";
import { makeRepoFixture, type RepoFixture } from "./test-fixtures";

/**
 * MÉTADONNÉES GIT CONTRÔLÉES PAR LE WORKER — l'exploit et sa fermeture (ADR 0072, phase 0).
 *
 * Chaque vecteur est d'abord JOUÉ contre un git naïf — ce qu'ICOS faisait : `cwd` = le
 * worktree, environnement hérité — et le marqueur DOIT apparaître. C'est ce qui prouve que
 * l'attaque testée est réelle ; sans ce témoin, « aucun marqueur » pourrait seulement
 * vouloir dire que l'attaque était mal construite. Puis la même opération passe par
 * l'autorité d'ICOS, et le marqueur NE DOIT PAS apparaître.
 */

let fx: RepoFixture;
let worktree: string;
let marker: string;
let base: string;

/** Une commande qui laisse une trace si — et seulement si — quelqu'un l'exécute. */
const plant = (name = "PWNED") => {
  marker = path.join(fx.tmp, name);
  return `touch '${marker}'; false`;
};

/** Ce qu'ICOS faisait avant la phase 0 : découverte depuis le worktree, env hérité. */
const naiveGit = (cwd: string, ...args: string[]) => {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore", env: process.env });
  } catch {
    /* Le résultat importe peu : seule la trace compte. */
  }
};

/** Le worker remplace son pointeur `.git` par un dépôt à lui, config comprise. */
function hijackGitDir(config: Record<string, string>) {
  rmSync(path.join(worktree, ".git"), { recursive: true, force: true });
  execFileSync("git", ["init", "-q", worktree], { stdio: "ignore" });
  for (const [key, value] of Object.entries(config)) {
    execFileSync("git", ["-C", worktree, "config", key, value], { stdio: "ignore" });
  }
}

beforeEach(() => {
  fx = makeRepoFixture();
  base = fx.git(fx.master, "rev-parse", "HEAD");
  worktree = path.join(fx.root, "task-1");
  fx.git(fx.master, "worktree", "add", "-q", worktree, "-b", "ws/task-1", base);
  /* Le travail légitime du worker : un fichier modifié dans son worktree. */
  fx.write(worktree, "src/a.ts", "export const a = 2;\n");
});

afterEach(() => {
  fx.cleanup();
});

describe("A — le vecteur historique : `.git` remplacé, `core.fsmonitor` armé", () => {
  it("TÉMOIN : un git naïf dans le worktree EXÉCUTE la commande du worker", () => {
    hijackGitDir({ "core.fsmonitor": plant() });
    naiveGit(worktree, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
  });

  it("ICOS : statusPorcelain / headCommit / changedFiles n'exécutent RIEN", async () => {
    hijackGitDir({ "core.fsmonitor": plant() });
    const git = new Git(fx.master);
    const status = await git.statusPorcelain(worktree);
    const head = await git.headCommit(worktree);
    await git.changedFiles(base, head);
    expect(existsSync(marker)).toBe(false);
    /* Et la réponse est celle du VRAI gitdir, pas du dépôt planté par le worker. */
    expect(status).toContain(" M src/a.ts");
    expect(head).toBe(base);
  });

  it("ICOS : la préservation (add + commit) n'exécute RIEN et commite sur la VRAIE branche", async () => {
    hijackGitDir({ "core.fsmonitor": plant() });
    const git = new Git(fx.master);
    await git.preserveWorktreeChanges(worktree, "preserve");
    expect(existsSync(marker)).toBe(false);
    const tip = fx.git(fx.master, "rev-parse", "ws/task-1");
    expect(tip).not.toBe(base);
    expect(fx.git(fx.master, "show", "--name-only", "--format=", tip)).toBe("src/a.ts");
    /* Le canonique n'a pas bougé. */
    expect(fx.git(fx.master, "rev-parse", "HEAD")).toBe(base);
  });
});

describe("B — les variantes", () => {
  it("HOOKS du worker (son propre `.git`) : aucun ne s'exécute", async () => {
    hijackGitDir({});
    const hooks = path.join(worktree, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const cmd = `#!/bin/sh\n${plant("HOOK")}\n`;
    for (const hook of [
      "post-index-change",
      "pre-commit",
      "post-commit",
      "reference-transaction",
    ]) {
      writeFileSync(path.join(hooks, hook), cmd);
      chmodSync(path.join(hooks, hook), 0o755);
    }
    naiveGit(worktree, "add", "-A");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    await new Git(fx.master).preserveWorktreeChanges(worktree, "preserve");
    expect(existsSync(marker)).toBe(false);
  });

  it("HOOKS du dépôt canonique : neutralisés aussi (`core.hooksPath=/dev/null`)", async () => {
    const hooks = path.join(fx.master, ".git", "hooks");
    const cmd = `#!/bin/sh\n${plant("CANON_HOOK")}\n`;
    for (const hook of [
      "post-checkout",
      "post-commit",
      "reference-transaction",
      "post-index-change",
    ]) {
      writeFileSync(path.join(hooks, hook), cmd);
      chmodSync(path.join(hooks, hook), 0o755);
    }
    naiveGit(
      fx.master,
      "worktree",
      "add",
      "-q",
      path.join(fx.root, "task-3"),
      "-b",
      "ws/task-3",
      base,
    );
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const git = new Git(fx.master);
    await git.addWorktree(path.join(fx.root, "task-2"), "ws/task-2", base);
    await git.preserveWorktreeChanges(worktree, "preserve");
    expect(existsSync(marker)).toBe(false);
  });

  it("CONFIG LOCALE du worker : pager, pilote de filtre, diff externe — inertes", async () => {
    hijackGitDir({
      "core.pager": plant("PAGER"),
      "filter.evil.clean": plant("PAGER"),
      "filter.evil.smudge": plant("PAGER"),
      "diff.external": plant("PAGER"),
    });
    fx.write(worktree, ".gitattributes", "* filter=evil diff=evil\n");
    naiveGit(worktree, "add", "-A");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const git = new Git(fx.master);
    await git.statusPorcelain(worktree);
    await git.preserveWorktreeChanges(worktree, "preserve");
    const head = await git.headCommit(worktree);
    await git.addedLines(base, head);
    expect(existsSync(marker)).toBe(false);
  });

  it("VARIABLES GIT_* injectées dans le serveur : ignorées", async () => {
    hijackGitDir({ "core.fsmonitor": plant("ENV") });
    const evilDir = path.join(worktree, ".git");
    const injected: Record<string, string> = {
      GIT_DIR: evilDir,
      GIT_WORK_TREE: worktree,
      GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='touch ${path.join(fx.tmp, "ENV")}; false'`,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: `touch ${path.join(fx.tmp, "ENV")}; false`,
      GIT_EXTERNAL_DIFF: path.join(fx.tmp, "nope"),
    };
    const saved = Object.fromEntries(Object.keys(injected).map((k) => [k, process.env[k]]));
    Object.assign(process.env, injected);
    try {
      naiveGit(fx.master, "status", "--porcelain");
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      const git = new Git(fx.master);
      const status = await git.statusPorcelain(worktree);
      const canonicalHead = await git.resolveCommit("HEAD");
      expect(existsSync(marker)).toBe(false);
      /* GIT_DIR ignoré : la réponse vient du vrai dépôt. */
      expect(status).toContain(" M src/a.ts");
      expect(canonicalHead).toBe(base);
      for (const name of Object.keys(injected)) {
        expect(hardenedGitEnv()[name], name).toBeUndefined();
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("`.git` POINTANT VERS UN AUTRE GITDIR : jamais suivi", async () => {
    /* Un autre dépôt, à un autre commit, armé. */
    const other = path.join(fx.tmp, "other");
    execFileSync("git", ["init", "-q", "-b", "main", other], { stdio: "ignore" });
    fx.write(other, "x.txt", "autre\n");
    const otherHead = fx.commit(other, "other");
    execFileSync("git", ["-C", other, "config", "core.fsmonitor", plant("POINTER")]);
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
    naiveGit(worktree, "status");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const git = new Git(fx.master);
    const head = await git.headCommit(worktree);
    expect(existsSync(marker)).toBe(false);
    expect(head).toBe(base);
    expect(head).not.toBe(otherHead);
  });

  it("le gitdir est DÉRIVÉ du canonique, sans lire `<worktree>/.git`", async () => {
    rmSync(path.join(worktree, ".git"));
    const target = await resolveWorktreeTarget(fx.master, worktree);
    expect(target.gitDir).toBe(path.join(fx.master, ".git", "worktrees", "task-1"));
    expect(target.workTree).toBe(worktree);
  });

  it("un dossier qui n'est PAS un worktree enregistré : refus, aucune découverte", async () => {
    const stray = path.join(fx.tmp, "stray");
    execFileSync("git", ["init", "-q", stray], { stdio: "ignore" });
    execFileSync("git", ["-C", stray, "config", "core.fsmonitor", plant("STRAY")]);
    await expect(new Git(fx.master).statusPorcelain(stray)).rejects.toThrow(
      /WORKTREE_UNREGISTERED|n'est pas un worktree/,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("SOUS-MODULE planté puis enregistré : `status` n'y descend pas, la préservation refuse", async () => {
    /* Surface découverte en phase 0 : un git ENFANT lit la config du sous-module. */
    const sub = path.join(worktree, "src", "sub");
    execFileSync("git", ["init", "-q", "-b", "main", sub], { stdio: "ignore" });
    fx.write(sub, "s.txt", "s\n");
    /* Un pilote de filtre : un nom libre, que `-c` ne peut pas neutraliser d'avance. */
    fx.write(sub, ".gitattributes", "* filter=evil\n");
    fx.commit(sub, "s");
    /* Le gitlink est enregistré par le HARNAIS (l'état qu'un worktree peut atteindre). */
    fx.commit(worktree, "nested repo registered");
    execFileSync("git", ["-C", sub, "config", "core.fsmonitor", plant("SUBMODULE")]);
    execFileSync("git", ["-C", sub, "config", "filter.evil.clean", plant("SUBMODULE")]);
    fx.write(sub, "s.txt", "dirty\n");

    naiveGit(worktree, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    /*
     * Le témoin a rafraîchi l'index du sous-module : sans nouvelle modification, l'opération
     * d'ICOS ne trouverait rien à filtrer et passerait sans rien prouver.
     */
    fx.write(sub, "s.txt", "dirty again, and longer\n");

    const git = new Git(fx.master);
    await git.statusPorcelain(worktree);
    await expect(git.preserveWorktreeChanges(worktree, "again")).rejects.toThrow(
      /GIT_NESTED_REPOSITORY_REFUSED/,
    );
    expect(existsSync(marker)).toBe(false);
  });
});

describe("SOUS-MODULE planté : la préservation REFUSE, sans rien exécuter", () => {
  it("TÉMOIN : `git add -A` naïf sur un gitlink suivi exécute le filtre du sous-module", () => {
    const sub = path.join(worktree, "src", "sub");
    execFileSync("git", ["init", "-q", "-b", "main", sub], { stdio: "ignore" });
    fx.write(sub, "s.txt", "s\n");
    fx.write(sub, ".gitattributes", "* filter=evil\n");
    fx.commit(sub, "s");
    fx.commit(worktree, "nested repo registered");
    execFileSync("git", ["-C", sub, "config", "filter.evil.clean", plant("ADD")]);
    /* Hors de la fenêtre « racy-git » : le contenu doit être relu, donc filtré. */
    fx.write(sub, "s.txt", "dirty, and longer\n");
    naiveGit(worktree, "add", "-A");
    expect(existsSync(marker)).toBe(true);
  });

  it("dépôt imbriqué NON SUIVI et armé : refus, aucun index écrit, rien exécuté", async () => {
    const sub = path.join(worktree, "src", "sub");
    execFileSync("git", ["init", "-q", "-b", "main", sub], { stdio: "ignore" });
    fx.write(sub, "s.txt", "s\n");
    fx.commit(sub, "s");
    fx.write(sub, ".gitattributes", "* filter=evil\n");
    execFileSync("git", ["-C", sub, "config", "filter.evil.clean", plant("ARMED")]);
    execFileSync("git", ["-C", sub, "config", "core.fsmonitor", plant("ARMED")]);
    fx.write(sub, "s.txt", "dirty\n");

    const git = new Git(fx.master);
    await expect(git.preserveWorktreeChanges(worktree, "nested")).rejects.toThrow(
      /GIT_NESTED_REPOSITORY_REFUSED.*src\/sub\//,
    );
    expect(existsSync(marker)).toBe(false);
    /* Rien n'a été indexé ni commité : la branche n'a pas bougé. */
    expect(fx.git(fx.master, "rev-parse", "ws/task-1")).toBe(base);
  });

  it("gitlink SUIVI et armé : refus, rien exécuté", async () => {
    const sub = path.join(worktree, "src", "sub");
    execFileSync("git", ["init", "-q", "-b", "main", sub], { stdio: "ignore" });
    fx.write(sub, "s.txt", "s\n");
    fx.write(sub, ".gitattributes", "* filter=evil\n");
    fx.commit(sub, "s");
    fx.commit(worktree, "nested repo registered");
    execFileSync("git", ["-C", sub, "config", "filter.evil.clean", plant("TRACKED")]);
    fx.write(sub, "s.txt", "dirty, and longer\n");
    fx.write(worktree, "src/a.ts", "export const a = 9;\n");

    await expect(new Git(fx.master).preserveWorktreeChanges(worktree, "x")).rejects.toThrow(
      /GIT_NESTED_REPOSITORY_REFUSED.*src\/sub/,
    );
    expect(existsSync(marker)).toBe(false);
  });
});

describe("SOUS-MODULE planté puis nettoyage", () => {
  it("removeWorktree (cleanup) refuse AVANT toute descente dans un sous-module armé", async () => {
    /*
     * `worktree remove` lance en interne `status --ignore-submodules=none`, qu'aucune config
     * ne peut assouplir. Ce qui le rend sûr est mesuré ici : git refuse d'abord un worktree
     * qui contient un gitlink. Conséquence connue : un tel workspace ne se nettoie pas (une
     * disponibilité perdue, pas une exécution) — rapporté comme risque résiduel.
     */
    const sub = path.join(worktree, "src", "sub");
    execFileSync("git", ["init", "-q", "-b", "main", sub], { stdio: "ignore" });
    fx.write(sub, "s.txt", "s\n");
    fx.write(sub, ".gitattributes", "* filter=evil\n");
    fx.commit(sub, "s");
    fx.commit(worktree, "nested repo registered");
    const git = new Git(fx.master);
    execFileSync("git", ["-C", sub, "config", "filter.evil.clean", plant("CLEANUP")]);
    fx.write(sub, "s.txt", "dirty\n");

    await expect(git.removeWorktree(worktree)).rejects.toThrow(/containing submodules/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("config du DÉPÔT : une surface d'exécution REFUSE l'opération", () => {
  for (const [key, value] of [
    ["filter.lfs.clean", "touch x"],
    ["filter.any.process", "touch x"],
    ["diff.external", "touch x"],
    ["diff.evil.textconv", "touch x"],
    ["include.path", "/tmp/elsewhere"],
    ["credential.helper", "store"],
    ["core.fsmonitor", "touch x"],
    ["core.sshCommand", "touch x"],
    ["gpg.program", "touch x"],
  ] as const) {
    it(`${key} → GIT_CONFIG_UNSAFE`, async () => {
      fx.git(fx.master, "config", key, value);
      await expect(new Git(fx.master).resolveCommit("HEAD")).rejects.toThrow(/GIT_CONFIG_UNSAFE/);
    });
  }

  it("`core.fsmonitor=false` explicite reste accepté", async () => {
    fx.git(fx.master, "config", "core.fsmonitor", "false");
    await expect(new Git(fx.master).resolveCommit("HEAD")).resolves.toBe(base);
  });
});

describe("C — les opérations légitimes fonctionnent toujours", () => {
  it("status, HEAD, diff, préservation, ajout/retrait de worktree, CAS, suppression de branche", async () => {
    const git = new Git(fx.master);
    expect(await git.statusPorcelain(worktree)).toEqual([" M src/a.ts"]);
    expect(await git.headCommit(worktree)).toBe(base);

    await git.preserveWorktreeChanges(worktree, "work");
    expect(await git.statusPorcelain(worktree)).toEqual([]);
    const head = await git.headCommit(worktree);
    expect(await git.changedFiles(base, head)).toEqual([{ status: "M", path: "src/a.ts" }]);
    expect(await git.addedLines(base, head)).toEqual([
      { file: "src/a.ts", line: "export const a = 2;" },
    ]);
    expect(await git.isAncestor(base, head)).toBe(true);
    expect((await git.worktrees()).map((w) => w.branch)).toContain("ws/task-1");

    const second = path.join(fx.root, "task-2");
    await git.addWorktree(second, "ws/task-2", base);
    expect(existsSync(path.join(second, "src", "a.ts"))).toBe(true);
    await git.removeWorktree(second);
    expect(existsSync(second)).toBe(false);

    await git.removeWorktree(worktree);
    expect(await git.compareAndSwapBranch("integration/phase-7", base, head)).toBe(true);
    expect(await git.deleteBranchMergedInto("ws/task-1", "integration/phase-7")).toBe(true);
    expect(await git.branchExists("ws/task-1")).toBe(false);
  });

  it("listDir et mergeConflicts répondent ENFIN à la question (défaut de PostgresGit)", async () => {
    const git = new PostgresGit("postgres://icos@127.0.0.1:1/icos_test", fx.master);
    try {
      expect(await git.listDir("HEAD", "drizzle")).toEqual([
        "0000_init.sql",
        "0001_more.sql",
        "meta",
      ]);
      fx.write(fx.master, "src/a.ts", "export const a = 3;\n");
      const target = fx.commit(fx.master, "target moves");
      await new Git(fx.master).preserveWorktreeChanges(worktree, "conflicting");
      const head = await git.headCommit(worktree);
      expect(await git.mergeConflicts(target, head)).toEqual(["src/a.ts"]);
    } finally {
      await git.close();
    }
  });
});

describe("D — PostgresGit n'a plus de voie secondaire", () => {
  it("ne redéfinit RIEN qui lance git : seuls constructeur et close lui sont propres", () => {
    expect(Object.getOwnPropertyNames(PostgresGit.prototype).sort()).toEqual([
      "close",
      "constructor",
    ]);
  });

  it("refuse les verbes et options interdits, comme le port", async () => {
    const git = new PostgresGit("postgres://icos@127.0.0.1:1/icos_test", fx.master);
    try {
      for (const args of [
        ["push", "origin", "main"],
        ["reset", "--hard"],
        ["commit", "-m", "x"],
        ["add", "-A"],
        ["clean", "-fdx"],
        ["checkout", "main"],
        ["-c", "core.fsmonitor=touch x", "status"],
        ["--git-dir", "/tmp", "status"],
        ["branch", "-D", "main"],
        ["worktree", "remove", "--force", worktree],
      ]) {
        await expect(git.exec(args), args.join(" ")).rejects.toThrow(/GIT_FORBIDDEN/);
      }
    } finally {
      await git.close();
    }
  });

  it("un échec git ÉCHOUE au lieu de rendre une chaîne vide (il ne le faisait pas)", async () => {
    const git = new PostgresGit("postgres://icos@127.0.0.1:1/icos_test", fx.master);
    try {
      await expect(git.resolveCommit("ref-qui-n-existe-pas")).rejects.toThrow(/GIT_FAILED/);
    } finally {
      await git.close();
    }
  });

  it("aucun fichier de production ne lance git hors de l'autorité", () => {
    const srcRoot = path.resolve(__dirname, "..", "..");
    const offenders: string[] = [];
    const spawnsGit =
      /(execFile|execFileSync|spawn|spawnSync|exec|execSync)\(\s*["'`]git\b|command:\s*["'`]git["'`]/;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "node_modules" && full !== path.join(srcRoot, "test")) walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        if (name === "test-fixtures.ts" || name === "git-authority.ts") continue;
        if (spawnsGit.test(readFileSync(full, "utf8")))
          offenders.push(path.relative(srcRoot, full));
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

describe("l'invocation durcie", () => {
  it("porte chaque neutralisation, et la cible explicite AVANT la commande", () => {
    const argv = hardenedGitArgv(["status"], { gitDir: "/g", workTree: "/w" });
    expect(argv[0]).toBe("--no-pager");
    for (const entry of [
      "core.fsmonitor=false",
      "core.hooksPath=/dev/null",
      "core.untrackedCache=false",
      "core.attributesFile=/dev/null",
      "protocol.allow=never",
      "credential.helper=",
    ]) {
      expect(GIT_HARDENING_CONFIG).toContain(entry);
      expect(argv.join(" ")).toContain(`-c ${entry}`);
    }
    expect(argv.slice(-5)).toEqual(["--git-dir", "/g", "--work-tree", "/w", "status"]);
  });

  it("l'environnement est CONSTRUIT : aucun secret, aucun GIT_* hérité, HOME vide", () => {
    process.env.ICOS_PROOF_SECRET = "NE-DOIT-PAS-FUIR";
    try {
      const env = hardenedGitEnv();
      expect(Object.keys(env).sort()).toEqual(
        [
          "GIT_ATTR_NOSYSTEM",
          "GIT_CONFIG_GLOBAL",
          "GIT_CONFIG_NOSYSTEM",
          "GIT_OPTIONAL_LOCKS",
          "GIT_TERMINAL_PROMPT",
          "HOME",
          "PATH",
        ].sort(),
      );
      expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(env.HOME).not.toBe(process.env.HOME);
      expect(readdirSync(env.HOME!)).toEqual([]);
      expect(JSON.stringify(env)).not.toContain("NE-DOIT-PAS-FUIR");
    } finally {
      delete process.env.ICOS_PROOF_SECRET;
    }
  });

  it("aucun transport réseau n'est possible", async () => {
    await expect(
      runGuardedGit(["rev-parse", "HEAD"], { repoDir: fx.master }),
    ).resolves.toMatchObject({ code: 0 });
    const r = (() => {
      try {
        execFileSync("git", hardenedGitArgv(["ls-remote", "https://example.invalid/x"]), {
          cwd: fx.master,
          env: hardenedGitEnv() as NodeJS.ProcessEnv,
          stdio: ["ignore", "ignore", "pipe"],
        });
        return "";
      } catch (error) {
        return String((error as { stderr?: Buffer }).stderr ?? "");
      }
    })();
    expect(r).toMatch(/transport .* not allowed/);
  });
});

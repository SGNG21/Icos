import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { WorkspaceError } from "./types";

/**
 * L'UNIQUE AUTORITÉ D'EXÉCUTION GIT PRIVILÉGIÉE D'ICOS (ADR 0072, phase 0).
 *
 * ── LA FAILLE QUE CE MODULE FERME ───────────────────────────────────────────────────────
 * Un worker gouverné écrit son worktree. Son entrée `.git` en fait partie : il pouvait la
 * remplacer par un dossier dont la config contient `core.fsmonitor = <commande>`. ICOS
 * lançait ensuite `git status` AVEC `cwd` = ce worktree — hors sandbox, avec tout
 * l'environnement du serveur — et git, découvrant le `.git` du worker, exécutait sa
 * commande. Reproduit, pas supposé. Les hooks, une config locale, `GIT_*` hérités, un
 * `.git` pointant ailleurs : même famille, même cause — ICOS faisait confiance à des
 * métadonnées git que le worker contrôle.
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────────────────
 * 1. Seul le checkout CANONIQUE est jamais « découvert » par git. Toute opération qui vise
 *    un worktree reçoit `--git-dir` et `--work-tree` EXPLICITES, le gitdir étant DÉRIVÉ du
 *    canonique (`<commun>/worktrees/<id>/gitdir`, que git y a écrit à la création et
 *    qu'aucun worker ne peut modifier). Le fichier `<worktree>/.git` n'est jamais lu.
 * 2. L'environnement est CONSTRUIT, jamais hérité : aucun `GIT_*` du parent, aucun HOME
 *    réel, aucune config système ou globale.
 * 3. Chaque surface d'exécution configurable est neutralisée en ligne de commande (`-c`),
 *    ce que git propage à ses sous-processus via `GIT_CONFIG_PARAMETERS`.
 * 4. Ce qui ne peut pas être neutralisé ainsi (`include.path`, pilotes `filter.*`…) est
 *    REFUSÉ : la config du dépôt est auditée avant tout usage, et une config qui en porte
 *    arrête l'opération (fail-closed).
 * 5. Les verbes sont filtrés ICI, pour toute implémentation du port `Git` : il n'y a plus
 *    de sous-classe qui lance `git` elle-même.
 *
 * ── CE QUI N'EST PAS ICI ────────────────────────────────────────────────────────────────
 * Le cycle métier (qui commite, quand) ne change pas en phase 0. Les commandes du gate
 * (typecheck, tests…) ne sont pas des commandes git et restent hors de ce module — voir le
 * rapport de phase 0, risque résiduel P0.
 */

export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Un worktree adressé SANS découverte : gitdir dérivé du canonique, arbre explicite. */
export interface WorktreeTarget {
  readonly gitDir: string;
  readonly workTree: string;
}

/** Sous-commandes autorisées. Tout le reste (reset, push, clean, merge, rebase, checkout…) est refusé. */
export const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
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

export const FORBIDDEN_GIT_FLAGS: ReadonlySet<string> = new Set([
  "--force",
  "-f",
  "-D",
  "--hard",
  "--force-with-lease",
  "--delete",
]);

/**
 * Les surfaces neutralisées sur CHAQUE invocation. Toutes sont des clés que git lirait
 * sinon dans une config que quelqu'un d'autre qu'ICOS pourrait écrire.
 */
export const GIT_HARDENING_CONFIG: readonly string[] = Object.freeze([
  /* Exécute une commande à chaque `status` : le vecteur reproduit. */
  "core.fsmonitor=false",
  /* Hooks : post-checkout sur `worktree add`, post-commit, etc. */
  "core.hooksPath=/dev/null",
  "core.untrackedCache=false",
  "core.attributesFile=/dev/null",
  /* Jamais de tty ici, mais la valeur ne doit pas dépendre de ce détail. */
  "core.pager=cat",
  /* Aucun transport : aucune opération privilégiée n'a besoin du réseau. */
  "protocol.allow=never",
  /* Valeur vide = liste des assistants remise à zéro : aucun ne peut être appelé. */
  "credential.helper=",
  /* Une signature lance `gpg.program`. */
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  /* `gc --auto` / maintenance lancent des sous-processus après une écriture. */
  "gc.auto=0",
  "maintenance.auto=false",
  /*
   * Les sous-modules : `status` descend dans un sous-module ENREGISTRÉ et y lance un git
   * qui DÉCOUVRE le `.git` du sous-module — contrôlé par le worker s'il l'a créé. Ces deux
   * clés ne suffisent pas : `status` reçoit en plus `--ignore-submodules=dirty` (voir
   * `Git.statusPorcelain`), et la préservation REFUSE un arbre qui contient un dépôt
   * imbriqué (`assertNoNestedRepository`), parce que `add` y descend quoi qu'on configure.
   * PAS de `diff.ignoreSubmodules=all` global : il cacherait aussi l'AJOUT d'un gitlink au
   * `diff` du gate, c'est-à-dire affaiblirait le contrôle de périmètre.
   */
  "submodule.recurse=false",
  "status.submoduleSummary=false",
]);

/**
 * Clés qui, présentes dans la config du DÉPÔT, permettraient d'exécuter un programme, de
 * lire un autre fichier de config, ou d'atteindre un secret, et que `-c` ne peut pas
 * neutraliser de façon générique (le nom du pilote est libre). Leur présence REFUSE.
 *
 * Testé sur la clé en minuscules ; git normalise section et variable, pas la sous-section.
 */
const UNSAFE_REPO_CONFIG: readonly RegExp[] = Object.freeze([
  /^filter\..+\.(clean|smudge|process)$/,
  /^diff\.external$/,
  /^diff\..+\.(command|textconv)$/,
  /^merge\..+\.driver$/,
  /^include\.path$/,
  /^includeif\./,
  /^credential\./,
  /^core\.(hookspath|sshcommand|askpass|gitproxy|pager|editor)$/,
  /^pager\./,
  /^gpg\.(.+\.)?program$/,
  /^sequence\.editor$/,
  /^interactive\.difffilter$/,
]);

/** `core.fsmonitor` est accepté seulement explicitement désactivé. */
const FSMONITOR_OFF = new Set(["false", "0", "no", "off"]);

/**
 * Le binaire git, à un chemin FIXE. Le résoudre par le `PATH` laisserait quiconque
 * contrôle le `PATH` du serveur substituer un faux `git`.
 */
const GIT_CANDIDATES: readonly string[] = [
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
];

let gitPath: string | undefined;
export function gitBinary(): string {
  if (gitPath) return gitPath;
  const found = GIT_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) throw new WorkspaceError("GIT_FAILED", "git introuvable aux chemins système");
  gitPath = found;
  return found;
}

let gitHome: string | undefined;
/**
 * L'environnement de TOUT git privilégié. Construit, jamais hérité : le parent porte
 * `DATABASE_URL`, des clés d'API, peut-être `GIT_DIR` ou `GIT_CONFIG_PARAMETERS`, et git
 * honorerait ces derniers avant toute option.
 */
export function hardenedGitEnv(): Record<string, string> {
  /* Un HOME vide, propre au processus : aucun `~/.gitconfig`, aucun `~/.git-credentials`. */
  gitHome ??= mkdtempSync(join(tmpdir(), "icos-git-home-"));
  return {
    PATH: [dirname(gitBinary()), "/usr/bin", "/bin"].join(":"),
    HOME: gitHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    /* Un `status` en lecture n'écrit pas l'index au passage. */
    GIT_OPTIONAL_LOCKS: "0",
  };
}

/** argv complet : options globales durcies, cible explicite éventuelle, puis la commande. */
export function hardenedGitArgv(args: readonly string[], target?: WorktreeTarget): string[] {
  return [
    "--no-pager",
    ...GIT_HARDENING_CONFIG.flatMap((entry) => ["-c", entry]),
    ...(target ? ["--git-dir", target.gitDir, "--work-tree", target.workTree] : []),
    ...args,
  ];
}

/** Le seul `execFile("git")` du serveur. Privé : on y entre par les fonctions ci-dessous. */
function spawnGit(
  argv: readonly string[],
  cwd: string,
  timeoutMs?: number,
): Promise<GitExecResult> {
  return new Promise<GitExecResult>((done) => {
    execFile(
      gitBinary(),
      argv,
      /*
       * Le dépôt AUGMENTE `NodeJS.ProcessEnv` pour exiger `NODE_ENV` : contrainte sur CE
       * processus, pas sur l'environnement construit pour git. Même conversion qu'au runner.
       */
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: hardenedGitEnv() as NodeJS.ProcessEnv,
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 128) : 0;
        done({ code, stdout, stderr });
      },
    );
  });
}

function assertCode(argv: readonly string[], result: GitExecResult, okCodes: readonly number[]) {
  if (!okCodes.includes(result.code)) {
    throw new WorkspaceError(
      "GIT_FAILED",
      `git ${argv.join(" ")} -> ${result.code}: ${result.stderr.trim()}`,
    );
  }
}

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

interface RepoLayout {
  /** `<…>/.git` commun à tous les worktrees. */
  readonly commonDir: string;
  /** Le gitdir du checkout canonique lui-même (égal à `commonDir` hors worktree lié). */
  readonly ownGitDir: string;
  /** Racine de l'arbre du checkout canonique. */
  readonly topLevel: string;
}

const layouts = new Map<string, Promise<RepoLayout>>();
const auditedGitDirs = new Map<string, Promise<void>>();

/** Lu dans le checkout canonique, qui est le seul endroit où la découverte est sûre. */
function repoLayout(repoDir: string): Promise<RepoLayout> {
  const key = resolve(repoDir);
  let pending = layouts.get(key);
  if (!pending) {
    pending = (async () => {
      const argv = hardenedGitArgv([
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--absolute-git-dir",
        "--show-toplevel",
      ]);
      const result = await spawnGit(argv, key);
      assertCode(argv, result, [0]);
      const [commonDir, ownGitDir, topLevel] = result.stdout.trim().split("\n");
      if (!commonDir || !ownGitDir || !topLevel) {
        throw new WorkspaceError("GIT_FAILED", `disposition du dépôt illisible : ${key}`);
      }
      return {
        commonDir: realOrNull(commonDir) ?? commonDir,
        ownGitDir: realOrNull(ownGitDir) ?? ownGitDir,
        topLevel: realOrNull(topLevel) ?? topLevel,
      };
    })();
    /* Un échec n'est pas mis en cache : la cause (dépôt absent) peut être corrigée. */
    pending.catch(() => layouts.delete(key));
    layouts.set(key, pending);
  }
  return pending;
}

/**
 * Le gitdir d'un worktree, DÉRIVÉ du canonique.
 *
 * Git enregistre chaque worktree lié dans `<commun>/worktrees/<id>/gitdir`, qui contient le
 * chemin de `<worktree>/.git`. On compare le DOSSIER de ce chemin au worktree demandé, sans
 * jamais ouvrir `<worktree>/.git` : ce fichier appartient à l'arbre du worker, l'entrée du
 * canonique non. Aucun enregistrement = aucun gitdir = refus.
 */
export async function resolveWorktreeTarget(
  repoDir: string,
  worktreePath: string,
): Promise<WorktreeTarget> {
  const layout = await repoLayout(repoDir);
  const wanted = realOrNull(worktreePath);
  if (!wanted) {
    throw new WorkspaceError("WORKTREE_UNREGISTERED", `worktree absent : ${worktreePath}`);
  }

  if (wanted === layout.topLevel) {
    return { gitDir: layout.ownGitDir, workTree: wanted };
  }
  /* Le checkout principal, quand le canonique est lui-même un worktree lié. */
  if (basename(layout.commonDir) === ".git" && wanted === realOrNull(dirname(layout.commonDir))) {
    return { gitDir: layout.commonDir, workTree: wanted };
  }

  const registry = join(layout.commonDir, "worktrees");
  let ids: string[] = [];
  try {
    ids = readdirSync(registry);
  } catch {
    ids = [];
  }
  for (const id of ids) {
    let recorded: string;
    try {
      recorded = readFileSync(join(registry, id, "gitdir"), "utf8").trim();
    } catch {
      continue;
    }
    if (realOrNull(dirname(recorded)) === wanted) {
      return { gitDir: join(registry, id), workTree: wanted };
    }
  }
  throw new WorkspaceError(
    "WORKTREE_UNREGISTERED",
    `${worktreePath} n'est pas un worktree enregistré dans ${layout.commonDir}`,
  );
}

/**
 * Refuse une config de dépôt qui porte une surface d'exécution. Lue avec l'environnement
 * durci et SANS les `-c` de durcissement, pour ne voir que ce que le dépôt déclare —
 * `include.path` déjà déplié par git, donc un fichier inclus est audité aussi.
 */
async function assertTrustedConfig(gitDir: string, cwd: string): Promise<void> {
  let pending = auditedGitDirs.get(gitDir);
  if (!pending) {
    pending = (async () => {
      const argv = ["--no-pager", "--git-dir", gitDir, "config", "--list", "-z"];
      const result = await spawnGit(argv, cwd);
      /* 1 = aucune entrée : une config vide est sûre. */
      assertCode(argv, result, [0, 1]);
      const unsafe: string[] = [];
      for (const entry of result.stdout.split("\0").filter(Boolean)) {
        const newline = entry.indexOf("\n");
        const key = (newline === -1 ? entry : entry.slice(0, newline)).toLowerCase();
        const value =
          newline === -1
            ? ""
            : entry
                .slice(newline + 1)
                .trim()
                .toLowerCase();
        if (key === "core.fsmonitor" && !FSMONITOR_OFF.has(value)) unsafe.push(key);
        else if (UNSAFE_REPO_CONFIG.some((pattern) => pattern.test(key))) unsafe.push(key);
      }
      if (unsafe.length > 0) {
        throw new WorkspaceError(
          "GIT_CONFIG_UNSAFE",
          `config du dépôt refusée (surface d'exécution) : ${[...new Set(unsafe)].join(", ")}`,
        );
      }
    })();
    pending.catch(() => auditedGitDirs.delete(gitDir));
    auditedGitDirs.set(gitDir, pending);
  }
  return pending;
}

export interface GitRunOptions {
  /** Le checkout canonique : le seul découvert, et la référence de toute dérivation. */
  readonly repoDir: string;
  /**
   * Un worktree visé. Absent ou égal au canonique = le canonique. Sinon le gitdir est
   * dérivé ; `<worktree>/.git` n'est jamais consulté.
   */
  readonly worktree?: string;
  readonly okCodes?: readonly number[];
  /** Borne de durée ; à l'expiration git est tué et l'appel échoue. */
  readonly timeoutMs?: number;
}

/** Commun aux deux entrées : cible, audit, invocation durcie. */
async function runHardened(
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitExecResult> {
  const repoDir = resolve(options.repoDir);
  const layout = await repoLayout(repoDir);
  const worktree = options.worktree === undefined ? undefined : resolve(options.worktree);
  const target =
    worktree === undefined || worktree === repoDir
      ? undefined
      : await resolveWorktreeTarget(repoDir, worktree);

  await assertTrustedConfig(layout.ownGitDir, repoDir);
  if (target) await assertTrustedConfig(target.gitDir, repoDir);

  const argv = hardenedGitArgv(args, target);
  const result = await spawnGit(argv, target?.workTree ?? repoDir, options.timeoutMs);
  assertCode(argv, result, options.okCodes ?? [0]);
  return result;
}

/**
 * L'entrée GÉNÉRALE : verbe filtré, options destructives refusées. C'est ce que le port
 * `Git` expose à ses appelants, et le premier argument ne peut pas être une option globale
 * (`-c`, `--git-dir`…) : il doit être un verbe autorisé.
 */
export function runGuardedGit(
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitExecResult> {
  if (!ALLOWED_GIT_SUBCOMMANDS.has(args[0] ?? "")) {
    return Promise.reject(new WorkspaceError("GIT_FORBIDDEN", `git ${args[0]} interdit`));
  }
  if (args.some((a) => FORBIDDEN_GIT_FLAGS.has(a))) {
    return Promise.reject(
      new WorkspaceError("GIT_FORBIDDEN", `option destructive: ${args.join(" ")}`),
    );
  }
  return runHardened(args, options);
}

/*
 * ── LES OPÉRATIONS INTERNES ─────────────────────────────────────────────────────────────
 * Chacune contourne le filtre de verbes ÉTROITEMENT : son argv est construit ici, à partir
 * d'entrées validées, et aucun appelant ne peut y ajouter un mot. Le durcissement, lui, ne
 * se contourne jamais.
 */

/**
 * `update-ref -d <ref> <old>` : suppression compare-and-swap (voir
 * `Git.deleteBranchMergedInto`, qui en porte la précondition d'ancestry).
 */
export async function deleteRefIfAt(
  repoDir: string,
  ref: string,
  expectedOld: string,
): Promise<boolean> {
  if (!ref.startsWith("refs/heads/") || !/^[0-9a-f]{40,64}$/.test(expectedOld)) {
    throw new WorkspaceError("GIT_FORBIDDEN", `suppression de ref refusée : ${ref}`);
  }
  const result = await runHardened(["update-ref", "-d", ref, expectedOld], {
    repoDir,
    okCodes: [0, 1, 128],
  });
  return result.code === 0;
}

/**
 * PRÉSERVE le travail non commité d'un worktree sur SA PROPRE branche
 * (SUPERSEDED_DIRTY_WORKSPACE_HELD — comportement inchangé, désormais durci).
 *
 * Le contenu est celui du worker et n'est pas digne de confiance : `add` le lit, mais avec
 * le gitdir dérivé, sans hooks (`--no-verify` ET `core.hooksPath=/dev/null`), sans
 * signature, et après audit d'une config qui ne déclare aucun pilote de filtre.
 */
export async function preserveWorktreeChanges(
  repoDir: string,
  worktree: string,
  message: string,
): Promise<void> {
  if (resolve(worktree) === resolve(repoDir)) {
    throw new WorkspaceError("GIT_FORBIDDEN", "jamais de commit dans le checkout canonique");
  }
  await assertNoNestedRepository(repoDir, worktree);
  /* Défense en profondeur : aucun sous-module n'existe à ce stade, et aucun n'est visité. */
  const noSubmodules = ["-c", "diff.ignoreSubmodules=all"];
  await runHardened([...noSubmodules, "add", "-A"], { repoDir, worktree });
  /* Rien d'indexé = rien à préserver ; `diff --cached` ne lit que l'index et HEAD. */
  const staged = await runHardened(["diff", "--cached", "--quiet"], {
    repoDir,
    worktree,
    okCodes: [0, 1],
  });
  if (staged.code === 0) return;
  await runHardened(
    [
      ...noSubmodules,
      "-c",
      "user.name=icos",
      "-c",
      "user.email=icos@local",
      "commit",
      "-q",
      "--no-verify",
      "-m",
      message,
    ],
    { repoDir, worktree },
  );
}

/**
 * REFUSE UN DÉPÔT IMBRIQUÉ avant toute écriture d'index (ADR 0072, phase 0).
 *
 * Mesuré : face à un gitlink SUIVI, `git add -A` lance un `git status` DANS le sous-module
 * pour savoir s'il est modifié — et ce git-là lit la config du sous-module, que le worker
 * écrit, et y exécute son pilote de filtre (`filter.<nom>.clean`). Aucune option ne l'en
 * empêche pour `add` (`diff.ignoreSubmodules` n'y est pas lu, et un nom de pilote ne peut
 * pas être neutralisé d'avance). Le seul arrangement sûr est de ne jamais indexer un arbre
 * qui en contient : un gitlink n'a de toute façon pas sa place dans le travail d'un worker.
 *
 * Détection SANS descente : `ls-files -s` lit l'index (gitlinks suivis, mode 160000) ;
 * `ls-files -o` liste un dépôt imbriqué non suivi comme un dossier (`chemin/`) sans y entrer.
 * Un dépôt imbriqué ignoré par `.gitignore` ne serait de toute façon pas indexé par `add`.
 */
async function assertNoNestedRepository(repoDir: string, worktree: string): Promise<void> {
  const tracked = await runHardened(["ls-files", "-s", "-z"], { repoDir, worktree });
  const gitlinks = tracked.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  const untracked = await runHardened(["ls-files", "-o", "--exclude-standard", "-z"], {
    repoDir,
    worktree,
  });
  const nested = untracked.stdout.split("\0").filter((entry) => entry.endsWith("/"));
  const found = [...gitlinks, ...nested];
  if (found.length > 0) {
    throw new WorkspaceError(
      "GIT_NESTED_REPOSITORY_REFUSED",
      `dépôt imbriqué dans le worktree, rien n'est indexé : ${found.join(", ")}`,
    );
  }
}

/**
 * Retire un worktree AD HOC du chemin legacy (`writer-workspace.ts`), y compris sale :
 * c'est le comportement historique de ce chemin, qui garde la BRANCHE comme preuve. Jamais
 * pour un worktree du WorkspaceManager, dont le `cleanup` refuse un arbre sale.
 */
export async function removeAdHocWorktree(
  repoDir: string,
  worktree: string,
  timeoutMs?: number,
): Promise<void> {
  const path = resolve(worktree);
  if (path === resolve(repoDir)) {
    throw new WorkspaceError("GIT_FORBIDDEN", "jamais de retrait du checkout canonique");
  }
  await runHardened(["worktree", "remove", "--force", path], {
    repoDir,
    okCodes: [0, 128],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** `worktree add -b` puis `worktree prune` : les deux écritures du chemin legacy. */
export async function addAdHocWorktree(
  repoDir: string,
  branch: string,
  path: string,
  baseCommit: string,
  timeoutMs?: number,
): Promise<void> {
  await runGuardedGit(["worktree", "add", "-b", branch, path, baseCommit], {
    repoDir,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

export async function pruneWorktrees(repoDir: string, timeoutMs?: number): Promise<void> {
  await runGuardedGit(["worktree", "prune"], {
    repoDir,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

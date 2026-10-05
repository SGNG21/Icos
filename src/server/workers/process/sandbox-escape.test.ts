import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { brokerCredentials, seedHome } from "./credential-broker";
import { createEphemeralHome, isSafeHomeRelativePath } from "./ephemeral-home";
import { decideConfinement, runNonInteractive, SANDBOX_EXEC } from "./run-process";
import { networkEnforced, seatbeltProfile } from "./sandbox-profile";

/**
 * TENTATIVES D'ÉVASION — le bac à sable est-il une barrière ou une convention ? (verrou C8)
 *
 * Chaque test ESSAIE de sortir, par un chemin par lequel un worker réel pourrait sortir :
 * remontée `../`, chemin absolu, lien symbolique, lecture du vrai HOME, exfiltration d'une
 * variable d'environnement, écriture dans un autre worktree. Un test qui se contente de
 * vérifier qu'un worker écrit bien SON répertoire ne prouve rien du tout.
 *
 * Ces preuves lancent de VRAIS processus sous `sandbox-exec`. Sur une plateforme sans ce
 * mécanisme elles se sautent, et le dire est préférable à les faire passer sur une
 * simulation : une barrière simulée n'est pas une barrière.
 */

const onDarwin = process.platform === "darwin";

let root: string;
let workspace: string;
let elsewhere: string;
let secretFile: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "icos-sandbox-proof-"));
  workspace = join(root, "worktree");
  elsewhere = join(root, "autre-worktree");
  await mkdir(workspace, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  secretFile = join(root, "credential.txt");
  await writeFile(secretFile, "VALEUR-SECRETE-A-NE-PAS-LIRE");
  await writeFile(join(elsewhere, "autre.txt"), "travail d'un autre worker");
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** Un worker confiné à son worktree, sans réseau. La configuration par défaut. */
const confined = (args: string[], overrides: Record<string, unknown> = {}) =>
  runNonInteractive({
    command: "/bin/sh",
    args: ["-c", ...args],
    cwd: workspace,
    timeoutMs: 15_000,
    sandbox: { readWritePaths: [workspace], readOnlyPaths: [], allowNetwork: false },
    ...overrides,
  });

describe.skipIf(!onDarwin)("évasion du bac à sable — tentatives réelles", () => {
  it("ÉCRIT son propre worktree : la barrière n'empêche pas le travail", async () => {
    const result = await confined(["echo ok > fichier.txt && cat fichier.txt"]);
    expect(result.confinement).toBe("seatbelt");
    expect(result.stdout.trim()).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  it("NE PEUT PAS lire un identifiant par CHEMIN ABSOLU", async () => {
    const result = await confined([`cat ${secretFile}`]);
    expect(result.stdout).not.toContain("VALEUR-SECRETE");
    expect(result.exitCode).not.toBe(0);
  });

  it("NE PEUT PAS remonter avec `../` hors de son worktree", async () => {
    const result = await confined(["cat ../credential.txt"]);
    expect(result.stdout).not.toContain("VALEUR-SECRETE");
    expect(result.exitCode).not.toBe(0);
  });

  it("NE PEUT PAS suivre un LIEN SYMBOLIQUE qui pointe dehors", async () => {
    /*
     * L'évasion la plus intéressante : le lien est À L'INTÉRIEUR du worktree, donc un
     * contrôle de chemin applicatif le laisserait passer. Seatbelt évalue la cible RÉSOLUE,
     * et c'est précisément pourquoi un contrôle applicatif ne remplace pas un bac à sable.
     */
    await symlink(secretFile, join(workspace, "lien-vers-secret")).catch(() => undefined);
    const result = await confined(["cat lien-vers-secret"]);
    expect(result.stdout).not.toContain("VALEUR-SECRETE");
    expect(result.exitCode).not.toBe(0);
  });

  it("NE PEUT PAS lire le VRAI HOME du propriétaire", async () => {
    const result = await confined([`ls -a "${process.env.HOME ?? "/Users"}" 2>&1`]);
    expect(result.stdout).not.toMatch(/\.ssh|\.aws|\.codex|\.claude/);
  });

  it("NE PEUT PAS écrire dans le worktree d'un AUTRE worker", async () => {
    const result = await confined([`echo intrusion > ${join(elsewhere, "pirate.txt")}`]);
    expect(result.exitCode).not.toBe(0);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(elsewhere)).toEqual(["autre.txt"]);
  });

  it("N'A PAS DE RÉSEAU quand la politique le refuse, et l'OS l'applique", async () => {
    const result = await confined([
      "curl -s -m 5 -o /dev/null -w '%{http_code}' https://example.com || true",
    ]);
    /* 000 = aucune connexion. Un 200 ici voudrait dire que la politique est décorative. */
    expect(result.stdout.trim()).not.toBe("200");
    expect(result.networkEnforced).toBe(true);
  });

  it("un enfant du worker HÉRITE du bac à sable : pas d'élargissement par sous-processus", async () => {
    /*
     * C8 §5. Seatbelt s'applique à l'ARBRE de processus : un worker qui lance son propre
     * sous-processus ne peut pas lui donner plus que ce qu'il a. On le vérifie plutôt que
     * de le supposer, parce que c'est l'hypothèse sur laquelle repose « child <= parent ».
     */
    const result = await confined([`/bin/sh -c 'cat ${secretFile}'`]);
    expect(result.stdout).not.toContain("VALEUR-SECRETE");
  });

  it("NE PEUT PAS exfiltrer un secret d'environnement : il ne l'a jamais reçu", async () => {
    const result = await runNonInteractive({
      command: "/bin/sh",
      args: ["-c", "env"],
      cwd: workspace,
      timeoutMs: 15_000,
      sandbox: { readWritePaths: [workspace], readOnlyPaths: [], allowNetwork: false },
    });
    expect(result.stdout).not.toMatch(/DATABASE_URL|API_KEY|SECRET|PASSWORD/);
  });

  it("le HOME JETABLE est accessible, et le vrai reste invisible", async () => {
    const home = await createEphemeralHome();
    try {
      const result = await runNonInteractive({
        command: "/bin/sh",
        args: ["-c", 'echo jetable > "$HOME/marque" && cat "$HOME/marque" && ls -a "$HOME"'],
        cwd: workspace,
        env: { HOME: home.path },
        timeoutMs: 15_000,
        sandbox: {
          readWritePaths: [workspace, home.path],
          readOnlyPaths: [],
          allowNetwork: false,
        },
      });
      expect(result.stdout).toContain("jetable");
      /* Le HOME jetable ne contient QUE ce qu'on y a mis : aucun trousseau hérité. */
      expect(result.stdout).not.toMatch(/\.ssh|\.aws|\.codex|\.claude|\.netrc|\.npmrc/);
    } finally {
      await home.dispose();
    }
  });

  it("utilise bien `sandbox-exec`, et le résultat le DIT", async () => {
    expect(SANDBOX_EXEC).toBe("/usr/bin/sandbox-exec");
    const result = await confined(["true"]);
    expect(result.confinement).toBe("seatbelt");
  });
});

/**
 * L'ÉCRITURE GOUVERNÉE SOUS CONFINEMENT — ce que le writer peut, et tout ce qu'il ne peut pas.
 *
 * ── LE DÉFAUT QUE CES PREUVES FERMENT ───────────────────────────────────────────────────
 * La preuve « écrit son propre worktree » ci-dessus écrit un fichier dans un répertoire
 * ORDINAIRE, ce qui ne dit rien du travail pour lequel ce bac à sable existe : un COMMIT
 * sur la branche que l'IntegrationGate relira. Or un worktree git ne garde pas son index
 * chez lui — `<worktree>/.git` est un FICHIER qui pointe vers
 * `<canonique>/.git/worktrees/<id>` — donc index, HEAD et verrous du worker vivent DANS le
 * dépôt que la politique déclare en lecture seule.
 *
 * Mesuré sur HEAD : `git add` mourait sur « Unable to create
 * '<canonique>/.git/worktrees/<id>/index.lock': Operation not permitted ». Aucune écriture
 * gouvernée n'avait donc jamais abouti sous confinement, et comme le contrat de résultat ne
 * lit que stdout, la seule trace était « worker returned no structured status: no output » —
 * indistinguable d'un worker cassé.
 *
 * ── LA FORME RETENUE : WORKTREE DÉTACHÉ ─────────────────────────────────────────────────
 * Un HEAD ATTACHÉ ferait verrouiller `refs/heads/<branche>.lock`, créé dans le RÉPERTOIRE
 * `refs/heads/` du dépôt canonique ; accorder ce répertoire donnerait au worker le pouvoir
 * de déplacer N'IMPORTE QUELLE branche, la CIBLE comprise — l'exact contournement de la
 * revue. Détaché, il ne lui faut que son propre dossier d'administration et le dépôt
 * d'objets, et c'est ICOS — hors bac à sable, après vérification — qui nomme la branche.
 *
 * Le worker rend donc un SHA, jamais une mutation de référence.
 */
describe.skipIf(!onDarwin)("écriture gouvernée — le writer détaché commite, et rien de plus", () => {
  let canonical: string;
  let tree: string;
  let otherTree: string;
  let admin: string;
  let otherAdmin: string;
  let gitHome: string;
  let base: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();

  /**
   * EXACTEMENT ce que l'activité accorde : le worktree alloué, le dossier
   * d'administration de CE worktree, le dépôt d'objets partagé, le HOME jetable. Le dépôt
   * canonique reste en LECTURE. Les preuves négatives ci-dessous utilisent toutes cette
   * même politique : elles mesurent la politique de production, pas une plus étroite
   * écrite pour la circonstance.
   */
  const asWriter = (script: string) =>
    runNonInteractive({
      command: "/bin/sh",
      args: ["-c", script],
      cwd: tree,
      timeoutMs: 20_000,
      /* `TMPDIR` dans le HOME jetable : le vrai /var/folders n'est pas accordé. */
      env: { HOME: gitHome, TMPDIR: gitHome },
      sandbox: {
        readWritePaths: [tree, admin, join(canonical, ".git", "objects"), gitHome],
        readOnlyPaths: [canonical],
        allowNetwork: false,
      },
    });

  beforeAll(async () => {
    canonical = join(root, "canonique");
    tree = join(root, "writer-worktree");
    otherTree = join(root, "autre-writer-worktree");
    gitHome = join(root, "home-writer");
    await mkdir(canonical, { recursive: true });
    await mkdir(gitHome, { recursive: true });

    git(canonical, "init", "-q", "--initial-branch=main", ".");
    await writeFile(join(canonical, "base.txt"), "base\n");
    await mkdir(join(canonical, "src"), { recursive: true });
    await writeFile(join(canonical, "src", "permis.txt"), "dans la portée\n");
    git(canonical, "add", "-A");
    git(canonical, "-c", "user.email=i@i", "-c", "user.name=i", "commit", "-q", "-m", "base");
    base = git(canonical, "rev-parse", "HEAD");
    /* La branche d'intégration que la revue protège, et une branche de tâche déjà nommée. */
    git(canonical, "branch", "integration/cible");
    git(canonical, "branch", "icos-task-branche");
    /* Les deux worktrees sont DÉTACHÉS : c'est la forme que la production alloue. */
    git(canonical, "worktree", "add", "-q", "--detach", tree, base);
    git(canonical, "worktree", "add", "-q", "--detach", otherTree, base);
    admin = git(tree, "rev-parse", "--absolute-git-dir");
    otherAdmin = git(otherTree, "rev-parse", "--absolute-git-dir");
    /* Un hook, pour que « ne peut pas le modifier » porte sur un fichier qui existe. */
    await mkdir(join(canonical, ".git", "hooks"), { recursive: true });
    await writeFile(join(canonical, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
  });

  /* ── DETACHED_WORKTREE_COMMIT_PROVEN / WORKER_CAN_COMMIT ─────────────────────────────── */
  it("COMMITE sur un HEAD détaché : l'écriture gouvernée aboutit vraiment", async () => {
    const result = await asWriter(
      "echo travail > src/feature.txt && git add -A && " +
        "git -c user.email=w@w -c user.name=w commit -q -m 'travail gouverné' && " +
        "git rev-parse HEAD",
    );
    expect(result.confinement).toBe("seatbelt");
    expect(result.exitCode).toBe(0);

    /* L'évidence est git, jamais ce que le worker a dit. */
    const head = git(tree, "rev-parse", "HEAD");
    expect(result.stdout.trim()).toContain(head);
    expect(head).not.toBe(base);
    expect(git(tree, "show", "--name-only", "--format=", "HEAD")).toContain("src/feature.txt");
    /* Détaché : `--abbrev-ref` rend littéralement « HEAD » quand aucune branche ne le porte. */
    expect(git(tree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(canonical, "rev-parse", "icos-task-branche")).toBe(base);
    expect(git(canonical, "rev-parse", "integration/cible")).toBe(base);
  });

  /* ── WORKER_CANNOT_UPDATE_REFS ───────────────────────────────────────────────────────── */
  it("NE PEUT PAS écrire une référence, même la sienne", async () => {
    const before = git(canonical, "rev-parse", "icos-task-branche");
    const result = await asWriter(
      "git update-ref refs/heads/icos-task-branche $(git rev-parse HEAD) 2>&1; " +
        "echo CODE=$?",
    );
    expect(result.stdout).toContain("CODE=");
    expect(result.stdout).not.toContain("CODE=0");
    expect(git(canonical, "rev-parse", "icos-task-branche")).toBe(before);
  });

  /* ── WORKER_CANNOT_MOVE_BRANCH ───────────────────────────────────────────────────────── */
  it("NE PEUT PAS déplacer la branche d'INTÉGRATION : la revue n'est pas contournable", async () => {
    const before = git(canonical, "rev-parse", "integration/cible");
    const result = await asWriter(
      "git branch -f integration/cible $(git rev-parse HEAD) 2>&1; echo CODE=$?",
    );
    expect(result.stdout).not.toContain("CODE=0");
    expect(git(canonical, "rev-parse", "integration/cible")).toBe(before);
  });

  /* ── WORKER_CANNOT_WRITE_PACKED_REFS ─────────────────────────────────────────────────── */
  it("NE PEUT PAS écrire `packed-refs`", async () => {
    const result = await asWriter(
      `echo compromis > ${join(canonical, ".git", "packed-refs")} 2>&1; echo CODE=$?`,
    );
    expect(result.stdout).not.toContain("CODE=0");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(canonical, ".git"));
    if (entries.includes("packed-refs")) {
      const { readFile: rf } = await import("node:fs/promises");
      expect(await rf(join(canonical, ".git", "packed-refs"), "utf8")).not.toContain("compromis");
    }
  });

  /* ── WORKER_CANNOT_MODIFY_GIT_CONFIG ────────────────────────────────────────────────── */
  it("NE PEUT PAS modifier la configuration du dépôt canonique", async () => {
    const result = await asWriter(
      `echo '[core] hooksPath = /tmp/pirate' >> ${join(canonical, ".git", "config")} 2>&1; echo CODE=$?`,
    );
    expect(result.stdout).not.toContain("CODE=0");
    const { readFile: rf } = await import("node:fs/promises");
    expect(await rf(join(canonical, ".git", "config"), "utf8")).not.toContain("pirate");
  });

  /* ── WORKER_CANNOT_MODIFY_GIT_HOOKS ─────────────────────────────────────────────────── */
  it("NE PEUT PAS installer un hook : pas d'exécution de code dans le plan de contrôle", async () => {
    const hook = join(canonical, ".git", "hooks", "pre-commit");
    const result = await asWriter(`echo 'curl pirate' > ${hook} 2>&1; echo CODE=$?`);
    expect(result.stdout).not.toContain("CODE=0");
    const { readFile: rf } = await import("node:fs/promises");
    expect(await rf(hook, "utf8")).not.toContain("pirate");
  });

  /* ── WORKER_CANNOT_WRITE_OTHER_WORKTREE_GITDIR ──────────────────────────────────────── */
  it("NE PEUT PAS écrire le gitdir d'un AUTRE worker : l'accord porte sur LE SIEN", async () => {
    const victim = join(otherAdmin, "HEAD");
    const { readFile: rf } = await import("node:fs/promises");
    const before = await rf(victim, "utf8");
    const result = await asWriter(`echo ${base} > ${victim} 2>&1; echo CODE=$?`);
    expect(result.stdout).not.toContain("CODE=0");
    expect(await rf(victim, "utf8")).toBe(before);
    /* Et son arbre de travail non plus. */
    const intrusion = await asWriter(
      `echo intrusion > ${join(otherTree, "pirate.txt")} 2>&1; echo CODE=$?`,
    );
    expect(intrusion.stdout).not.toContain("CODE=0");
  });

  /* ── la barrière ne doit pas non plus laisser écrire l'arbre canonique ──────────────── */
  it("NE PEUT PAS écrire l'arbre de travail canonique", async () => {
    const result = await asWriter(
      `echo compromis > ${join(canonical, "base.txt")} 2>&1; echo CODE=$?`,
    );
    expect(result.stdout).not.toContain("CODE=0");
    const { readFile: rf } = await import("node:fs/promises");
    expect(await rf(join(canonical, "base.txt"), "utf8")).toBe("base\n");
  });
});

describe("décision de confinement — FERMÉE par défaut", () => {
  it("REFUSE de lancer quand le bac à sable est exigé mais indisponible", () => {
    /*
     * La propriété qui rend l'audit fiable. On ne peut pas retirer `sandbox-exec` de
     * l'hôte, donc la décision est extraite en fonction PURE et testée telle quelle —
     * plutôt que de prétendre l'avoir prouvée sur un cas qu'on ne peut pas produire.
     */
    expect(decideConfinement(true, false, "required")).toEqual({
      mechanism: "none",
      refuse: true,
    });
  });

  it("`best-effort` lance, mais ne prétend JAMAIS être confiné", () => {
    /* Le mode qui laisse un déploiement non-macOS tourner, sans mentir dans la trace. */
    expect(decideConfinement(true, false, "best-effort")).toEqual({
      mechanism: "none",
      refuse: false,
    });
  });

  it("sans bac à sable demandé, rien ne change pour les appelants existants", () => {
    expect(decideConfinement(false, false)).toEqual({ mechanism: "none", refuse: false });
    expect(decideConfinement(false, true)).toEqual({ mechanism: "none", refuse: false });
  });

  it("disponible et demandé : Seatbelt, et c'est le seul cas qui confine", () => {
    expect(decideConfinement(true, true)).toEqual({ mechanism: "seatbelt", refuse: false });
  });
});

describe("profil Seatbelt — la forme, sans lancer de processus", () => {
  it("refuse TOUT par défaut : c'est la première ligne qui compte", () => {
    const profile = seatbeltProfile({
      readWritePaths: ["/tmp/w"],
      readOnlyPaths: [],
      allowNetwork: false,
    });
    expect(profile).toMatch(/^\(version 1\)\n\(deny default\)/);
    expect(profile).not.toContain("network-outbound");
  });

  it("déclare les DEUX formes de /tmp : macOS résout vers /private/tmp", () => {
    const profile = seatbeltProfile({
      readWritePaths: ["/tmp/w"],
      readOnlyPaths: [],
      allowNetwork: false,
    });
    expect(profile).toContain('"/tmp/w"');
    expect(profile).toContain('"/private/tmp/w"');
  });

  it("échappe les guillemets d'un chemin : aucune injection dans la S-expression", () => {
    const profile = seatbeltProfile({
      readWritePaths: ['/tmp/a") (allow file-read* (subpath "/'],
      readOnlyPaths: [],
      allowNetwork: false,
    });
    /* La tentative d'injection apparaît ÉCHAPPÉE, jamais comme une directive. */
    expect(profile).toContain('\\"');
    expect(profile.match(/\(allow file-read\* file-write\*/g) ?? []).toHaveLength(1);
  });

  it("ne prétend PAS isoler le réseau dès qu'un endpoint est nécessaire", () => {
    /*
     * Seatbelt ne filtre pas par nom d'hôte. Une politique « NVIDIA seulement » est donc
     * déclarative, et `networkEnforced` le dit au lieu de laisser croire le contraire.
     */
    expect(
      networkEnforced({
        readWritePaths: [],
        readOnlyPaths: [],
        allowNetwork: true,
        allowedEndpoints: ["https://integrate.api.nvidia.com"],
      }),
    ).toBe(false);
    expect(networkEnforced({ readWritePaths: [], readOnlyPaths: [], allowNetwork: false })).toBe(
      true,
    );
  });
});

describe("courtier d'identifiants — portée, refus et audit", () => {
  const resolver = (id: string, value?: string) => () => (value === undefined ? undefined : value);

  it("n'accorde QUE la capacité demandée", () => {
    const outcome = brokerCredentials(
      [{ id: "nvidia", kind: "env", target: "NVIDIA_API_KEY" }],
      () => "cle-nvidia",
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.keys(outcome.env)).toEqual(["NVIDIA_API_KEY"]);
    expect(outcome.env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("une capacité INTROUVABLE est un refus, jamais un départ silencieux", () => {
    const outcome = brokerCredentials(
      [{ id: "openrouter", kind: "env", target: "OPENROUTER_API_KEY" }],
      resolver("openrouter", undefined),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "CREDENTIAL_UNAVAILABLE" });
    if (!outcome.ok) expect(outcome.missing).toEqual(["openrouter"]);
  });

  it("REFUSE une cible de fichier qui écrirait hors du HOME jetable", () => {
    for (const target of ["/Users/coco/.ssh/id_rsa", "../../.ssh/id_rsa", "~/.codex/auth.json"]) {
      const outcome = brokerCredentials([{ id: "x", kind: "file", target }], () => "v");
      expect(outcome, target).toMatchObject({
        ok: false,
        reason: "CREDENTIAL_TARGET_REJECTED",
      });
    }
  });

  it("l'AUDIT ne peut pas porter la valeur : c'est le type qui l'interdit", () => {
    const outcome = brokerCredentials(
      [{ id: "nvidia", kind: "env", target: "NVIDIA_API_KEY" }],
      () => "cle-tres-secrete",
      () => "2026-10-02T00:00:00.000Z",
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(JSON.stringify(outcome.grants)).not.toContain("cle-tres-secrete");
    expect(outcome.grants[0]).toEqual({
      capabilityId: "nvidia",
      kind: "env",
      target: "NVIDIA_API_KEY",
      grantedAt: "2026-10-02T00:00:00.000Z",
    });
  });

  it("`seedHome` refuse aussi, même si un appelant a déjà validé", async () => {
    const home = await createEphemeralHome();
    try {
      await expect(
        seedHome(home.path, [{ relativePath: "../evade", contents: "x" }]),
      ).rejects.toThrow(/CREDENTIAL_TARGET_REJECTED/);
    } finally {
      await home.dispose();
    }
  });
});

describe("isSafeHomeRelativePath", () => {
  it("accepte un chemin relatif ordinaire", () => {
    expect(isSafeHomeRelativePath(".codex/auth.json")).toBe(true);
    expect(isSafeHomeRelativePath(".config/hermes/config.yaml")).toBe(true);
  });

  it("refuse l'absolu, la remontée, le tilde, le vide et le NUL", () => {
    for (const bad of ["/etc/passwd", "../x", "a/../../b", "~", "~/x", "", "a\0b", "C:\\x"]) {
      expect(isSafeHomeRelativePath(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

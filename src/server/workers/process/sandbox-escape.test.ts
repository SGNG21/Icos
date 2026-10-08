import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { brokerCredentials, seedHome } from "./credential-broker";
import { createEphemeralHome, isSafeHomeRelativePath } from "./ephemeral-home";
import { decideConfinement, runNonInteractive, SANDBOX_EXEC } from "./run-process";
import { sandboxBackend } from "./sandbox-backend";
import { networkEnforced, seatbeltProfile } from "./sandbox-profile";

/**
 * TENTATIVES D'ÉVASION — le bac à sable est-il une barrière ou une convention ? (verrou C8)
 *
 * Chaque test ESSAIE de sortir, par un chemin par lequel un worker réel pourrait sortir :
 * remontée `../`, chemin absolu, lien symbolique, lecture du vrai HOME, exfiltration d'une
 * variable d'environnement, écriture dans un autre worktree. Un test qui se contente de
 * vérifier qu'un worker écrit bien SON répertoire ne prouve rien du tout.
 *
 * Ces preuves lancent de VRAIS processus sous le backend RÉELLEMENT disponible —
 * `sandbox-exec` sur macOS, `bwrap` sur Linux. Sur un hôte sans backend elles se sautent,
 * et le dire est préférable à les faire passer sur une simulation : une barrière simulée
 * n'est pas une barrière. (Le refus fermé sur un hôte SANS backend est prouvé, lui, par
 * `bubblewrap-sandbox.test.ts`.)
 */

/** Le backend de CET hôte, mesuré par une vraie sonde — pas déduit de `process.platform`. */
const backend = sandboxBackend().backend;

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

describe.skipIf(!backend)("évasion du bac à sable — tentatives réelles", () => {
  it("ÉCRIT son propre worktree : la barrière n'empêche pas le travail", async () => {
    const result = await confined(["echo ok > fichier.txt && cat fichier.txt"]);
    expect(result.confinement).toBe(backend!.mechanism);
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
     * contrôle de chemin applicatif le laisserait passer. Seatbelt évalue la cible RÉSOLUE ;
     * sous Bubblewrap la cible n'est pas montée, donc n'existe pas. C'est précisément pourquoi un contrôle applicatif ne remplace pas un bac à sable.
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
     * C8 §5. Le confinement (Seatbelt ou espaces de noms) s'applique à l'ARBRE de processus : un worker qui lance son propre
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

  it.skipIf(backend?.mechanism !== "seatbelt")(
    "utilise bien `sandbox-exec`, et le résultat le DIT",
    async () => {
      expect(SANDBOX_EXEC).toBe("/usr/bin/sandbox-exec");
      const result = await confined(["true"]);
      expect(result.confinement).toBe("seatbelt");
    },
  );
});

describe("décision de confinement — FERMÉE par défaut", () => {
  it("REFUSE de lancer quand le bac à sable est exigé mais indisponible", () => {
    /*
     * La propriété qui rend l'audit fiable. On ne peut pas retirer `sandbox-exec` de
     * l'hôte, donc la décision est extraite en fonction PURE et testée telle quelle —
     * plutôt que de prétendre l'avoir prouvée sur un cas qu'on ne peut pas produire.
     */
    expect(decideConfinement(true, null, "required")).toEqual({
      mechanism: "none",
      refuse: true,
    });
  });

  it("`best-effort` lance, mais ne prétend JAMAIS être confiné", () => {
    /* Le mode qui laisse un déploiement non-macOS tourner, sans mentir dans la trace. */
    expect(decideConfinement(true, null, "best-effort")).toEqual({
      mechanism: "none",
      refuse: false,
    });
  });

  it("sans bac à sable demandé, rien ne change pour les appelants existants", () => {
    expect(decideConfinement(false, null)).toEqual({ mechanism: "none", refuse: false });
    expect(decideConfinement(false, "seatbelt")).toEqual({ mechanism: "none", refuse: false });
    expect(decideConfinement(false, "bubblewrap")).toEqual({ mechanism: "none", refuse: false });
  });

  it("disponible et demandé : le mécanisme RÉEL est rapporté, et c'est le seul cas qui confine", () => {
    expect(decideConfinement(true, "seatbelt")).toEqual({ mechanism: "seatbelt", refuse: false });
    expect(decideConfinement(true, "bubblewrap")).toEqual({
      mechanism: "bubblewrap",
      refuse: false,
    });
    /* `best-effort` ne change rien quand un backend existe : on confine. */
    expect(decideConfinement(true, "bubblewrap", "best-effort")).toEqual({
      mechanism: "bubblewrap",
      refuse: false,
    });
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

  it("un chemin RO IMBRIQUÉ dans un chemin RW reste RO : refus d'écriture APRÈS l'autorisation", () => {
    /* ADR 0072, phase 0 : le pointeur `.git` d'un worktree, même sémantique que Bubblewrap. */
    const profile = seatbeltProfile({
      readWritePaths: ["/tmp/wt"],
      readOnlyPaths: ["/tmp/wt/.git", "/repo"],
      allowNetwork: false,
    });
    const allow = profile.indexOf("(allow file-read* file-write*");
    const deny = profile.indexOf("(deny file-write*");
    expect(allow).toBeGreaterThan(-1);
    /* Seatbelt applique la DERNIÈRE règle qui correspond : le refus doit suivre. */
    expect(deny).toBeGreaterThan(allow);
    const denyLine = profile.slice(deny).split("\n")[0]!;
    expect(denyLine).toContain('"/tmp/wt/.git"');
    expect(denyLine).toContain('"/private/tmp/wt/.git"');
    /* Un RO hors de tout RW n'a pas besoin de refus : il n'a jamais été autorisé en écriture. */
    expect(denyLine).not.toContain('"/repo"');
    /* La lecture reste accordée. */
    expect(profile).toMatch(/\(allow file-read\*[^\n]*"\/tmp\/wt\/\.git"/);
  });

  it("sans chemin RO imbriqué, aucun refus n'est ajouté", () => {
    const profile = seatbeltProfile({
      readWritePaths: ["/tmp/wt"],
      readOnlyPaths: ["/repo"],
      allowNetwork: false,
    });
    expect(profile).not.toContain("(deny file-write*");
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

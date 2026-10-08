import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bubblewrapArgs, type HostEntry, type HostView } from "./bubblewrap-args";
import { createEphemeralHome, type EphemeralHome } from "./ephemeral-home";
import { runNonInteractive, type NonInteractiveProcessSpec } from "./run-process";
import { BWRAP, detectSandboxBackend, SANDBOX_EXEC, sandboxBackend } from "./sandbox-backend";
import type { SandboxPolicy } from "./sandbox-profile";

/**
 * BACKEND LINUX — BUBBLEWRAP (verrou C8).
 *
 * Trois niveaux, et chacun dit ce qu'il prouve :
 *   1. la DÉTECTION, pure : quel backend pour quel hôte, et le refus quand il n'y en a pas.
 *      Tourne partout, parce que le fail-closed ne doit pas dépendre de l'OS du CI ;
 *   2. la FORME de l'argv `bwrap`, pure : ce qui est monté, dans quel ordre, avec quels
 *      droits. Nécessaire, pas suffisante — un argv correct sur le papier ne prouve pas que
 *      le noyau l'applique ;
 *   3. les PREUVES RÉELLES : de vrais processus sous `/usr/bin/bwrap`, qui ESSAIENT de
 *      sortir. Sautées proprement quand l'hôte n'a pas de Bubblewrap fonctionnel, et
 *      remplacées alors par la preuve RÉELLE du refus fermé.
 */

const detection = sandboxBackend();
const onBubblewrap = detection.backend?.mechanism === "bubblewrap";

/* ── 1. DÉTECTION ─────────────────────────────────────────────────────────────────── */

describe("détection du backend — une preuve, jamais une supposition", () => {
  const never = () => {
    throw new Error("la sonde ne doit pas être appelée ici");
  };

  it("Linux sans `bwrap` : AUCUN backend, et la raison nomme le paquet", () => {
    const d = detectSandboxBackend({
      platform: "linux",
      exists: () => false,
      probeBubblewrap: never,
    });
    expect(d.backend).toBeNull();
    expect(d.reason).toContain("bubblewrap");
  });

  it("Linux, `bwrap` présent mais la sonde échoue (AppArmor) : AUCUN backend", () => {
    /* Le cas mesuré sur Ubuntu 24.04 : binaire installé, user namespaces refusés. */
    const d = detectSandboxBackend({
      platform: "linux",
      exists: (p) => p === BWRAP,
      probeBubblewrap: () => ({ ok: false, detail: "setting up uid map: Permission denied" }),
    });
    expect(d.backend).toBeNull();
    expect(d.reason).toContain("uid map");
  });

  it("Linux, sonde réussie : Bubblewrap, à son chemin FIXE", () => {
    const d = detectSandboxBackend({
      platform: "linux",
      exists: (p) => p === BWRAP,
      probeBubblewrap: () => ({ ok: true }),
    });
    expect(d.backend).toEqual({ mechanism: "bubblewrap", executable: "/usr/bin/bwrap" });
  });

  it("macOS : Seatbelt si `sandbox-exec` existe, rien sinon — sans sonde Linux", () => {
    expect(
      detectSandboxBackend({ platform: "darwin", exists: () => true, probeBubblewrap: never })
        .backend,
    ).toEqual({ mechanism: "seatbelt", executable: SANDBOX_EXEC });
    expect(
      detectSandboxBackend({ platform: "darwin", exists: () => false, probeBubblewrap: never })
        .backend,
    ).toBeNull();
  });

  it("toute autre plateforme : AUCUN backend, aucun repli", () => {
    for (const platform of ["win32", "freebsd", "aix"] as const) {
      const d = detectSandboxBackend({ platform, exists: () => true, probeBubblewrap: never });
      expect(d.backend, platform).toBeNull();
    }
  });
});

/* ── 2. FORME DE L'ARGV ───────────────────────────────────────────────────────────── */

/** Un hôte fictif : chaque chemin listé existe, avec son type ; les liens sont résolus. */
function fakeHost(
  entries: Record<string, HostEntry>,
  links: Record<string, string> = {},
): HostView {
  return {
    describe: (path) => entries[path] ?? null,
    realpath: (path) => {
      if (links[path]) return links[path];
      return entries[path] ? path : null;
    },
  };
}

const SYSTEM: Record<string, HostEntry> = {
  "/usr": { kind: "directory" },
  "/etc": { kind: "directory" },
  "/bin": { kind: "symlink", target: "usr/bin" },
  "/lib": { kind: "symlink", target: "usr/lib" },
};

const policy = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  readWritePaths: [],
  readOnlyPaths: [],
  allowNetwork: false,
  ...over,
});

/** Les triplets de montage `[option, source, destination]`, dans l'ordre. */
function mounts(args: readonly string[]): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--bind" || a === "--ro-bind" || a === "--symlink") {
      out.push([a, args[i + 1]!, args[i + 2]!]);
      i += 2;
    }
  }
  return out;
}

describe("argv Bubblewrap — la forme, sans lancer de processus", () => {
  it("isole TOUT, sans capacité ni espace de noms imbriqué, et meurt avec son parent", () => {
    const args = bubblewrapArgs(policy(), fakeHost(SYSTEM));
    for (const flag of [
      "--unshare-all",
      "--unshare-user",
      "--disable-userns",
      "--die-with-parent",
    ]) {
      expect(args, flag).toContain(flag);
    }
    expect(args.join(" ")).toContain("--cap-drop ALL");
  });

  it("allowNetwork=false : AUCUN `--share-net` ; true : le réseau de l'hôte, entier", () => {
    expect(bubblewrapArgs(policy(), fakeHost(SYSTEM))).not.toContain("--share-net");
    expect(bubblewrapArgs(policy({ allowNetwork: true }), fakeHost(SYSTEM))).toContain(
      "--share-net",
    );
  });

  it("ne monte JAMAIS la racine, même si une politique la demande", () => {
    const host = fakeHost({ ...SYSTEM, "/": { kind: "directory" } });
    const args = bubblewrapArgs(policy({ readWritePaths: ["/"], readOnlyPaths: ["/"] }), host);
    expect(mounts(args).some(([, , dest]) => dest === "/")).toBe(false);
  });

  it("ne monte QUE l'hôte nommé : ni HOME, ni autre worktree, ni chemin inconnu", () => {
    const host = fakeHost({
      ...SYSTEM,
      "/srv/wt/task-1": { kind: "directory" },
      "/srv/wt/task-2": { kind: "directory" },
      "/home/owner": { kind: "directory" },
    });
    const args = bubblewrapArgs(policy({ readWritePaths: ["/srv/wt/task-1"] }), host);
    const destinations = mounts(args).map(([, , d]) => d);
    expect(destinations).toContain("/srv/wt/task-1");
    expect(destinations).not.toContain("/srv/wt/task-2");
    expect(destinations.some((d) => d.startsWith("/home"))).toBe(false);
  });

  it("lecture seule en `--ro-bind`, écriture en `--bind`", () => {
    const host = fakeHost({ ...SYSTEM, "/w": { kind: "directory" }, "/r/f": { kind: "file" } });
    const m = mounts(
      bubblewrapArgs(policy({ readWritePaths: ["/w"], readOnlyPaths: ["/r/f"] }), host),
    );
    expect(m).toContainEqual(["--bind", "/w", "/w"]);
    expect(m).toContainEqual(["--ro-bind", "/r/f", "/r/f"]);
  });

  it("l'imbriqué GAGNE sur son parent, dans les deux sens", () => {
    const host = fakeHost({
      ...SYSTEM,
      "/repo": { kind: "directory" },
      "/repo/wt": { kind: "directory" },
      "/w": { kind: "directory" },
      "/w/ro.txt": { kind: "file" },
    });
    const m = mounts(
      bubblewrapArgs(
        policy({ readWritePaths: ["/repo/wt", "/w"], readOnlyPaths: ["/repo", "/w/ro.txt"] }),
        host,
      ),
    );
    const at = (opt: string, dest: string) => m.findIndex(([o, , d]) => o === opt && d === dest);
    /* Worktree accordé en écriture SOUS une racine en lecture : monté après, donc modifiable. */
    expect(at("--bind", "/repo/wt")).toBeGreaterThan(at("--ro-bind", "/repo"));
    /* Fichier accordé en lecture SOUS un répertoire modifiable : monté après, donc protégé. */
    expect(at("--ro-bind", "/w/ro.txt")).toBeGreaterThan(at("--bind", "/w"));
  });

  it("au MÊME chemin, la lecture seule l'emporte : la contradiction se résout vers le strict", () => {
    const host = fakeHost({ ...SYSTEM, "/both": { kind: "directory" } });
    const m = mounts(
      bubblewrapArgs(policy({ readWritePaths: ["/both"], readOnlyPaths: ["/both"] }), host),
    );
    const last = m.filter(([, , d]) => d === "/both").at(-1);
    expect(last?.[0]).toBe("--ro-bind");
  });

  it("un chemin RELATIF ou INEXISTANT n'est pas accordé : refus, jamais élargissement", () => {
    const m = mounts(
      bubblewrapArgs(
        policy({ readWritePaths: ["relatif/x", "/n-existe-pas"], readOnlyPaths: ["."] }),
        fakeHost(SYSTEM),
      ),
    );
    expect(m.filter(([o]) => o === "--bind")).toEqual([]);
  });

  it("un lien est monté depuis sa CIBLE, aux deux noms", () => {
    const host = fakeHost(
      { ...SYSTEM, "/real/wt": { kind: "directory" } },
      { "/link/wt": "/real/wt" },
    );
    const m = mounts(bubblewrapArgs(policy({ readWritePaths: ["/link/wt"] }), host));
    expect(m).toContainEqual(["--bind", "/real/wt", "/real/wt"]);
    expect(m).toContainEqual(["--bind", "/real/wt", "/link/wt"]);
  });

  it("un lien SYSTÈME est recréé comme lien, pas monté", () => {
    const m = mounts(bubblewrapArgs(policy(), fakeHost(SYSTEM)));
    expect(m).toContainEqual(["--symlink", "usr/bin", "/bin"]);
    expect(m).toContainEqual(["--ro-bind", "/usr", "/usr"]);
  });

  it("garde le worker dans le groupe de processus : pas de `--new-session`", () => {
    /* Le runner tue l'ARBRE par le groupe ; `setsid` en ferait sortir le worker. */
    expect(bubblewrapArgs(policy(), fakeHost(SYSTEM))).not.toContain("--new-session");
  });
});

/* ── 3a. PREUVES RÉELLES SOUS BUBBLEWRAP ──────────────────────────────────────────── */

describe.skipIf(!onBubblewrap)("Bubblewrap — tentatives d'évasion RÉELLES", () => {
  let root: string;
  let ownerHome: string;
  let canonical: string;
  let worktree: string;
  let otherWorktree: string;
  let outside: string;
  let readOnlyFile: string;
  let scratch: string;
  let home: EphemeralHome;
  let server: Server;
  let port: number;

  const REAL_HOME = homedir();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "icos-bwrap-proof-"));
    /* Un HOME de propriétaire FICTIF, peuplé comme le vrai : la preuve ne dépend pas de lui. */
    ownerHome = join(root, "owner-home");
    for (const [dir, file] of [
      [".ssh", "id_ed25519"],
      [".aws", "credentials"],
      [".codex", "auth.json"],
      [".claude", "credentials.json"],
    ] as const) {
      await mkdir(join(ownerHome, dir), { recursive: true });
      await writeFile(join(ownerHome, dir, file), `SECRET-${dir}`);
    }
    canonical = join(root, "canonical");
    await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, "README.md"), "canonique");
    worktree = join(root, "worktrees", "task-1");
    otherWorktree = join(root, "worktrees", "task-2");
    await mkdir(worktree, { recursive: true });
    await mkdir(otherWorktree, { recursive: true });
    await writeFile(join(otherWorktree, "autre.txt"), "travail d'un autre worker");
    outside = join(root, "hors-politique");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "VALEUR-HORS-POLITIQUE");
    readOnlyFile = join(root, "contexte.txt");
    await writeFile(readOnlyFile, "contexte accordé");
    scratch = join(root, "scratch");
    await mkdir(scratch, { recursive: true });
    home = await createEphemeralHome();

    server = createServer((_req, res) => res.end("joint"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await home?.dispose();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  /** La politique d'un WRITER, telle que l'activité Temporal la compose. */
  const writerPolicy = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
    readWritePaths: [worktree, scratch, home.path],
    readOnlyPaths: [canonical, readOnlyFile],
    allowNetwork: false,
    ...over,
  });

  const sh = (script: string, over: Partial<NonInteractiveProcessSpec> = {}) =>
    runNonInteractive({
      command: "/bin/sh",
      args: ["-c", script],
      cwd: worktree,
      env: { HOME: home.path, OWNER_HOME: ownerHome, REAL_HOME },
      envPassthrough: [],
      timeoutMs: 15_000,
      sandbox: writerPolicy(),
      ...over,
    });

  it("le résultat DIT « bubblewrap », et le réseau refusé est appliqué par l'OS", async () => {
    const result = await sh("true");
    expect(result.exitCode).toBe(0);
    expect(result.confinement).toBe("bubblewrap");
    expect(result.networkEnforced).toBe(true);
  });

  it("le VRAI HOME n'existe pas dans le bac à sable", async () => {
    const result = await sh('test -e "$REAL_HOME" && echo VISIBLE || echo ABSENT');
    expect(result.stdout.trim()).toBe("ABSENT");
  });

  it("~/.ssh, ~/.aws, ~/.claude, ~/.codex : inaccessibles, réels comme fictifs", async () => {
    const result = await sh(
      'for h in "$REAL_HOME" "$OWNER_HOME"; do for d in .ssh .aws .claude .codex; do ' +
        'if test -e "$h/$d"; then echo "VISIBLE:$h/$d"; fi; ' +
        'cat "$h/$d"/* 2>/dev/null; done; done; echo fin',
    );
    expect(result.stdout).not.toContain("VISIBLE");
    expect(result.stdout).not.toContain("SECRET-");
    expect(result.stdout.trim()).toBe("fin");
  });

  it("le HOME ÉPHÉMÈRE est accessible en écriture, et ne contient que ce qu'on y met", async () => {
    const result = await sh('echo jetable > "$HOME/marque" && cat "$HOME/marque" && ls -A "$HOME"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("jetable");
    expect(result.stdout).not.toMatch(/\.ssh|\.aws|\.codex|\.claude/);
  });

  it("le worktree du WRITER est réellement modifiable, et l'hôte voit l'écriture", async () => {
    const result = await sh("echo travail > produit.txt");
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(worktree, "produit.txt"), "utf8")).toBe("travail\n");
  });

  it("un fichier accordé en LECTURE SEULE est lisible et non modifiable", async () => {
    const result = await sh(`cat "${readOnlyFile}"; echo ecrase > "${readOnlyFile}" && echo ECRIT`);
    expect(result.stdout).toContain("contexte accordé");
    expect(result.stdout).not.toContain("ECRIT");
    expect(await readFile(readOnlyFile, "utf8")).toBe("contexte accordé");
  });

  it("le dépôt CANONIQUE est lisible, jamais modifiable — ni écrit, ni effacé", async () => {
    const result = await sh(
      `cat "${canonical}/README.md"; ` +
        `echo pirate > "${canonical}/pirate.txt" && echo ECRIT; ` +
        `rm -f "${canonical}/README.md" && echo EFFACE; true`,
    );
    expect(result.stdout).toContain("canonique");
    expect(result.stdout).not.toContain("ECRIT");
    expect(result.stdout).not.toContain("EFFACE");
    expect(readdirSync(canonical)).toEqual(["README.md"]);
  });

  it("l'AUTRE worktree n'existe pas pour ce worker", async () => {
    const result = await sh(
      `test -e "${otherWorktree}" && echo VISIBLE; echo x > "${otherWorktree}/pirate.txt" && echo ECRIT; echo fin`,
    );
    expect(result.stdout).not.toContain("VISIBLE");
    expect(result.stdout).not.toContain("ECRIT");
    expect(readdirSync(otherWorktree)).toEqual(["autre.txt"]);
  });

  it("un chemin HORS POLITIQUE est inaccessible — absolu, `../` ou lien symbolique", async () => {
    await symlink(join(outside, "secret.txt"), join(worktree, "lien-vers-secret")).catch(
      () => undefined,
    );
    const result = await sh(
      `cat "${outside}/secret.txt"; cat ../../hors-politique/secret.txt; cat lien-vers-secret; echo fin`,
    );
    expect(result.stdout).not.toContain("VALEUR-HORS-POLITIQUE");
    expect(result.stdout.trim()).toBe("fin");
  });

  it("allowNetwork=false : même le 127.0.0.1 de l'hôte est injoignable", async () => {
    const result = await sh(
      `curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/ || true`,
    );
    expect(result.stdout.trim()).toBe("000");
    expect(result.networkEnforced).toBe(true);
  });

  it("allowNetwork=true : le réseau passe RÉELLEMENT, et l'audit ne prétend pas le filtrer", async () => {
    const result = await sh(
      `curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/ || true`,
      {
        sandbox: writerPolicy({
          allowNetwork: true,
          allowedEndpoints: ["https://integrate.api.nvidia.com"],
        }),
      },
    );
    expect(result.confinement).toBe("bubblewrap");
    expect(result.stdout.trim()).toBe("200");
    /* Un endpoint déclaré n'est pas un filtre : le résultat ne prétend rien. */
    expect(result.networkEnforced).toBe(false);
  });

  it("un PETIT-ENFANT reste dans le confinement : pas d'élargissement par sous-processus", async () => {
    const result = await sh(
      `/bin/sh -c '/bin/sh -c "cat \\"${outside}/secret.txt\\"; ` +
        `echo x > \\"${canonical}/pirate.txt\\" && echo ECRIT; ` +
        `test -e \\"$REAL_HOME\\" && echo VISIBLE; echo fin"'`,
    );
    expect(result.stdout).not.toContain("VALEUR-HORS-POLITIQUE");
    expect(result.stdout).not.toContain("ECRIT");
    expect(result.stdout).not.toContain("VISIBLE");
    expect(result.stdout.trim()).toBe("fin");
  });

  it("aucun espace de noms utilisateur IMBRIQUÉ : le worker ne peut pas redevenir root", async () => {
    const result = await sh("unshare -U -r true && echo IMBRIQUE || echo REFUSE");
    expect(result.stdout.trim()).toBe("REFUSE");
  });

  it("les processus de l'hôte sont invisibles : `/proc` est celui du bac à sable", async () => {
    const result = await sh("ls /proc | grep -E '^[0-9]+$' | wc -l");
    /* bwrap init, le shell, ls, grep, wc : une poignée, pas les centaines de l'hôte. */
    expect(Number(result.stdout.trim())).toBeLessThan(10);
  });

  it("aucun secret d'environnement du parent n'est hérité", async () => {
    process.env.ICOS_PROOF_FAKE_SECRET = "NE-DOIT-PAS-FUIR";
    try {
      const result = await sh("env", { envPassthrough: undefined });
      expect(result.stdout).not.toContain("NE-DOIT-PAS-FUIR");
      expect(result.stdout).not.toMatch(/DATABASE_URL|API_KEY|CALLBACK_SECRET/);
    } finally {
      delete process.env.ICOS_PROOF_FAKE_SECRET;
    }
  });

  it("le POINTEUR `.git` d'un vrai worktree : ni écrit, ni supprimé, ni renommé, ni remplacé", async () => {
    /*
     * ADR 0072, phase 0 : le vecteur était de remplacer ce fichier par un dossier dont la
     * config exécute une commande. Le pointeur est monté en LECTURE SEULE dans le worktree
     * modifiable, comme le compose l'activité Temporal.
     */
    const repo = join(root, "git-canonical");
    const tree = join(root, "git-trees", "wt");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd,
        encoding: "utf8",
      }).trim();
    await mkdir(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    await writeFile(join(repo, "README.md"), "canon\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "add", "-q", tree, "-b", "ws/wt", base);
    const pointer = join(tree, ".git");
    const before = await readFile(pointer, "utf8");

    const result = await sh(
      [
        'echo "gitdir: /tmp/evil" > .git && echo ECRIT',
        "rm -f .git && echo EFFACE",
        "mv .git .git.bak && echo RENOMME",
        "rm -rf .git; mkdir .git && echo REMPLACE",
        "git init -q . && echo REINIT",
        "echo travail > travail.txt && echo TRAVAIL_OK",
        "git add -A && git -c user.name=w -c user.email=w@w commit -qm w && echo COMMIT",
        "true",
      ].join("; "),
      {
        cwd: tree,
        sandbox: {
          readWritePaths: [tree, home.path],
          readOnlyPaths: [repo, pointer],
          allowNetwork: false,
        },
      },
    );
    expect(result.confinement).toBe("bubblewrap");
    for (const forbidden of ["ECRIT", "EFFACE", "RENOMME", "REMPLACE", "REINIT", "COMMIT"]) {
      expect(result.stdout, forbidden).not.toContain(forbidden);
    }
    /* La barrière n'empêche pas le travail. */
    expect(result.stdout).toContain("TRAVAIL_OK");
    expect(await readFile(pointer, "utf8")).toBe(before);
    /* Le dépôt canonique n'a rien reçu : ni commit, ni ref. */
    expect(git(repo, "rev-parse", "ws/wt")).toBe(base);
  });

  /** Processus de l'HÔTE dont la ligne de commande porte ce marqueur. */
  const hostProcessesWith = (marker: string): number[] =>
    readdirSync("/proc")
      .filter((p) => /^\d+$/.test(p))
      .filter((pid) => {
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
          return cmdline.includes(marker) && state !== "Z";
        } catch {
          return false;
        }
      })
      .map(Number);

  it("le DÉLAI tue l'arbre confiné entier, petit-enfant compris", async () => {
    const marker = "31.4159";
    const started = Date.now();
    const result = await sh(`sleep ${marker} & sleep ${marker}`, { timeoutMs: 800 });
    expect(result.timedOut).toBe(true);
    expect(result.confinement).toBe("bubblewrap");
    expect(Date.now() - started).toBeLessThan(10_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(hostProcessesWith(marker)).toEqual([]);
  });

  it("l'ANNULATION tue l'arbre confiné entier, petit-enfant compris", async () => {
    const marker = "27.1828";
    const controller = new AbortController();
    const run = sh(`sleep ${marker} & sleep ${marker}`, {
      timeoutMs: 60_000,
      abortSignal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(hostProcessesWith(marker).length).toBeGreaterThan(0);
    controller.abort();
    const result = await run;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(hostProcessesWith(marker)).toEqual([]);
  });
});

/* ── 3b. HÔTE SANS BACKEND : LE REFUS FERMÉ, RÉEL ─────────────────────────────────── */

describe.skipIf(detection.backend !== null)("hôte SANS backend — refus fermé, réel", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "icos-no-backend-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("`required` (défaut) : RIEN n'est lancé, et la raison est dite", async () => {
    const marker = join(dir, "ne-doit-pas-exister");
    const result = await runNonInteractive({
      command: "/bin/sh",
      args: ["-c", `touch "${marker}"`],
      cwd: dir,
      timeoutMs: 5_000,
      sandbox: { readWritePaths: [dir], readOnlyPaths: [], allowNetwork: false },
    });
    expect(result.exitCode).toBeNull();
    expect(result.confinement).toBe("none");
    expect(result.networkEnforced).toBe(false);
    expect(result.stderr).toContain("SANDBOX_UNAVAILABLE");
    expect(result.stderr).toContain(detection.reason!);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("`best-effort` lance, et rapporte HONNÊTEMENT « none »", async () => {
    const result = await runNonInteractive({
      command: "/bin/sh",
      args: ["-c", "echo lance"],
      cwd: dir,
      timeoutMs: 5_000,
      sandbox: { readWritePaths: [dir], readOnlyPaths: [], allowNetwork: false },
      confinement: "best-effort",
    });
    expect(result.stdout.trim()).toBe("lance");
    expect(result.confinement).toBe("none");
    expect(result.networkEnforced).toBe(false);
  });
});

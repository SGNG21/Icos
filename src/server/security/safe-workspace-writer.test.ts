import {
  mkdtemp,
  mkdir,
  rm,
  rename,
  symlink,
  link,
  writeFile,
  readFile,
  realpath,
  lstat,
  stat,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { safeWriteFileInsideWorkspace } from "./safe-workspace-writer";
import { WorkspaceBoundaryError } from "./workspace-boundary";

/**
 * NF-3 (Phase 2B) — Tests adversariaux symlink / TOCTOU.
 *
 * Modèle d'attaque : un processus local avec les permissions du workspace
 * tente de détourner une écriture hors du workspace via des symlinks, des
 * hardlinks, ou un swap pendant la fenêtre validation→écriture (simulé de
 * façon déterministe via les seams de test).
 */

const SECRET = "CONTENU-SENSIBLE-NE-DOIT-JAMAIS-SORTIR-DU-WORKSPACE";

let workspace: string; // racine canonique du workspace autorisé
let outside: string; // répertoire attaquant HORS workspace

async function expectBoundaryError(
  promise: Promise<unknown>,
  code: WorkspaceBoundaryError["code"],
): Promise<void> {
  try {
    await promise;
    expect.fail(`aurait dû refuser (WorkspaceBoundaryError ${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceBoundaryError);
    expect((error as WorkspaceBoundaryError).code).toBe(code);
  }
}

beforeEach(async () => {
  // realpath : os.tmpdir() est symlinké sur macOS (/var → /private/var).
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "nf3-")));
  workspace = path.join(base, "workspace");
  outside = path.join(base, "outside");
  await mkdir(workspace);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(path.dirname(workspace), { recursive: true, force: true });
});

describe("safeWriteFileInsideWorkspace — chemin nominal", () => {
  it("écrit le contenu et retourne le chemin absolu", async () => {
    const written = await safeWriteFileInsideWorkspace(workspace, "a/b/file.txt", SECRET);

    expect(written).toBe(path.join(workspace, "a/b/file.txt"));
    expect(await readFile(written, "utf-8")).toBe(SECRET);
  });

  it("crée les répertoires intermédiaires manquants (sans symlink)", async () => {
    await safeWriteFileInsideWorkspace(workspace, "x/y/z/deep.txt", "ok");

    const st = await lstat(path.join(workspace, "x/y/z"));
    expect(st.isDirectory()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
  });

  it("écrase (tronque) un fichier régulier existant", async () => {
    const target = path.join(workspace, "file.txt");
    await writeFile(target, "ANCIEN-CONTENU-PLUS-LONG-QUE-LE-NOUVEAU");

    await safeWriteFileInsideWorkspace(workspace, "file.txt", "court");
    expect(await readFile(target, "utf-8")).toBe("court");
  });
});

describe("safeWriteFileInsideWorkspace — validation lexicale et racine", () => {
  it("refuse la traversée ..", async () => {
    await expectBoundaryError(
      safeWriteFileInsideWorkspace(workspace, "../outside/evil.txt", SECRET),
      "path_outside_workspace",
    );
  });

  it("refuse un chemin absolu", async () => {
    await expectBoundaryError(
      safeWriteFileInsideWorkspace(workspace, path.join(outside, "evil.txt"), SECRET),
      "path_outside_workspace",
    );
  });

  it("refuse une racine de workspace non canonique (racine atteinte via symlink)", async () => {
    const linkToWorkspace = path.join(path.dirname(workspace), "ws-link");
    await symlink(workspace, linkToWorkspace);

    await expectBoundaryError(
      safeWriteFileInsideWorkspace(linkToWorkspace, "file.txt", SECRET),
      "non_canonical_workspace_root",
    );
  });

  it("refuse une racine inexistante", async () => {
    await expectBoundaryError(
      safeWriteFileInsideWorkspace(path.join(workspace, "nope"), "file.txt", SECRET),
      "unresolvable_worktree_path",
    );
  });
});

describe("safeWriteFileInsideWorkspace — attaques symlink (pré-positionnées)", () => {
  it("refuse un composant FINAL symlink vers un fichier hors workspace (O_NOFOLLOW)", async () => {
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "INTACT");
    await symlink(victim, path.join(workspace, "file.txt"));

    await expectBoundaryError(
      safeWriteFileInsideWorkspace(workspace, "file.txt", SECRET),
      "symlink_component",
    );
    // Le fichier hors workspace n'a PAS été touché.
    expect(await readFile(victim, "utf-8")).toBe("INTACT");
  });

  it("refuse un répertoire INTERMÉDIAIRE symlink vers l'extérieur", async () => {
    await symlink(outside, path.join(workspace, "sub"));

    await expectBoundaryError(
      safeWriteFileInsideWorkspace(workspace, "sub/evil.txt", SECRET),
      "symlink_component",
    );
    // Rien n'a été créé dans le répertoire attaquant.
    await expect(stat(path.join(outside, "evil.txt"))).rejects.toThrow();
  });

  it("refuse un alias hardlink vers un fichier hors workspace (nlink != 1)", async () => {
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "INTACT");
    await link(victim, path.join(workspace, "file.txt"));

    await expectBoundaryError(
      safeWriteFileInsideWorkspace(workspace, "file.txt", SECRET),
      "unsafe_write_target",
    );
    expect(await readFile(victim, "utf-8")).toBe("INTACT");
  });

  it("refuse une cible qui est un répertoire", async () => {
    await mkdir(path.join(workspace, "adir"));

    await expectBoundaryError(
      safeWriteFileInsideWorkspace(workspace, "adir", SECRET),
      "unsafe_write_target",
    );
  });
});

describe("safeWriteFileInsideWorkspace — courses TOCTOU (seams déterministes)", () => {
  it("COURSE 1 : swap du parent en symlink APRÈS validation, AVANT open → refus, zéro octet de contenu hors workspace", async () => {
    await mkdir(path.join(workspace, "sub"));

    await expectBoundaryError(
      safeWriteFileInsideWorkspace(workspace, "sub/file.txt", SECRET, {
        beforeOpen: async () => {
          // L'attaquant remplace le répertoire validé par un symlink.
          await rm(path.join(workspace, "sub"), { recursive: true });
          await symlink(outside, path.join(workspace, "sub"));
        },
      }),
      "race_detected",
    );

    // O_CREAT a pu créer un fichier VIDE hors workspace (limite documentée),
    // mais AUCUN octet du contenu n'a été écrit.
    const leaked = await readFile(path.join(outside, "file.txt"), "utf-8").catch(() => null);
    expect(leaked === null || leaked === "").toBe(true);
    expect(leaked).not.toContain(SECRET);
  });

  it("COURSE 2 : la cible est remplacée par un symlink APRÈS open → refus (dev/ino divergents)", async () => {
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "INTACT");

    await expectBoundaryError(
      safeWriteFileInsideWorkspace(workspace, "file.txt", SECRET, {
        afterOpen: async () => {
          await rm(path.join(workspace, "file.txt"));
          await symlink(victim, path.join(workspace, "file.txt"));
        },
      }),
      "race_detected",
    );
    expect(await readFile(victim, "utf-8")).toBe("INTACT");
  });

  it("COURSE 3 : un autre fichier est renommé sur la cible APRÈS open → refus (inode divergent)", async () => {
    const decoy = path.join(workspace, "decoy.txt");
    await writeFile(decoy, "DECOY");

    await expectBoundaryError(
      safeWriteFileInsideWorkspace(workspace, "file.txt", SECRET, {
        afterOpen: async () => {
          await rename(decoy, path.join(workspace, "file.txt"));
        },
      }),
      "race_detected",
    );
    // Le fichier swappé n'a pas reçu le contenu.
    expect(await readFile(path.join(workspace, "file.txt"), "utf-8")).toBe("DECOY");
  });

  it("COURSE 4 : swap du parent APRÈS open → refus (realpath du parent divergent)", async () => {
    await mkdir(path.join(workspace, "sub"));

    await expectBoundaryError(
      safeWriteFileInsideWorkspace(workspace, "sub/file.txt", SECRET, {
        afterOpen: async () => {
          // Le fichier ouvert reste le bon inode, mais le parent est
          // déplacé et remplacé par un symlink vers l'extérieur : le
          // chemin ne désigne plus un emplacement du workspace.
          await rename(path.join(workspace, "sub"), path.join(outside, "moved-sub"));
          await symlink(outside, path.join(workspace, "sub"));
        },
      }),
      "race_detected",
    );
  });
});

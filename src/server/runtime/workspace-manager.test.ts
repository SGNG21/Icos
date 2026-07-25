import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceManager, WorkspaceError } from "./workspace-manager";

describe("D4 — WorkspaceManager", () => {
  let manager: WorkspaceManager;
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp("/tmp/d4-workspace-test-");
    manager = new WorkspaceManager(testRoot);
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true }).catch(() => {});
  });

  // ─────────────────────────────────────
  // Workspace Creation
  // ─────────────────────────────────────

  describe("creation", () => {
    it("crée un workspace isolé", async () => {
      const ws = await manager.createWorkspace("tenant-1", "run-abc");
      expect(ws).toContain("tenant-1");
      expect(ws).toContain("run-abc");

      // Le répertoire doit exister
      await expect(readFile(ws, "utf-8").catch((e) => e.code))
        .resolves.not.toBe("ENOENT");
    });

    it("crée les répertoires parent si nécessaire", async () => {
      const ws = await manager.createWorkspace("deep", "nested");
      const exists = await import("node:fs").then((fs) =>
        fs.promises.stat(ws).then(() => true).catch(() => false),
      );
      expect(exists).toBe(true);
    });

    it("sanitize les noms de tenant", async () => {
      const ws = await manager.createWorkspace("../evil", "run-1");
      // Le nom doit être nettoyé — ne pas créer hors du root
      expect(ws).not.toContain("..");
      expect(ws).toContain(testRoot);
    });
  });

  // ─────────────────────────────────────
  // Path Traversal Protection (SEC-D4-03)
  // ─────────────────────────────────────

  describe("SEC-D4-03: path traversal protection", () => {
    it("refuse un chemin avec ../ sortant du workspace", async () => {
      const ws = await manager.createWorkspace("tenant-1", "run-1");

      await expect(
        manager.validatePathInWorkspace(ws, "../../../etc/passwd"),
      ).rejects.toThrow(WorkspaceError);
    });

    it("refuse un chemin absolu hors du workspace", async () => {
      const ws = await manager.createWorkspace("tenant-1", "run-1");

      await expect(
        manager.validatePathInWorkspace(ws, "/etc/passwd"),
      ).rejects.toThrow(WorkspaceError);
    });

    it("accepte un chemin relatif dans le workspace", async () => {
      const ws = await manager.createWorkspace("tenant-1", "run-1");

      // Devrait créer un fichier dans le workspace
      const validated = await manager.validatePathInWorkspace(ws, "output/log.txt");
      expect(validated).toContain(ws);
      expect(validated.endsWith("output/log.txt")).toBe(true);
    });

    it("accepte un chemin absolu dans le workspace", async () => {
      const ws = await manager.createWorkspace("tenant-1", "run-1");
      const target = path.join(ws, "output/log.txt");

      const validated = await manager.validatePathInWorkspace(ws, target);
      expect(validated).toBe(target);
    });

    it("refuse une traversée avec ../ dans un chemin valide", async () => {
      const ws = await manager.createWorkspace("tenant-1", "run-1");

      await expect(
        manager.validatePathInWorkspace(ws, "output/../../etc/passwd"),
      ).rejects.toThrow(WorkspaceError);
    });
  });

  // ─────────────────────────────────────
  // Symlink Escape Protection (SEC-D4-04)
  // ─────────────────────────────────────

  describe("SEC-D4-04: symlink escape protection", () => {
    it("refuse un symlink pointant hors du workspace", async () => {
      const ws = await manager.createWorkspace("tenant-1", "run-1");
      const outsideTarget = path.join(testRoot, "outside.txt");
      const symlinkPath = path.join(ws, "escape.lnk");

      await writeFile(outsideTarget, "sensitive data");
      await symlink(outsideTarget, symlinkPath);

      await expect(
        manager.validatePathInWorkspace(ws, symlinkPath),
      ).rejects.toThrow(WorkspaceError);
    });

    it("accepte un symlink pointant dans le workspace", async () => {
      const ws = await manager.createWorkspace("tenant-1", "run-1");
      const insideTarget = path.join(ws, "real-file.txt");
      const symlinkPath = path.join(ws, "link.txt");

      await writeFile(insideTarget, "data");
      await symlink(insideTarget, symlinkPath);

      // Ne devrait pas throw
      const validated = await manager.validatePathInWorkspace(ws, symlinkPath);
      expect(validated).toBe(symlinkPath);
    });

    it("refuse un symlink dans un sous-répertoire vers l'extérieur", async () => {
      const ws = await manager.createWorkspace("tenant-1", "run-1");
      const subDir = path.join(ws, "subdir");
      await mkdir(subDir, { recursive: true });

      const outsideTarget = path.join(testRoot, "secret.txt");
      const symlinkPath = path.join(subDir, "escape.lnk");

      await writeFile(outsideTarget, "secret");
      await symlink(outsideTarget, symlinkPath);

      await expect(
        manager.validatePathInWorkspace(ws, "subdir/escape.lnk"),
      ).rejects.toThrow(WorkspaceError);
    });
  });

  // ─────────────────────────────────────
  // Workspace Cleanup Safety (SEC-D4-09)
  // ─────────────────────────────────────

  describe("SEC-D4-09: cleanup safety", () => {
    it("nettoie un workspace existant", async () => {
      const ws = await manager.createWorkspace("tenant-1", "run-1");
      // Le workspace existe
      await expect(
        import("node:fs").then((fs) => fs.promises.stat(ws)).then(() => true),
      ).resolves.toBe(true);

      await manager.releaseWorkspace(ws);

      // Le workspace n'existe plus
      const exists = await import("node:fs").then((fs) =>
        fs.promises.stat(ws).then(() => true).catch(() => false),
      );
      expect(exists).toBe(false);
    });

    it("refuse de nettoyer un chemin hors du root", async () => {
      await expect(
        manager.releaseWorkspace("/tmp/../etc"),
      ).rejects.toThrow(WorkspaceError);
    });

    it("refuse de nettoyer le root lui-même", async () => {
      await expect(
        manager.releaseWorkspace(testRoot),
      ).rejects.toThrow(WorkspaceError);
    });

    it("nettoie un sous-espace sans affecter les autres", async () => {
      const ws1 = await manager.createWorkspace("tenant-1", "run-1");
      const ws2 = await manager.createWorkspace("tenant-1", "run-2");

      await manager.releaseWorkspace(ws1);

      // ws1 n'existe plus
      const ws1Exists = await import("node:fs").then((fs) =>
        fs.promises.stat(ws1).then(() => true).catch(() => false),
      );
      expect(ws1Exists).toBe(false);

      // ws2 existe toujours
      const ws2Exists = await import("node:fs").then((fs) =>
        fs.promises.stat(ws2).then(() => true).catch(() => false),
      );
      expect(ws2Exists).toBe(true);
    });

    it("nettoie sans erreur un workspace déjà supprimé", async () => {
      const ws = await manager.createWorkspace("tenant-1", "run-1");
      await rm(ws, { recursive: true, force: true });

      // release ne doit pas throw si le workspace a déjà été nettoyé
      await expect(
        manager.releaseWorkspace(ws),
      ).resolves.toBeUndefined();
    });
  });

  // ─────────────────────────────────────
  // Cross-Tenant / Cross-Run Isolation
  // ─────────────────────────────────────

  describe("tenant and run isolation", () => {
    it("produit des chemins différents pour différents tenants", async () => {
      const ws1 = await manager.createWorkspace("tenant-a", "run-1");
      const ws2 = await manager.createWorkspace("tenant-b", "run-1");

      expect(ws1).not.toBe(ws2);
      expect(ws1).toContain("tenant-a");
      expect(ws2).toContain("tenant-b");
    });

    it("produit des chemins différents pour différents runs", async () => {
      const ws1 = await manager.createWorkspace("tenant-1", "run-a");
      const ws2 = await manager.createWorkspace("tenant-1", "run-b");

      expect(ws1).not.toBe(ws2);
      expect(ws1).toContain("run-a");
      expect(ws2).toContain("run-b");
    });
  });
});

import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git } from "./git";
import { InMemoryWorkspaceRegistry } from "./registry";
import { WorkspaceManager, type RequestWorkspaceInput } from "./manager";
import { FakeProvisioner, makeRepoFixture, type RepoFixture } from "./test-fixtures";

let fx: RepoFixture;
let db: FakeProvisioner;
let clock: number;
let manager: WorkspaceManager;

beforeEach(() => {
  fx = makeRepoFixture();
  db = new FakeProvisioner();
  clock = Date.parse("2026-09-19T10:00:00Z");
  manager = new WorkspaceManager({
    git: new Git(fx.master),
    registry: new InMemoryWorkspaceRegistry(),
    provisioner: db,
    worktreeRoot: fx.root,
    masterRepo: fx.master,
    now: () => new Date(clock),
  });
});
afterEach(() => fx.cleanup());

const input = (slug: string, over: Partial<RequestWorkspaceInput> = {}): RequestWorkspaceInput => ({
  slug,
  workerId: `worker-${slug}`,
  manual: true,
  integrationTarget: "integration/phase-7",
  fileScope: { owns: [`src/${slug}/**`], shared: [], forbidden: [] },
  ...over,
});

describe("request", () => {
  it("enregistre un workspace traçable avec branche, chemin, DB et base dérivés", async () => {
    const w = await manager.request(input("7a", { missionId: "m1", taskId: "t1" }));
    expect(w).toMatchObject({
      status: "requested",
      branch: "ws/7a",
      worktreePath: path.join(fx.root, "7a"),
      testDatabase: "icos_test_7a",
      missionId: "m1",
      taskId: "t1",
      workerId: "worker-7a",
      integrationTarget: "integration/phase-7",
      baseCommit: fx.git(fx.master, "rev-parse", "integration/phase-7"),
    });
    expect(w.createdAt).toBe("2026-09-19T10:00:00.000Z");
  });

  it("refuse une collision de chemin (workspace actif, ou dossier existant)", async () => {
    await manager.request(input("7a"));
    await expect(
      manager.request(input("x", { worktreePath: path.join(fx.root, "7a") })),
    ).rejects.toThrow(/COLLISION.*chemin/);
    fx.write(path.join(fx.root, "taken"), "f", "x");
    await expect(manager.request(input("taken"))).rejects.toThrow(/COLLISION.*chemin/);
  });

  it("refuse un chemin hors racine ou dans le dépôt maître", async () => {
    await expect(
      manager.request(input("x", { worktreePath: path.join(fx.master, "x") })),
    ).rejects.toThrow(/PATH_FORBIDDEN/);
    await expect(manager.request(input("y", { worktreePath: "/tmp/y" }))).rejects.toThrow(
      /PATH_FORBIDDEN/,
    );
  });

  it("refuse une collision de branche (registre ou git)", async () => {
    await manager.request(input("7a"));
    await expect(manager.request(input("7b", { branch: "ws/7a" }))).rejects.toThrow(
      /COLLISION.*branche/,
    );
    fx.git(fx.master, "branch", "ws/existing");
    await expect(manager.request(input("existing"))).rejects.toThrow(/COLLISION.*branche/);
  });

  it("refuse les branches protégées et une cible autre que integration/*", async () => {
    await expect(manager.request(input("x", { branch: "main" }))).rejects.toThrow(
      /BRANCH_FORBIDDEN/,
    );
    await expect(manager.request(input("x", { integrationTarget: "main" }))).rejects.toThrow(
      /TARGET_FORBIDDEN/,
    );
  });

  it("refuse une DB live/probe/prod et impose une DB de test unique par workspace", async () => {
    for (const slug of ["probe", "live-x", "prod"]) {
      await expect(manager.request(input(slug))).rejects.toThrow(/DATABASE_FORBIDDEN/);
    }
    await manager.request(input("a-b"));
    await expect(manager.request(input("a_b"))).rejects.toThrow(/COLLISION.*base/);
  });

  it("refuse deux workspaces actifs qui possèdent les mêmes fichiers", async () => {
    await manager.request(
      input("7a", { fileScope: { owns: ["src/memory/**"], shared: [], forbidden: [] } }),
    );
    await expect(
      manager.request(input("7b", { fileScope: { owns: ["src/**"], shared: [], forbidden: [] } })),
    ).rejects.toThrow(/OWNERSHIP_CONFLICT/);
  });

  it("réserve des numéros de migration distincts, au-delà de la base et des autres réservations", async () => {
    const a = await manager.request(input("7a", { migrations: 1 }));
    const b = await manager.request(input("7b", { migrations: 2 }));
    expect(a.migrationReservation).toEqual({ from: 2, to: 2, namespace: "ws_7a" });
    expect(b.migrationReservation).toEqual({ from: 3, to: 4, namespace: "ws_7b" });
    expect((await manager.request(input("7c"))).migrationReservation).toBeNull();
  });
});

describe("create", () => {
  it("crée le worktree sur la branche dédiée à la base enregistrée, et la DB de test", async () => {
    const { workspaceId } = await manager.request(input("7a"));
    const w = await manager.create(workspaceId);
    expect(w.status).toBe("ready");
    expect(existsSync(path.join(fx.root, "7a", "src/a.ts"))).toBe(true);
    expect(fx.git(path.join(fx.root, "7a"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("ws/7a");
    expect(fx.git(path.join(fx.root, "7a"), "rev-parse", "HEAD")).toBe(w.baseCommit);
    expect(db.databases.has("icos_test_7a")).toBe(true);
    await expect(manager.create(workspaceId)).rejects.toThrow(/TRANSITION_FORBIDDEN/);
  });

  it("ne réutilise pas un worktree git actif : collision détectée côté git", async () => {
    fx.git(
      fx.master,
      "worktree",
      "add",
      path.join(fx.root, "7a"),
      "-b",
      "other",
      "integration/phase-7",
    );
    await expect(manager.request(input("7a"))).rejects.toThrow(/COLLISION.*chemin/);
  });

  it("passe en blocked et libère la DB si git échoue", async () => {
    const { workspaceId } = await manager.request(input("7a"));
    fx.git(fx.master, "branch", "ws/7a"); // la branche apparaît entre request et create
    await expect(manager.create(workspaceId)).rejects.toThrow(/GIT_FAILED/);
    expect((await manager.get(workspaceId)).status).toBe("blocked");
    expect(db.databases.size).toBe(0);
  });
});

describe("transitions et leases", () => {
  it("refuse une transition hors machine à états", async () => {
    const { workspaceId } = await manager.request(input("7a"));
    await expect(manager.transition(workspaceId, "accepted", "me")).rejects.toThrow(
      /TRANSITION_FORBIDDEN/,
    );
  });

  it("un seul détenteur de lease actif ; reprise après expiration", async () => {
    const { workspaceId } = await manager.request(input("7a"));
    const first = await manager.acquireLease(workspaceId, "agent-1", 60_000);
    await expect(manager.acquireLease(workspaceId, "agent-2", 60_000)).rejects.toThrow(
      /LEASE_HELD/,
    );
    await manager.renewLease(workspaceId, "agent-1", first.fencingToken, 60_000);
    await expect(
      manager.transition(workspaceId, "creating", "agent-2", first.fencingToken),
    ).rejects.toThrow(/LEASE_NOT_OWNER/);
    clock += 61_000;
    const w = await manager.acquireLease(workspaceId, "agent-2", 60_000);
    expect(w.leaseOwner).toBe("agent-2");
    expect(w.leaseExpiresAt).toBe("2026-09-19T10:02:01.000Z");
  });
});

describe("cleanup", () => {
  async function ready(slug = "7a") {
    const { workspaceId } = await manager.request(input(slug));
    await manager.create(workspaceId);
    return workspaceId;
  }
  const finish = async (id: string, status: "accepted" | "abandoned") => {
    if (status === "abandoned") return manager.transition(id, "abandoned", "me");
    for (const s of [
      "working",
      "validating",
      "ready_for_integration",
      "integrating",
      "accepted",
    ] as const) {
      await manager.transition(id, s, "me");
    }
  };

  it("refuse tant que le workspace n'est pas terminal", async () => {
    const id = await ready();
    await expect(manager.cleanup(id)).rejects.toThrow(/CLEANUP_REFUSED/);
  });

  it("refuse (et ne supprime rien) s'il reste des changements non commités", async () => {
    const id = await ready();
    await finish(id, "abandoned");
    fx.write(path.join(fx.root, "7a"), "src/wip.ts", "wip\n");
    await expect(manager.cleanup(id)).rejects.toThrow(/UNCOMMITTED_CHANGES/);
    expect(existsSync(path.join(fx.root, "7a", "src/wip.ts"))).toBe(true);
    expect(db.databases.has("icos_test_7a")).toBe(true);
    expect((await manager.get(id)).releasedAt).toBeNull();
  });

  it("refuse aussi pour un fichier suivi modifié", async () => {
    const id = await ready();
    await finish(id, "abandoned");
    fx.write(path.join(fx.root, "7a"), "src/a.ts", "changed\n");
    await expect(manager.cleanup(id)).rejects.toThrow(/UNCOMMITTED_CHANGES/);
  });

  it("supprime worktree, branche fusionnée, DB, archive, et libère les ressources", async () => {
    const { workspaceId } = await manager.request(input("7a", { migrations: 1 }));
    await manager.create(workspaceId);
    await finish(workspaceId, "accepted");
    const r = await manager.cleanup(workspaceId);
    expect(r).toMatchObject({ worktreeRemoved: true, branchDeleted: true, databaseDropped: true });
    expect(existsSync(path.join(fx.root, "7a"))).toBe(false);
    expect(await new Git(fx.master).branchExists("ws/7a")).toBe(false);
    expect(db.databases.size).toBe(0);
    expect(existsSync(path.join(fx.root, ".archive", `${workspaceId}.json`))).toBe(true);
    const w = await manager.get(workspaceId);
    expect(w).toMatchObject({ leaseOwner: null, leaseExpiresAt: null });
    expect(w.releasedAt).not.toBeNull();
    // ressources réutilisables : slug, branche, DB et numéro de migration
    const again = await manager.request(input("7a", { migrations: 1 }));
    expect(again.migrationReservation?.from).toBe(2);
  });

  it("conserve la branche si elle porte des commits non fusionnés (jamais de -D)", async () => {
    const id = await ready();
    fx.write(path.join(fx.root, "7a"), "src/7a/x.ts", "x\n");
    fx.commit(path.join(fx.root, "7a"), "work");
    await finish(id, "abandoned");
    const r = await manager.cleanup(id);
    expect(r).toMatchObject({ worktreeRemoved: true, branchDeleted: false, databaseDropped: true });
    expect(await new Git(fx.master).branchExists("ws/7a")).toBe(true);
  });
});

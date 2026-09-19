import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileWorkspaceRegistry,
  InMemoryWorkspaceRegistry,
  type WorkspaceRegistry,
} from "./registry";
import type { Workspace } from "./types";

const ws = (id: string): Workspace => ({ workspaceId: id }) as Workspace;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fileRegistry() {
  const dir = await mkdtemp(path.join(tmpdir(), "wm-reg-"));
  dirs.push(dir);
  return { dir, registry: new FileWorkspaceRegistry(path.join(dir, "workspaces.json")) };
}

describe.each([
  ["memory", async () => new InMemoryWorkspaceRegistry() as WorkspaceRegistry],
  ["file", async () => (await fileRegistry()).registry as WorkspaceRegistry],
])("registry %s", (_name, make) => {
  it("persiste une transaction réussie", async () => {
    const r = await make();
    await r.transaction((s) => void s.workspaces.push(ws("a")));
    expect((await r.read()).map((w) => w.workspaceId)).toEqual(["a"]);
  });

  it("annule une transaction qui échoue", async () => {
    const r = await make();
    await expect(
      r.transaction((s) => {
        s.workspaces.push(ws("a"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await r.read()).toEqual([]);
  });

  it("sérialise les transactions concurrentes (aucune écriture perdue)", async () => {
    const r = await make();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        r.transaction((s) => void s.workspaces.push(ws(`w${i}`))),
      ),
    );
    expect(await r.read()).toHaveLength(20);
  });
});

describe("FileWorkspaceRegistry", () => {
  it("relit l'état depuis le fichier (durable entre processus)", async () => {
    const { dir, registry } = await fileRegistry();
    await registry.transaction((s) => void s.workspaces.push(ws("a")));
    const other = new FileWorkspaceRegistry(path.join(dir, "workspaces.json"));
    expect((await other.read()).map((w) => w.workspaceId)).toEqual(["a"]);
  });

  it("récupère un verrou périmé mais refuse un verrou frais", async () => {
    const { dir } = await fileRegistry();
    const file = path.join(dir, "workspaces.json");
    await writeFile(`${file}.lock`, "999999");
    const fresh = new FileWorkspaceRegistry(file, { lockTimeoutMs: 100, staleLockMs: 60_000 });
    await expect(fresh.read().then(() => fresh.transaction(() => undefined))).rejects.toThrow(
      /REGISTRY_LOCKED/,
    );
    const stale = new FileWorkspaceRegistry(file, { lockTimeoutMs: 100, staleLockMs: 0 });
    await stale.transaction((s) => void s.workspaces.push(ws("b")));
    expect(JSON.parse(await readFile(file, "utf8")).workspaces).toHaveLength(1);
  });
});

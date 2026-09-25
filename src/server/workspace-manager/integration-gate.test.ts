import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git } from "./git";
import { IntegrationGate, type GateOptions } from "./integration-gate";
import { WorkspaceManager, type RequestWorkspaceInput } from "./manager";
import { InMemoryWorkspaceRegistry } from "./registry";
import { formatReport } from "./report";
import { FakeProvisioner, FakeRunner, makeRepoFixture, type RepoFixture } from "./test-fixtures";

let fx: RepoFixture;
let db: FakeProvisioner;
let runner: FakeRunner;
let manager: WorkspaceManager;
let gate: IntegrationGate;

// Fixtures de secrets et de motifs interdits construits à l'exécution : le dépôt ne les contient pas en clair.
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const SKIP_CALL = ["it", ".sk", "ip('x', () => {})"].join("");

beforeEach(() => {
  fx = makeRepoFixture();
  db = new FakeProvisioner();
  runner = new FakeRunner();
  const git = new Git(fx.master);
  manager = new WorkspaceManager({
    git,
    registry: new InMemoryWorkspaceRegistry(),
    provisioner: db,
    worktreeRoot: fx.root,
    masterRepo: fx.master,
  });
  gate = new IntegrationGate({ git, manager, runner, database: db });
});
afterEach(() => fx.cleanup());

const LEASE = { owner: "gate-owner", fencingToken: 1 };
const APPROVED: GateOptions = {
  review: { verdict: "APPROVED", reviewer: "reviewer-1" },
  lease: LEASE,
};

async function prepare(
  slug: string,
  files: Record<string, string>,
  over: Partial<RequestWorkspaceInput> = {},
): Promise<string> {
  const { workspaceId } = await manager.request({
    slug,
    workerId: `worker-${slug}`,
    manual: true,
    fileScope: { owns: [`src/${slug}/**`], shared: [], forbidden: [] },
    ...over,
  });
  await manager.create(workspaceId);
  await manager.acquireLease(workspaceId, LEASE.owner, 60_000);
  await manager.transition(workspaceId, "working", LEASE.owner, LEASE.fencingToken);
  const dir = path.join(fx.root, slug);
  for (const [file, content] of Object.entries(files)) fx.write(dir, file, content);
  fx.commit(dir, `work ${slug}`);
  await manager.transition(workspaceId, "validating", LEASE.owner, LEASE.fencingToken);
  await manager.transition(workspaceId, "ready_for_integration", LEASE.owner, LEASE.fencingToken);
  return workspaceId;
}

const commands = () => runner.calls.map((c) => c.command);

describe("ACCEPT", () => {
  it("accepte quand toutes les gates passent, dans l'ordre, sur la DB dédiée", async () => {
    const id = await prepare("7a", { "src/7a/x.ts": "export const x = 1;\n" });
    const report = await gate.integrate(id, APPROVED);

    expect(report.decision).toBe("ACCEPT");
    expect(report).toMatchObject({
      typecheck: "PASS",
      lint: "PASS",
      unitTests: "PASS",
      postgresTests: "PASS",
      build: "PASS",
      secretCheck: "PASS",
      fileScopeStatus: "PASS",
      conflictStatus: "CLEAN",
    });
    expect(commands().filter((c) => !c.includes("install"))).toEqual([
      "pnpm run typecheck",
      "pnpm run lint",
      "pnpm test",
      "pnpm run test:db:setup",
      "pnpm run test:integration",
      "pnpm build",
    ]);
    expect(db.resets).toEqual(["icos_test_7a"]);
    const pg = runner.calls.find((c) => c.command.includes("test:integration"))!;
    expect(pg.env.ICOS_TEST_DATABASE_URL).toMatch(/\/icos_test_7a$/);
    expect(pg.env.DATABASE_URL).toBeUndefined();
    expect(pg.cwd).toBe(path.join(fx.root, "7a"));

    const ws = await manager.get(id);
    expect(ws.status).toBe("accepted");
    expect(ws.sourceCommit).toBe(report.commitSha);
    expect(report.commitSha).toBe(fx.git(path.join(fx.root, "7a"), "rev-parse", "HEAD"));
  });

  it("ne merge rien : la cible d'intégration et main restent inchangées", async () => {
    const before = fx.git(fx.master, "rev-parse", "integration/phase-7", "main");
    await gate.integrate(await prepare("7a", { "src/7a/x.ts": "x\n" }), APPROVED);
    expect(fx.git(fx.master, "rev-parse", "integration/phase-7", "main")).toBe(before);
  });
});

describe("REJECT", () => {
  it("si le typecheck échoue (les étapes suivantes sont sautées)", async () => {
    runner.failing = ["typecheck"];
    const id = await prepare("7a", { "src/7a/x.ts": "x\n" });
    const report = await gate.integrate(id, APPROVED);
    expect(report).toMatchObject({
      decision: "REJECT",
      typecheck: "FAIL",
      lint: "SKIPPED",
      build: "SKIPPED",
    });
    expect(commands().some((c) => c.includes("build"))).toBe(false);
    expect((await manager.get(id)).status).toBe("rejected");
  });

  it("si un test unitaire échoue", async () => {
    runner.failing = ["pnpm test"];
    const report = await gate.integrate(await prepare("7a", { "src/7a/x.ts": "x\n" }), APPROVED);
    expect(report).toMatchObject({
      decision: "REJECT",
      typecheck: "PASS",
      lint: "PASS",
      unitTests: "FAIL",
      build: "SKIPPED",
    });
  });

  it("si un test PostgreSQL échoue", async () => {
    runner.failing = ["test:integration"];
    const report = await gate.integrate(await prepare("7a", { "src/7a/x.ts": "x\n" }), APPROVED);
    expect(report).toMatchObject({ decision: "REJECT", postgresTests: "FAIL", build: "SKIPPED" });
  });

  it("si un secret est trouvé, sans jamais l'écrire dans le rapport", async () => {
    const id = await prepare("7a", { "src/7a/x.ts": `export const k = "${AWS_KEY}";\n` });
    const report = await gate.integrate(id, APPROVED);
    expect(report).toMatchObject({ decision: "REJECT", secretCheck: "FAIL", typecheck: "SKIPPED" });
    expect(commands()).toEqual([]);
    expect(formatReport(report)).not.toContain(AWS_KEY);
    expect(formatReport(report)).toMatch(/SECRET_CHECK=FAIL/);
  });

  it("si un fichier interdit est modifié (gate arrêtée avant toute commande)", async () => {
    const id = await prepare(
      "7a",
      { "src/frozen/x.ts": "x\n" },
      {
        fileScope: { owns: ["src/**"], shared: [], forbidden: ["src/frozen/**"] },
      },
    );
    const report = await gate.integrate(id, APPROVED);
    expect(report).toMatchObject({
      decision: "REJECT",
      fileScopeStatus: "FORBIDDEN",
      secretCheck: "SKIPPED",
    });
    expect(report.reasons.join(" ")).toMatch(/interdits.*src\/frozen\/x\.ts/);
    expect(commands()).toEqual([]);
  });

  it("si un fichier secret est ajouté (.env.local, interdit de base)", async () => {
    const id = await prepare(
      "7a",
      { ".env.local": "A=b\n" },
      { fileScope: { owns: ["**"], shared: [], forbidden: [] } },
    );
    const report = await gate.integrate(id, APPROVED);
    expect(report).toMatchObject({ decision: "REJECT", fileScopeStatus: "FORBIDDEN" });
  });

  it("si un fichier est hors du périmètre déclaré", async () => {
    const report = await gate.integrate(await prepare("7a", { "src/other/x.ts": "x\n" }), APPROVED);
    expect(report).toMatchObject({ decision: "REJECT", fileScopeStatus: "OUT_OF_SCOPE" });
  });

  it("si une migration existante est modifiée", async () => {
    const id = await prepare(
      "7a",
      { "drizzle/0001_more.sql": "alter table b add column c int;\n" },
      {
        fileScope: { owns: ["drizzle/**"], shared: [], forbidden: [] },
      },
    );
    const report = await gate.integrate(id, APPROVED);
    expect(report.decision).toBe("REJECT");
    expect(report.reasons.join(" ")).toMatch(/migration existante/);
  });

  it("si une migration n'a pas été réservée", async () => {
    const id = await prepare(
      "7a",
      { "drizzle/0002_ws_7a_x.sql": "create table c (id int);\n" },
      {
        fileScope: { owns: ["drizzle/**"], shared: [], forbidden: [] },
      },
    );
    const report = await gate.integrate(id, APPROVED);
    expect(report.decision).toBe("REJECT");
    expect(report.reasons.join(" ")).toMatch(/non réservée/);
  });

  it("si la revue demande des changements", async () => {
    const id = await prepare("7a", { "src/7a/x.ts": "x\n" });
    const report = await gate.integrate(id, {
      review: { verdict: "CHANGES_REQUESTED", reviewer: "r" },
      lease: LEASE,
    });
    expect(report.decision).toBe("REJECT");
  });
});

describe("NEEDS_REBASE", () => {
  it("si la cible a avancé depuis la base (base trop ancienne)", async () => {
    const id = await prepare("7a", { "src/7a/x.ts": "x\n" });
    fx.git(fx.master, "checkout", "-q", "integration/phase-7");
    fx.write(fx.master, "src/other.ts", "o\n");
    const target = fx.commit(fx.master, "target moves");
    fx.git(fx.master, "checkout", "-q", "main");
    const report = await gate.integrate(id, APPROVED);
    expect(report).toMatchObject({
      decision: "NEEDS_REBASE",
      conflictStatus: "BEHIND",
      targetCommit: target,
    });
    expect((await manager.get(id)).status).toBe("working");
  });

  it("liste les fichiers en conflit avec la cible sans rien résoudre", async () => {
    const id = await prepare(
      "7a",
      { "src/a.ts": "worker\n" },
      { fileScope: { owns: ["src/**"], shared: [], forbidden: [] } },
    );
    fx.git(fx.master, "checkout", "-q", "integration/phase-7");
    fx.write(fx.master, "src/a.ts", "target\n");
    fx.commit(fx.master, "conflicting");
    fx.git(fx.master, "checkout", "-q", "main");
    const report = await gate.integrate(id, APPROVED);
    expect(report).toMatchObject({ decision: "NEEDS_REBASE", conflictStatus: "CONFLICT" });
    expect(report.conflictFiles).toEqual(["src/a.ts"]);
    expect(fx.git(path.join(fx.root, "7a"), "status", "--porcelain")).toBe("");
  });

  it("si la cible a pris le même numéro de migration (renumérotation nécessaire)", async () => {
    const id = await prepare(
      "7a",
      { "drizzle/0002_ws_7a_x.sql": "create table c (id int);\n" },
      {
        migrations: 1,
        fileScope: { owns: ["src/7a/**"], shared: [], forbidden: [] },
      },
    );
    fx.git(fx.master, "checkout", "-q", "integration/phase-7");
    fx.write(fx.master, "drizzle/0002_other.sql", "create table d (id int);\n");
    fx.commit(fx.master, "other worker merged 0002");
    fx.git(fx.master, "checkout", "-q", "main");
    const report = await gate.integrate(id, APPROVED);
    expect(report.decision).toBe("NEEDS_REBASE");
    expect(report.migrations).toEqual(["drizzle/0002_ws_7a_x.sql"]);
    expect(report.reasons.join(" ")).toMatch(/0002/);
  });
});

describe("NEEDS_HUMAN_APPROVAL", () => {
  it("liste un fichier shared modifié ; un seul worker : accepté", async () => {
    const id = await prepare(
      "7a",
      { "src/shared.ts": "s\n" },
      {
        fileScope: { owns: ["src/7a/**"], shared: ["src/shared.ts"], forbidden: [] },
      },
    );
    const report = await gate.integrate(id, APPROVED);
    expect(report.sharedFilesChanged).toEqual(["src/shared.ts"]);
    expect(report).toMatchObject({ fileScopeStatus: "SHARED_CHANGED", decision: "ACCEPT" });
  });

  it("fichier shared modifié par plusieurs workers : validation humaine", async () => {
    const shared = { owns: ["src/7a/**"], shared: ["src/shared.ts"], forbidden: [] };
    await prepare(
      "7b",
      { "src/shared.ts": "from b\n" },
      { fileScope: { ...shared, owns: ["src/7b/**"] } },
    );
    const id = await prepare("7a", { "src/shared.ts": "from a\n" }, { fileScope: shared });
    const report = await gate.integrate(id, APPROVED);
    expect(report.decision).toBe("NEEDS_HUMAN_APPROVAL");
    expect(report.conflictStatus).toBe("MULTI_WORKER");
    expect(report.reasons.join(" ")).toMatch(/plusieurs workers.*src\/shared\.ts/);
  });

  it("sans revue, ou auto-revue par le worker", async () => {
    const id = await prepare("7a", { "src/7a/x.ts": "x\n" });
    expect((await gate.integrate(id, { lease: LEASE })).decision).toBe("NEEDS_HUMAN_APPROVAL");
    expect((await manager.get(id)).status).toBe("integrating");
    const self = await gate.integrate(id, {
      review: { verdict: "APPROVED", reviewer: "worker-7a" },
      lease: LEASE,
    });
    expect(self.decision).toBe("NEEDS_HUMAN_APPROVAL");
  });

  it("approbation humaine explicite (différente du worker) -> ACCEPT ; sinon refusée", async () => {
    const id = await prepare("7a", { "src/7a/x.ts": "x\n" });
    await gate.integrate(id, { lease: LEASE });
    await expect(
      gate.integrate(id, { humanApprovedBy: "worker-7a", lease: LEASE }),
    ).rejects.toThrow(/APPROVAL_INVALID/);
    expect((await gate.integrate(id, { humanApprovedBy: "owner", lease: LEASE })).decision).toBe(
      "ACCEPT",
    );
  });

  it("affaiblissement de test ou fichier de gouvernance touché", async () => {
    const weak = await prepare("7a", { "src/7a/x.test.ts": `${SKIP_CALL}\n` });
    const r1 = await gate.integrate(weak, APPROVED);
    expect(r1.decision).toBe("NEEDS_HUMAN_APPROVAL");
    expect(r1.reasons.join(" ")).toMatch(/security/i);

    const gov = await prepare(
      "7b",
      { ".claude/rules/x.md": "rule\n" },
      {
        fileScope: { owns: [".claude/rules/**"], shared: [], forbidden: [] },
      },
    );
    expect((await gate.integrate(gov, APPROVED)).decision).toBe("NEEDS_HUMAN_APPROVAL");
  });

  it("migration destructive (non additive)", async () => {
    const id = await prepare(
      "7a",
      { "drizzle/0002_ws_7a_x.sql": "drop table b;\n" },
      {
        migrations: 1,
        fileScope: { owns: ["src/7a/**"], shared: [], forbidden: [] },
      },
    );
    const report = await gate.integrate(id, APPROVED);
    expect(report.decision).toBe("NEEDS_HUMAN_APPROVAL");
    expect(report.reasons.join(" ")).toMatch(/non additive/);
  });
});

describe("préconditions", () => {
  it("refuse de démarrer après perte de lease", async () => {
    const id = await prepare("7a", { "src/7a/x.ts": "x\n" });
    await manager.releaseLease(id, LEASE.owner, LEASE.fencingToken);

    await expect(gate.integrate(id, APPROVED)).rejects.toThrow(/LEASE_NOT_OWNER|LEASE_EXPIRED/);
    expect(commands()).toEqual([]);
  });

  it("refuse d'évaluer un worktree avec des changements non commités", async () => {
    const id = await prepare("7a", { "src/7a/x.ts": "x\n" });
    fx.write(path.join(fx.root, "7a"), "src/7a/dirty.ts", "d\n");
    await expect(gate.integrate(id, APPROVED)).rejects.toThrow(/GATE_PRECONDITION/);
    expect(commands()).toEqual([]);
  });

  it("refuse un workspace qui n'est pas prêt pour l'intégration", async () => {
    const { workspaceId } = await manager.request({
      slug: "7a",
      workerId: "w",
      manual: true,
      fileScope: { owns: ["src/**"], shared: [], forbidden: [] },
    });
    await expect(gate.integrate(workspaceId, APPROVED)).rejects.toThrow(/GATE_PRECONDITION/);
  });

  it("refuse un diff vide", async () => {
    const { workspaceId } = await manager.request({
      slug: "7a",
      workerId: "w",
      manual: true,
      fileScope: { owns: ["src/**"], shared: [], forbidden: [] },
    });
    await manager.create(workspaceId);
    await manager.acquireLease(workspaceId, LEASE.owner, 60_000);
    for (const s of ["working", "validating", "ready_for_integration"] as const)
      await manager.transition(workspaceId, s, LEASE.owner, LEASE.fencingToken);
    const report = await gate.integrate(workspaceId, APPROVED);
    expect(report.decision).toBe("REJECT");
    expect(report.reasons.join(" ")).toMatch(/diff vide/);
  });
});

describe("rapport", () => {
  it("expose le format structuré attendu", async () => {
    const id = await prepare("7a", { "src/7a/x.ts": "x\n" });
    const text = formatReport(await gate.integrate(id, APPROVED));
    const keys = text.split("\n").map((l) => l.split("=")[0]);
    expect(keys.slice(0, 19)).toEqual([
      "WORKSPACE_ID",
      "WORKER_ID",
      "BRANCH",
      "WORKTREE",
      "BASE_COMMIT",
      "TARGET_COMMIT",
      "TEST_DATABASE",
      "FILE_SCOPE_STATUS",
      "SHARED_FILES_CHANGED",
      "MIGRATIONS",
      "TYPECHECK",
      "LINT",
      "UNIT_TESTS",
      "POSTGRES_TESTS",
      "BUILD",
      "SECRET_CHECK",
      "CONFLICT_STATUS",
      "INTEGRATION_DECISION",
      "COMMIT_SHA",
    ]);
    expect(text).toContain("INTEGRATION_DECISION=ACCEPT");
    expect(text).toContain("SHARED_FILES_CHANGED=NONE");
  });
});

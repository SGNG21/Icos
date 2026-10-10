import { readFile } from "node:fs/promises";

import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
} from "@/server/database/test-database-guard";

import { WorkspaceManager, type RequestWorkspaceInput } from "./manager";
import { PostgresWorkspaceRegistry } from "./postgres-workspace-registry";
import type { TestDatabaseProvisioner } from "./test-database";
import type { Git } from "./git";

const DATABASE_URL = TEST_DATABASE_URL;
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

assertSafeTestDatabaseUrl(DATABASE_URL);

const sql = postgres(DATABASE_URL, { max: 8, onnotice: () => {} });

const git = {
  commitExists: async () => true,
  resolveCommit: async (ref: string) => `commit-${ref}`,
  worktrees: async () => [],
  branchExists: async () => false,
} as unknown as Git;

const provisioner = {
  create: async () => {},
  drop: async () => {},
} satisfies TestDatabaseProvisioner;

function input(
  slug: string,
  workflowId: string,
  identity: { missionId?: string; taskId?: string } = {},
): RequestWorkspaceInput {
  return {
    slug,
    workerId: `worker-${slug}`,
    missionId: identity.missionId ?? "mission-fencing",
    taskId: identity.taskId ?? `task-${slug}`,
    workflowId,
    integrationTarget: "integration/phase-7",
    worktreePath: `/tmp/icos-worktrees/${slug}`,
    fileScope: { owns: [`src/${slug}/**`], shared: [], forbidden: [] },
  };
}

async function manager(
  now: () => Date = () => new Date(),
): Promise<{ manager: WorkspaceManager; registry: PostgresWorkspaceRegistry }> {
  const registry = new PostgresWorkspaceRegistry(DATABASE_URL);
  await registry.initialize();
  return {
    registry,
    manager: new WorkspaceManager({
      git,
      registry,
      provisioner,
      worktreeRoot: "/tmp/icos-worktrees",
      masterRepo: "/tmp/icos-master",
      now,
    }),
  };
}

async function applyWorkspaceMigration(): Promise<void> {
  const migration = await readFile("drizzle/0036_workspace_fencing.sql", "utf8");
  await sql.unsafe(migration);
}

async function createLegacyTable(): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE icos_workspace_registry (
      workspace_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      mission_id TEXT,
      task_id TEXT,
      slug TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      integration_target TEXT NOT NULL,
      file_scope_owns TEXT[] NOT NULL DEFAULT '{}',
      file_scope_shared TEXT[] NOT NULL DEFAULT '{}',
      file_scope_forbidden TEXT[] NOT NULL DEFAULT '{}',
      migration_from INTEGER,
      migration_to INTEGER,
      migration_namespace TEXT,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      released_at TIMESTAMPTZ,
      source_commit TEXT,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

describe("PostgreSQL workspace fencing proofs", () => {
  beforeEach(async () => {
    await sql`DROP TABLE IF EXISTS icos_workspace_registry`;
  });

  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS icos_workspace_registry`;
    await sql.end();
  });

  it("applies the workspace migration on a fresh disposable database", async () => {
    await applyWorkspaceMigration();
    const table = await sql`
      SELECT to_regclass('public.icos_workspace_registry')::text AS name
    `;
    expect(table[0]?.name).toBe("icos_workspace_registry");
  });

  it("upgrades the legacy runtime-created table and installs the partial unique index", async () => {
    await createLegacyTable();
    const { registry } = await manager();

    const columns = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'icos_workspace_registry'
        AND column_name IN ('fencing_token', 'workflow_id')
      ORDER BY column_name
    `;
    expect(columns.map((row) => row.column_name)).toEqual(["fencing_token", "workflow_id"]);

    const indexes = await sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'icos_workspace_registry'
        AND indexname = 'uq_icos_workspace_registry_active_workflow'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toMatch(
      /UNIQUE.*\(workflow_id\).*WHERE.*workflow_id IS NOT NULL.*released_at IS NULL/i,
    );
    await registry.close();
  });

  it("CARRIES THE CANONICAL REPOSITORY THROUGH PERSISTENCE: a restart reads the binding", async () => {
    /*
     * The binding only works if it OUTLIVES the process that made it. A fresh registry over
     * the same database is what a restart looks like, and the capture must find the same
     * repository there — never the ambient one, which a new process may read differently.
     */
    const { manager: wm, registry } = await manager();
    const requested = await wm.request({
      slug: "repo_binding",
      workerId: "worker-rb",
      manual: true,
      integrationTarget: "integration/phase-7",
      fileScope: { owns: ["src/repo_binding/**"], shared: [], forbidden: [] },
    });
    expect(requested.canonicalRepo).not.toBeNull();

    const reloaded = new PostgresWorkspaceRegistry(DATABASE_URL);
    await reloaded.initialize();
    try {
      const rows = await reloaded.read();
      const row = rows.find((w) => w.workspaceId === requested.workspaceId);
      expect(row?.canonicalRepo).toBe(requested.canonicalRepo);
    } finally {
      await reloaded.close();
      await registry.close();
    }
  });

  it("allows only one concurrent lease contender", async () => {
    const { manager: first, registry: registryA } = await manager();
    const { manager: second, registry: registryB } = await manager();
    const workspace = await first.request(input("contenders", "workflow-contenders"));

    const results = await Promise.allSettled([
      first.acquireLease(workspace.workspaceId, OWNER_A, 60_000),
      second.acquireLease(workspace.workspaceId, OWNER_B, 60_000),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect([OWNER_A, OWNER_B]).toContain((await first.get(workspace.workspaceId)).leaseOwner);
    await Promise.all([registryA.close(), registryB.close()]);
  });

  it("rejects a stale fence after expiry and reacquisition with a stronger fence", async () => {
    let clock = Date.parse("2026-09-24T08:00:00Z");
    const { manager: workspaceManager, registry } = await manager(() => new Date(clock));
    const workspace = await workspaceManager.request(input("stale", "workflow-stale"));
    const first = await workspaceManager.acquireLease(workspace.workspaceId, OWNER_A, 1_000);

    clock += 1_001;
    const second = await workspaceManager.acquireLease(workspace.workspaceId, OWNER_B, 60_000);
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    await expect(
      workspaceManager.transition(workspace.workspaceId, "creating", OWNER_A, first.fencingToken),
    ).rejects.toThrow(/LEASE_NOT_OWNER|STALE_FENCE|LEASE_HELD/);
    await registry.close();
  });

  it("safely reattaches the same canonical workflow without creating a duplicate", async () => {
    const { manager: first, registry: registryA } = await manager();
    const identity = { missionId: "mission-reattach", taskId: "task-reattach" };
    const created = await first.request(input("reattach-a", "workflow-reattach", identity));
    const { manager: restarted, registry: registryB } = await manager();

    const reattached = await restarted.request(input("reattach-b", "workflow-reattach", identity));
    expect(reattached.workspaceId).toBe(created.workspaceId);
    expect((await restarted.list()).filter((workspace) => !workspace.releasedAt)).toHaveLength(1);
    await Promise.all([registryA.close(), registryB.close()]);
  });

  it("rejects a different-workflow collision on the same task", async () => {
    const { manager: workspaceManager, registry } = await manager();
    const identity = { missionId: "mission-collision", taskId: "task-collision" };
    await workspaceManager.request(input("collision-a", "workflow-a", identity));
    await expect(
      workspaceManager.request(input("collision-b", "workflow-b", identity)),
    ).rejects.toThrow(/WORKFLOW_COLLISION/);
    await registry.close();
  });

  it("prevents recovery from stealing a newer lease", async () => {
    let clock = Date.parse("2026-09-24T09:00:00Z");
    const { manager: workspaceManager, registry } = await manager(() => new Date(clock));
    const workspace = await workspaceManager.request(input("recovery-race", "workflow-recovery"));
    await workspaceManager.acquireLease(workspace.workspaceId, OWNER_A, 1_000);
    clock += 1_001;
    const newer = await workspaceManager.acquireLease(workspace.workspaceId, OWNER_B, 60_000);

    await expect(
      workspaceManager.acquireLease(workspace.workspaceId, OWNER_A, 60_000),
    ).rejects.toThrow(/LEASE_HELD/);
    expect((await workspaceManager.get(workspace.workspaceId)).fencingToken).toBe(
      newer.fencingToken,
    );
    await registry.close();
  });

  it("serializes concurrent claims to one deterministic durable winner", async () => {
    const { manager: first, registry: registryA } = await manager();
    const { manager: second, registry: registryB } = await manager();
    const workspace = await first.request(input("claim", "workflow-claim"));

    const [winner, loser] = await Promise.allSettled([
      first.acquireLease(workspace.workspaceId, OWNER_A, 60_000),
      second.acquireLease(workspace.workspaceId, OWNER_B, 60_000),
    ]);
    expect([winner.status, loser.status].sort()).toEqual(["fulfilled", "rejected"]);
    const durable = await first.get(workspace.workspaceId);
    expect(durable.leaseOwner).toBe(winner.status === "fulfilled" ? OWNER_A : OWNER_B);
    await Promise.all([registryA.close(), registryB.close()]);
  });

  it("enforces duplicate-active-workspace uniqueness in PostgreSQL", async () => {
    await applyWorkspaceMigration();
    const row = {
      workspaceId: "duplicate-a",
      slug: "duplicate-a",
      workflowId: "workflow-duplicate",
    };
    const insert = (workspaceId: string, slug: string) => sql`
      INSERT INTO icos_workspace_registry (
        workspace_id, worker_id, slug, branch, worktree_path, base_commit,
        integration_target, status, workflow_id
      ) VALUES (
        ${workspaceId}, 'worker', ${slug}, ${`ws/${slug}`}, ${`/tmp/${slug}`},
        'base', 'integration/phase-7', 'requested', ${row.workflowId}
      )
    `;
    await insert(row.workspaceId, row.slug);
    await expect(insert("duplicate-b", "duplicate-b")).rejects.toMatchObject({ code: "23505" });
  });

  it("requires the correct owner and fence to release", async () => {
    const { manager: workspaceManager, registry } = await manager();
    const workspace = await workspaceManager.request(input("release", "workflow-release"));
    const leased = await workspaceManager.acquireLease(workspace.workspaceId, OWNER_A, 60_000);

    await expect(
      workspaceManager.releaseLease(workspace.workspaceId, OWNER_B, leased.fencingToken),
    ).rejects.toThrow(/LEASE_NOT_OWNER/);
    await expect(
      workspaceManager.releaseLease(workspace.workspaceId, OWNER_A, leased.fencingToken - 1),
    ).rejects.toThrow(/STALE_FENCE/);
    await expect(
      workspaceManager.releaseLease(workspace.workspaceId, OWNER_A, leased.fencingToken),
    ).resolves.toMatchObject({ leaseOwner: null, leaseExpiresAt: null });
    await registry.close();
  });

  it("does not let the system actor bypass fenced autonomous mutation", async () => {
    const { manager: workspaceManager, registry } = await manager();
    const workspace = await workspaceManager.request(input("system", "workflow-system"));
    const leased = await workspaceManager.acquireLease(workspace.workspaceId, OWNER_A, 60_000);

    await expect(
      workspaceManager.transition(workspace.workspaceId, "creating", "workspace-manager"),
    ).rejects.toThrow(/FENCING_EVIDENCE_REQUIRED/);
    await expect(
      workspaceManager.transition(
        workspace.workspaceId,
        "creating",
        "workspace-manager",
        leased.fencingToken,
      ),
    ).rejects.toThrow(/LEASE_NOT_OWNER/);
    await registry.close();
  });
});

import postgres from "postgres";

import { TEST_DATABASE_URL, assertSafeTestDatabaseUrl } from "@/server/database/test-database-guard";
import { WorkspaceError, type Workspace } from "./types";

/** Registry state persisted to PostgreSQL. */
interface RegistryRow {
  workspace_id: string;
  worker_id: string;
  mission_id: string | null;
  task_id: string | null;
  slug: string;
  branch: string;
  worktree_path: string;
  base_commit: string;
  integration_target: string;
  file_scope_owns: string[];
  file_scope_shared: string[];
  file_scope_forbidden: string[];
  migration_from: number | null;
  migration_to: number | null;
  migration_namespace: string | null;
  status: string;
  created_at: string;
  released_at: string | null;
  source_commit: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  workflow_id: string | null;
  updated_at: string;
}

/** PostgreSQL-backed workspace registry. */
export class PostgresWorkspaceRegistry {
  private readonly sql: postgres.Sql<Record<string, postgres.PostgresType>>;

  constructor(private readonly dbUrl: string = TEST_DATABASE_URL) {
    const url = new URL(dbUrl);
    url.pathname = "/postgres"; // connect to admin DB
    this.sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  }

  /** Initialize the registry table. */
  async initialize(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS icos_workspace_registry (
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
        fencing_token INTEGER NOT NULL DEFAULT 0,
        workflow_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  }

  /** Read all workspaces. */
  async read(): Promise<Workspace[]> {
    const rows = await this.sql<RegistryRow[]>`
      SELECT * FROM icos_workspace_registry ORDER BY created_at ASC
    `;
    return rows.map(this.rowToWorkspace);
  }

  /** Execute a transaction with retry logic. */
    async transaction<T>(fn: (state: { workspaces: Workspace[] }) => T | Promise<T>): Promise<T> {
      // For PostgreSQL, we use session-level advisory locks for cross-process coordination
      // Session-level locks are released when the session ends, not at transaction end
      const lockResult = await this.sql`SELECT pg_try_advisory_lock(123456789)`;
      const gotLock = lockResult[0]?.pg_try_advisory_lock ?? false;

      if (!gotLock) {
        throw new WorkspaceError("REGISTRY_LOCKED", "Could not acquire advisory lock");
      }

      try {
        const workspaces = await this.read();
        const state = { workspaces };
        const result = await fn(state);

        // Persist changes
        await this.persist(state.workspaces);

        return result;
      } finally {
        await this.sql`SELECT pg_advisory_unlock(123456789)`;
      }
    }

  private async persist(workspaces: Workspace[]): Promise<void> {
      await this.sql.begin(async (tx) => {
        for (const ws of workspaces) {
          await tx`
            INSERT INTO icos_workspace_registry (
              workspace_id, worker_id, mission_id, task_id, slug, branch,
              worktree_path, base_commit, integration_target,
              file_scope_owns, file_scope_shared, file_scope_forbidden,
              migration_from, migration_to, migration_namespace,
              status, created_at, released_at, source_commit,
              lease_owner, lease_expires_at, fencing_token, workflow_id, updated_at
            ) VALUES (
              ${ws.workspaceId}, ${ws.workerId}, ${ws.missionId ?? null}, ${ws.taskId ?? null},
              ${ws.slug}, ${ws.branch}, ${ws.worktreePath}, ${ws.baseCommit},
              ${ws.integrationTarget}, ${ws.fileScope.owns}, ${ws.fileScope.shared},
              ${ws.fileScope.forbidden},
              ${ws.migrationReservation?.from ?? null}, ${ws.migrationReservation?.to ?? null}, ${ws.migrationReservation?.namespace ?? null},
              ${ws.status}, ${ws.createdAt}, ${ws.releasedAt ?? null}, ${ws.sourceCommit ?? null},
              ${ws.leaseOwner ?? null}, ${ws.leaseExpiresAt ?? null}, ${ws.fencingToken ?? 0}, ${ws.workflowId ?? null}, ${ws.updatedAt}
            )
            ON CONFLICT (workspace_id) DO UPDATE SET
              worker_id = EXCLUDED.worker_id,
              mission_id = EXCLUDED.mission_id,
              task_id = EXCLUDED.task_id,
              slug = EXCLUDED.slug,
              branch = EXCLUDED.branch,
              worktree_path = EXCLUDED.worktree_path,
              base_commit = EXCLUDED.base_commit,
              integration_target = EXCLUDED.integration_target,
              file_scope_owns = EXCLUDED.file_scope_owns,
              file_scope_shared = EXCLUDED.file_scope_shared,
              file_scope_forbidden = EXCLUDED.file_scope_forbidden,
              migration_from = EXCLUDED.migration_from,
              migration_to = EXCLUDED.migration_to,
              migration_namespace = EXCLUDED.migration_namespace,
              status = EXCLUDED.status,
              created_at = EXCLUDED.created_at,
              released_at = EXCLUDED.released_at,
              source_commit = EXCLUDED.source_commit,
              lease_owner = EXCLUDED.lease_owner,
              lease_expires_at = EXCLUDED.lease_expires_at,
              fencing_token = EXCLUDED.fencing_token,
              workflow_id = EXCLUDED.workflow_id,
              updated_at = EXCLUDED.updated_at
          `;
        }
      });
    }

  private rowToWorkspace(row: RegistryRow): Workspace {
    return {
      workspaceId: row.workspace_id,
      workerId: row.worker_id,
      missionId: row.mission_id ?? null,
      taskId: row.task_id ?? null,
      slug: row.slug,
      branch: row.branch,
      worktreePath: row.worktree_path,
      baseCommit: row.base_commit,
      integrationTarget: row.integration_target,
      fileScope: {
        owns: row.file_scope_owns,
        shared: row.file_scope_shared,
        forbidden: row.file_scope_forbidden,
      },
      migrationReservation: row.migration_from !== null ? {
        from: row.migration_from,
        to: row.migration_to ?? row.migration_from,
        namespace: row.migration_namespace ?? "",
      } : null,
      status: row.status as Workspace["status"],
      leaseOwner: row.lease_owner ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
      fencingToken: row.fencing_token ?? 0,
      workflowId: row.workflow_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      releasedAt: row.released_at ?? null,
      sourceCommit: row.source_commit ?? null,
      testDatabase: "", // Will be set by manager
    };
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
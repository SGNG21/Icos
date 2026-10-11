import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";

import { AuditGateReportRecorder, GATE_REPORT_EVENT, type IntegrationReport } from "./report";

/**
 * The gate report is durable (migration 0063): recorded in the append-only audit journal,
 * read back by a FRESH handle, and immutable there.
 */

const handles: DatabaseHandle[] = [];
afterAll(async () => {
  for (const h of handles) await h.close();
});

const report = (workspaceId: string): IntegrationReport => ({
  workspaceId,
  workerId: "worker-1",
  branch: "ws/x",
  worktree: "/w/x",
  baseCommit: "a".repeat(40),
  targetCommit: "b".repeat(40),
  testDatabase: "icos_test_x",
  fileScopeStatus: "PASS",
  sharedFilesChanged: [],
  migrations: [],
  typecheck: "PASS",
  lint: "PASS",
  unitTests: "PASS",
  postgresTests: "FAIL",
  build: "SKIPPED",
  secretCheck: "PASS",
  conflictStatus: "SKIPPED",
  conflictFiles: [],
  decision: "REJECT",
  commitSha: "c".repeat(40),
  reasons: ["tests PostgreSQL en échec (pnpm run test:integration) : ***"],
});

describe("rapport de gate — audit PostgreSQL (0063)", () => {
  it("enregistré, relu après redémarrage, et inaltérable", async () => {
    const first = await createDatabase(TEST_DATABASE_URL);
    handles.push(first);
    const workspaceId = `ws-${randomUUID()}`;
    await new AuditGateReportRecorder(new PostgresAuditRepository(first.db)).record(
      report(workspaceId),
      { missionId: "m-1", taskId: null },
    );

    const fresh = await createDatabase(TEST_DATABASE_URL);
    handles.push(fresh);
    const rows = (
      await new PostgresAuditRepository(fresh.db).query({ eventType: GATE_REPORT_EVENT })
    ).filter((r) => (r.details.report as { workspaceId?: string }).workspaceId === workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: GATE_REPORT_EVENT,
      actor: { kind: "system", id: "integration-gate" },
      details: { formatVersion: 1, missionId: "m-1", taskId: null, report: report(workspaceId) },
    });

    /* Append-only: the journal's trigger refuses to rewrite history. */
    await expect(
      fresh.db.execute(sql`delete from audit_entries where id = ${rows[0]!.id}`),
    ).rejects.toThrow();
  });
});

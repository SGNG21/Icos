import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createContainer, type Container } from "@/server/container";

import { auditEntrySchema, type AuditEntry } from "@/core/contracts";
import { auditToRow, rowToAuditEntry } from "@/server/database/mappers";

import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";

import { eq, inArray, sql } from "drizzle-orm";
import { auditEntries, tasks } from "@/server/database/schema";

describe("AuditEntry mapper and PostgresAuditRepository round-trip with PostgreSQL", () => {
  let container: Container | null = null;
  let db: any = null;
  let auditRepo: PostgresAuditRepository;

  const baseTime = new Date("2026-09-16T10:00:00.000Z");
  const baseTimeISO = baseTime.toISOString();

  beforeEach(async () => {
    if (container) {
      await container.close();
    }

    process.env.PERSISTENCE = "postgres";
    process.env.DATABASE_URL = "postgres://coco@localhost:5432/icos_n23_probe";
    // Required for OmniRoute reviewer in PostgreSQL mode
    process.env.OMNIROUTE_BASE_URL = "http://localhost:4000";
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.ICOS_REVIEWER_MODEL = "test-model";
    process.env.ICOS_REVIEWER_TIMEOUT_MS = "60000";

    container = await import("@/server/container").then(({ createContainer }) => createContainer());

    if (!container) throw new Error("Container is null");

    db = container.db;
    if (!db) throw new Error("container.db is undefined");

    auditRepo = new PostgresAuditRepository(db);

    // Remove only this test's identified fixtures.
    await db.execute(sql`SET session_replication_role = replica;`);
    await db
      .delete(auditEntries)
      .where(inArray(auditEntries.id, ["audit-entry-test-1", "audit-entry-test-2"]));
    await db.delete(tasks).where(eq(tasks.id, "task-test-123"));
    await db.execute(sql`SET session_replication_role = origin;`);
  });

  afterEach(async () => {
    if (db) {
      // Remove only this test's identified fixtures after each test.
      await db.execute(sql`SET session_replication_role = replica;`);
      await db
        .delete(auditEntries)
        .where(inArray(auditEntries.id, ["audit-entry-test-1", "audit-entry-test-2"]));
      await db.delete(tasks).where(eq(tasks.id, "task-test-123"));
      await db.execute(sql`SET session_replication_role = origin;`);
    }
    if (container) {
      await container.close();
    }
    // Clean up env
    delete process.env.PERSISTENCE;
    delete process.env.DATABASE_URL;
    delete process.env.OMNIROUTE_BASE_URL;
    delete process.env.OMNIROUTE_API_KEY;
    delete process.env.ICOS_REVIEWER_MODEL;
    delete process.env.ICOS_REVIEWER_TIMEOUT_MS;
  });

  it("should correctly map AuditEntry to row and back (round-trip)", () => {
    const entry: AuditEntry = auditEntrySchema.parse({
      id: "audit-entry-test-1",
      occurredAt: baseTimeISO,
      eventType: "task.execution.completed",
      actor: { kind: "agent", id: "agent-test" },
      taskId: "task-test-123",
      actionId: "action-test-456",
      details: { testKey: "testValue" },
      createdAt: baseTimeISO,
    });

    const row = auditToRow(entry);
    const parsedBack = rowToAuditEntry(row);

    expect(parsedBack).toEqual(entry);
    // Specifically check createdAt is preserved as ISO string
    expect(parsedBack.createdAt).toBe(entry.createdAt);
  });

  it("should persist and retrieve an AuditEntry with correct createdAt ISO string", async () => {
    // First, insert a task row to satisfy the foreign key constraint
    await db.insert(tasks).values({
      id: "task-test-123",
      title: "Test Task",
      description: null,
      status: "queued",
      assignedAgentId: null,
      createdAt: baseTime,
      updatedAt: baseTime,
    });

    const entry: AuditEntry = auditEntrySchema.parse({
      id: "audit-entry-test-2",
      occurredAt: baseTimeISO,
      eventType: "task.execution.completed",
      actor: { kind: "agent", id: "agent-test" },
      taskId: "task-test-123",
      actionId: undefined, // optional field, explicitly undefined
      details: { foo: "bar" },
      createdAt: baseTimeISO,
    });

    // Append the entry
    const returned = await auditRepo.append(entry);
    expect(returned).toEqual(entry);
    expect(returned.createdAt).toBe(entry.createdAt);

    // Query it back
    const allEntries = await auditRepo.list();
    expect(allEntries).toHaveLength(1);
    const retrieved = allEntries[0];
    expect(retrieved).toEqual(entry);
    // The createdAt should be the same ISO string
    expect(retrieved.createdAt).toBe(entry.createdAt);

    // Query by filter
    const filtered = await auditRepo.query({ eventType: "task.execution.completed" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].createdAt).toBe(entry.createdAt);
  });
});
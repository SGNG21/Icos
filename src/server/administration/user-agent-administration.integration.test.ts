import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { auditEntries } from "@/server/database/schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";

const ADMINISTRATION_AUDIT_EVENTS = [
  "human_user.created",
  "human_user.role_changed",
  "human_user.enabled",
  "human_user.disabled",
  "human_agent_link.created",
  "human_agent_link.removed",
  "human_user.administration_denied",
] as const;

describe.skipIf(!dockerAvailable)("Administration humains-agents (intégration PostgreSQL)", () => {
  let ctx: PgContext;

  beforeAll(async () => {
    ctx = await startPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopPostgres(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx.handle);
  });

  async function seedIdentities(): Promise<void> {
    await ctx.handle.db.execute(sql`
      INSERT INTO "user" (id, name, email)
      VALUES
        ('human-target', 'Target', 'target@icos.test'),
        ('human-other', 'Other', 'other@icos.test'),
        ('human-actor', 'Actor', 'actor@icos.test')
    `);
    await ctx.handle.db.execute(sql`
      INSERT INTO agents (
        id,
        name,
        role,
        status,
        authorization_level,
        description
      )
      VALUES
        ('agent-linked', 'Linked', 'Operations', 'available', 1, 'Agent lié'),
        ('agent-other', 'Other', 'Operations', 'available', 1, 'Autre agent')
    `);
  }

  it("crée la table human_agent_links avec ses colonnes et trois FK restrictives", async () => {
    const columns = await ctx.handle.db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
    }>(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'human_agent_links'
      ORDER BY ordinal_position
    `);

    expect(columns).toEqual([
      { column_name: "id", data_type: "text", is_nullable: "NO" },
      { column_name: "human_user_id", data_type: "text", is_nullable: "NO" },
      { column_name: "agent_id", data_type: "text", is_nullable: "NO" },
      { column_name: "relation", data_type: "text", is_nullable: "NO" },
      {
        column_name: "created_at",
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      },
      {
        column_name: "created_by_human_user_id",
        data_type: "text",
        is_nullable: "NO",
      },
    ]);

    const foreignKeys = await ctx.handle.db.execute<{
      column_name: string;
      delete_action: string;
    }>(sql`
      SELECT attribute.attname AS column_name,
             constraint_record.confdeltype::text AS delete_action
      FROM pg_constraint AS constraint_record
      JOIN LATERAL unnest(constraint_record.conkey) AS key(attnum) ON true
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = constraint_record.conrelid
       AND attribute.attnum = key.attnum
      WHERE constraint_record.conrelid = 'human_agent_links'::regclass
        AND constraint_record.contype = 'f'
      ORDER BY attribute.attname
    `);

    expect(foreignKeys).toEqual([
      { column_name: "agent_id", delete_action: "r" },
      { column_name: "created_by_human_user_id", delete_action: "r" },
      { column_name: "human_user_id", delete_action: "r" },
    ]);
  });

  it("ferme les relations, interdit les doublons et protège les trois références", async () => {
    await seedIdentities();
    await ctx.handle.db.execute(sql`
      INSERT INTO human_agent_links (
        id,
        human_user_id,
        agent_id,
        relation,
        created_at,
        created_by_human_user_id
      )
      VALUES (
        'link-1',
        'human-target',
        'agent-linked',
        'operator',
        '2026-07-23T08:00:00.000Z',
        'human-actor'
      )
    `);

    await expect(
      ctx.handle.db.execute(sql`
        INSERT INTO human_agent_links (
          id,
          human_user_id,
          agent_id,
          relation,
          created_at,
          created_by_human_user_id
        )
        VALUES (
          'link-duplicate',
          'human-target',
          'agent-linked',
          'observer',
          '2026-07-23T08:01:00.000Z',
          'human-actor'
        )
      `),
    ).rejects.toThrow();

    await expect(
      ctx.handle.db.execute(sql`
        INSERT INTO human_agent_links (
          id,
          human_user_id,
          agent_id,
          relation,
          created_at,
          created_by_human_user_id
        )
        VALUES (
          'link-invalid',
          'human-other',
          'agent-other',
          'administrator',
          '2026-07-23T08:02:00.000Z',
          'human-actor'
        )
      `),
    ).rejects.toThrow();

    await expect(
      ctx.handle.db.execute(sql`DELETE FROM "user" WHERE id = 'human-target'`),
    ).rejects.toThrow();
    await expect(
      ctx.handle.db.execute(sql`DELETE FROM agents WHERE id = 'agent-linked'`),
    ).rejects.toThrow();
    await expect(
      ctx.handle.db.execute(sql`DELETE FROM "user" WHERE id = 'human-actor'`),
    ).rejects.toThrow();
  });

  it("accepte les sept événements d'audit de l'administration humaine", async () => {
    await ctx.handle.db.insert(auditEntries).values(
      ADMINISTRATION_AUDIT_EVENTS.map((eventType, index) => ({
        id: `audit-administration-${index}`,
        eventType,
        actorType: "human",
        actorLabel: "human-actor",
        details: {},
        occurredAt: new Date(`2026-07-23T08:0${index}:00.000Z`),
      })),
    );

    const rows = await ctx.handle.db
      .select({ eventType: auditEntries.eventType })
      .from(auditEntries);
    expect(rows.map(({ eventType }) => eventType)).toEqual(ADMINISTRATION_AUDIT_EVENTS);
  });
});

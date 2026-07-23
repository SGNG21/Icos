import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { session, user, userRoles } from "@/server/database/auth-schema";
import { auditEntries, humanAgentLinks } from "@/server/database/schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";
import { PostgresHumanAgentLinkRepository } from "@/server/repositories/postgres/human-agent-link-repository";
import { PostgresHumanUserRepository } from "@/server/repositories/postgres/human-user-repository";
import { PostgresHumanAdministrationUnitOfWork } from "@/server/uow/postgres-human-administration-uow";

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

  it("liste et recherche les humains avec leur rôle effectif", async () => {
    await seedIdentities();
    await ctx.handle.db.insert(userRoles).values([
      {
        userId: "human-target",
        role: "viewer",
        grantedAt: new Date("2026-07-23T08:00:00.000Z"),
      },
      {
        userId: "human-target",
        role: "operator",
        grantedAt: new Date("2026-07-23T08:01:00.000Z"),
      },
      {
        userId: "human-actor",
        role: "admin",
        grantedAt: new Date("2026-07-23T08:02:00.000Z"),
      },
    ]);
    const users = new PostgresHumanUserRepository(ctx.handle.db);

    expect(await users.list()).toEqual([
      {
        id: "human-actor",
        email: "actor@icos.test",
        name: "Actor",
        status: "active",
        role: "admin",
      },
      {
        id: "human-other",
        email: "other@icos.test",
        name: "Other",
        status: "active",
        role: null,
      },
      {
        id: "human-target",
        email: "target@icos.test",
        name: "Target",
        status: "active",
        role: "operator",
      },
    ]);
    expect(await users.findById("human-target")).toMatchObject({
      id: "human-target",
      role: "operator",
    });
    expect(await users.findByEmail("TARGET@ICOS.TEST")).toMatchObject({
      id: "human-target",
      role: "operator",
    });
    expect(await users.findById("human-missing")).toBeNull();
  });

  it("liste les liens de façon déterministe et déduit les IDs agents", async () => {
    await seedIdentities();
    await ctx.handle.db.insert(humanAgentLinks).values([
      {
        id: "link-z",
        humanUserId: "human-target",
        agentId: "agent-other",
        relation: "observer",
        createdAt: new Date("2026-07-23T08:01:00.000Z"),
        createdByHumanUserId: "human-actor",
      },
      {
        id: "link-b",
        humanUserId: "human-target",
        agentId: "agent-linked",
        relation: "operator",
        createdAt: new Date("2026-07-23T08:00:00.000Z"),
        createdByHumanUserId: "human-actor",
      },
      {
        id: "link-a",
        humanUserId: "human-other",
        agentId: "agent-linked",
        relation: "supervisor",
        createdAt: new Date("2026-07-23T08:00:00.000Z"),
        createdByHumanUserId: "human-actor",
      },
    ]);
    const links = new PostgresHumanAgentLinkRepository(ctx.handle.db);

    expect(await links.listForHuman("human-target")).toEqual([
      {
        id: "link-b",
        humanUserId: "human-target",
        agentId: "agent-linked",
        relation: "operator",
        createdAt: "2026-07-23T08:00:00.000Z",
        createdByHumanUserId: "human-actor",
      },
      {
        id: "link-z",
        humanUserId: "human-target",
        agentId: "agent-other",
        relation: "observer",
        createdAt: "2026-07-23T08:01:00.000Z",
        createdByHumanUserId: "human-actor",
      },
    ]);
    expect(await links.listAgentIdsForHuman("human-target")).toEqual(
      new Set(["agent-linked", "agent-other"]),
    );
    expect(await links.listForHuman("human-missing")).toEqual([]);
    expect(await links.listAgentIdsForHuman("human-missing")).toEqual(new Set());
  });

  it("finalise la création avec rôle et audit dans une transaction", async () => {
    await seedIdentities();
    const uow = new PostgresHumanAdministrationUnitOfWork(ctx.handle.db);

    const result = await uow.finalizeHumanCreation({
      targetUserId: "human-target",
      role: "operator",
      actorUserId: "human-actor",
      auditId: "audit-created",
      occurredAt: "2026-07-23T09:00:00.000Z",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: "human-target",
        email: "target@icos.test",
        name: "Target",
        status: "active",
        role: "operator",
      },
      changed: true,
    });
    expect(await ctx.handle.db.select().from(userRoles)).toEqual([
      expect.objectContaining({ userId: "human-target", role: "operator" }),
    ]);
    expect(await ctx.handle.db.select().from(auditEntries)).toEqual([
      expect.objectContaining({
        id: "audit-created",
        eventType: "human_user.created",
        actorType: "human",
        actorLabel: "human-actor",
        details: { targetUserId: "human-target", role: "operator" },
      }),
    ]);
  });

  it("remplace toutes les lignes de rôle, révoque les sessions et audite", async () => {
    await seedIdentities();
    await ctx.handle.db.insert(userRoles).values([
      {
        userId: "human-target",
        role: "viewer",
        grantedAt: new Date("2026-07-23T08:00:00.000Z"),
      },
      {
        userId: "human-target",
        role: "operator",
        grantedAt: new Date("2026-07-23T08:01:00.000Z"),
      },
    ]);
    await ctx.handle.db.insert(session).values([
      {
        id: "session-target-a",
        token: "token-target-a",
        userId: "human-target",
        expiresAt: new Date("2026-07-24T08:00:00.000Z"),
        createdAt: new Date("2026-07-23T08:00:00.000Z"),
        updatedAt: new Date("2026-07-23T08:00:00.000Z"),
      },
      {
        id: "session-other",
        token: "token-other",
        userId: "human-other",
        expiresAt: new Date("2026-07-24T08:00:00.000Z"),
        createdAt: new Date("2026-07-23T08:00:00.000Z"),
        updatedAt: new Date("2026-07-23T08:00:00.000Z"),
      },
    ]);
    const uow = new PostgresHumanAdministrationUnitOfWork(ctx.handle.db);

    const result = await uow.replaceRole({
      targetUserId: "human-target",
      nextRole: "viewer",
      actorUserId: "human-actor",
      auditId: "audit-role",
      occurredAt: "2026-07-23T09:00:00.000Z",
    });

    expect(result).toMatchObject({
      ok: true,
      value: { id: "human-target", role: "viewer" },
      changed: true,
    });
    expect(
      await ctx.handle.db
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, "human-target")),
    ).toEqual([{ role: "viewer" }]);
    expect(
      await ctx.handle.db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.userId, "human-target")),
    ).toEqual([]);
    expect(
      await ctx.handle.db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.userId, "human-other")),
    ).toEqual([{ id: "session-other" }]);
    expect(await ctx.handle.db.select().from(auditEntries)).toEqual([
      expect.objectContaining({
        eventType: "human_user.role_changed",
        details: {
          targetUserId: "human-target",
          previousRole: "operator",
          nextRole: "viewer",
          changed: true,
        },
      }),
    ]);
  });

  it("audite un rôle identique sans réécriture ni révocation", async () => {
    await seedIdentities();
    const grantedAt = new Date("2026-07-23T08:00:00.000Z");
    await ctx.handle.db.insert(userRoles).values({
      userId: "human-target",
      role: "operator",
      grantedAt,
    });
    await ctx.handle.db.insert(session).values({
      id: "session-target",
      token: "token-target",
      userId: "human-target",
      expiresAt: new Date("2026-07-24T08:00:00.000Z"),
      createdAt: new Date("2026-07-23T08:00:00.000Z"),
      updatedAt: new Date("2026-07-23T08:00:00.000Z"),
    });
    const uow = new PostgresHumanAdministrationUnitOfWork(ctx.handle.db);

    const result = await uow.replaceRole({
      targetUserId: "human-target",
      nextRole: "operator",
      actorUserId: "human-actor",
      auditId: "audit-role-same",
      occurredAt: "2026-07-23T09:00:00.000Z",
    });

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(await ctx.handle.db.select().from(userRoles)).toEqual([
      expect.objectContaining({
        userId: "human-target",
        role: "operator",
        grantedAt,
      }),
    ]);
    expect(await ctx.handle.db.select().from(session)).toHaveLength(1);
    expect(await ctx.handle.db.select().from(auditEntries)).toEqual([
      expect.objectContaining({
        details: {
          targetUserId: "human-target",
          previousRole: "operator",
          nextRole: "operator",
          changed: false,
        },
      }),
    ]);
  });

  it("désactive avec révocation et réactive sans créer de session", async () => {
    await seedIdentities();
    await ctx.handle.db.insert(userRoles).values({
      userId: "human-target",
      role: "operator",
      grantedAt: new Date("2026-07-23T08:00:00.000Z"),
    });
    await ctx.handle.db.insert(session).values({
      id: "session-target",
      token: "token-target",
      userId: "human-target",
      expiresAt: new Date("2026-07-24T08:00:00.000Z"),
      createdAt: new Date("2026-07-23T08:00:00.000Z"),
      updatedAt: new Date("2026-07-23T08:00:00.000Z"),
    });
    const uow = new PostgresHumanAdministrationUnitOfWork(ctx.handle.db);

    expect(
      await uow.setStatus({
        targetUserId: "human-target",
        nextStatus: "disabled",
        actorUserId: "human-actor",
        auditId: "audit-disabled",
        occurredAt: "2026-07-23T09:00:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: { status: "disabled", role: "operator" },
      changed: true,
    });
    expect(await ctx.handle.db.select().from(session)).toHaveLength(0);

    expect(
      await uow.setStatus({
        targetUserId: "human-target",
        nextStatus: "active",
        actorUserId: "human-actor",
        auditId: "audit-enabled",
        occurredAt: "2026-07-23T09:01:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: { status: "active", role: "operator" },
      changed: true,
    });
    expect(await ctx.handle.db.select().from(session)).toHaveLength(0);
    expect(
      (await ctx.handle.db.select().from(auditEntries)).map((entry) => ({
        eventType: entry.eventType,
        details: entry.details,
      })),
    ).toEqual([
      {
        eventType: "human_user.disabled",
        details: {
          targetUserId: "human-target",
          previousStatus: "active",
          nextStatus: "disabled",
          changed: true,
        },
      },
      {
        eventType: "human_user.enabled",
        details: {
          targetUserId: "human-target",
          previousStatus: "disabled",
          nextStatus: "active",
          changed: true,
        },
      },
    ]);
  });

  it("protège le dernier owner actif sous deux mutations concurrentes", async () => {
    await seedIdentities();
    await ctx.handle.db.insert(userRoles).values({
      userId: "human-target",
      role: "owner",
      grantedAt: new Date("2026-07-23T08:00:00.000Z"),
    });
    const uow = new PostgresHumanAdministrationUnitOfWork(ctx.handle.db);

    const results = await Promise.all([
      uow.replaceRole({
        targetUserId: "human-target",
        nextRole: "admin",
        actorUserId: "human-actor",
        auditId: "audit-last-owner-role",
        occurredAt: "2026-07-23T09:00:00.000Z",
      }),
      uow.setStatus({
        targetUserId: "human-target",
        nextStatus: "disabled",
        actorUserId: "human-actor",
        auditId: "audit-last-owner-status",
        occurredAt: "2026-07-23T09:00:01.000Z",
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ ok: false, reason: "last_owner" }),
      expect.objectContaining({ ok: false, reason: "last_owner" }),
    ]);
    expect(
      await ctx.handle.db
        .select({ status: user.status })
        .from(user)
        .where(eq(user.id, "human-target")),
    ).toEqual([{ status: "active" }]);
    expect(
      await ctx.handle.db
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, "human-target")),
    ).toEqual([{ role: "owner" }]);
    expect(await ctx.handle.db.select().from(auditEntries)).toHaveLength(0);
  });

  it("crée et retire un lien avec son audit atomique", async () => {
    await seedIdentities();
    const uow = new PostgresHumanAdministrationUnitOfWork(ctx.handle.db);

    expect(
      await uow.createAgentLink({
        id: "link-created",
        targetUserId: "human-target",
        agentId: "agent-linked",
        relation: "operator",
        actorUserId: "human-actor",
        auditId: "audit-link-created",
        occurredAt: "2026-07-23T09:00:00.000Z",
      }),
    ).toEqual({
      ok: true,
      value: {
        id: "link-created",
        humanUserId: "human-target",
        agentId: "agent-linked",
        relation: "operator",
        createdAt: "2026-07-23T09:00:00.000Z",
        createdByHumanUserId: "human-actor",
      },
      changed: true,
    });

    expect(
      await uow.removeAgentLink({
        targetUserId: "human-target",
        agentId: "agent-linked",
        actorUserId: "human-actor",
        auditId: "audit-link-removed",
        occurredAt: "2026-07-23T09:01:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: { id: "link-created", relation: "operator" },
      changed: true,
    });
    expect(await ctx.handle.db.select().from(humanAgentLinks)).toHaveLength(0);
    expect(
      (await ctx.handle.db.select().from(auditEntries)).map((entry) => entry.eventType),
    ).toEqual(["human_agent_link.created", "human_agent_link.removed"]);
  });

  it("mappe le lien dupliqué et le retrait absent sans exposer SQL", async () => {
    await seedIdentities();
    const uow = new PostgresHumanAdministrationUnitOfWork(ctx.handle.db);
    const input = {
      id: "link-created",
      targetUserId: "human-target",
      agentId: "agent-linked",
      relation: "observer" as const,
      actorUserId: "human-actor",
      auditId: "audit-link-created",
      occurredAt: "2026-07-23T09:00:00.000Z",
    };
    await uow.createAgentLink(input);

    const duplicate = await uow.createAgentLink({
      ...input,
      id: "link-duplicate",
      auditId: "audit-link-duplicate",
    });
    expect(duplicate).toEqual({
      ok: false,
      reason: "already_exists",
      message: "lien humain-agent déjà existant",
    });
    expect(JSON.stringify(duplicate)).not.toMatch(/constraint|duplicate key|INSERT/i);

    expect(
      await uow.removeAgentLink({
        targetUserId: "human-other",
        agentId: "agent-other",
        actorUserId: "human-actor",
        auditId: "audit-link-missing",
        occurredAt: "2026-07-23T09:01:00.000Z",
      }),
    ).toEqual({
      ok: false,
      reason: "not_found",
      message: "lien humain-agent introuvable",
    });
    expect(await ctx.handle.db.select().from(auditEntries)).toHaveLength(1);
  });

  it("rollback une mutation si l'écriture d'audit échoue", async () => {
    await seedIdentities();
    await ctx.handle.db.insert(userRoles).values({
      userId: "human-target",
      role: "operator",
      grantedAt: new Date("2026-07-23T08:00:00.000Z"),
    });
    await ctx.handle.db.insert(auditEntries).values({
      id: "audit-collision",
      eventType: "task.created",
      actorType: "system",
      actorLabel: "icos",
      details: {},
      occurredAt: new Date("2026-07-23T08:00:00.000Z"),
    });
    const uow = new PostgresHumanAdministrationUnitOfWork(ctx.handle.db);

    await expect(
      uow.replaceRole({
        targetUserId: "human-target",
        nextRole: "viewer",
        actorUserId: "human-actor",
        auditId: "audit-collision",
        occurredAt: "2026-07-23T09:00:00.000Z",
      }),
    ).rejects.toThrow();

    expect(
      await ctx.handle.db
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, "human-target")),
    ).toEqual([{ role: "operator" }]);
    expect(await ctx.handle.db.select().from(auditEntries)).toHaveLength(1);
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

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEnv } from "@/config/env";
import { createContainer, type Container } from "@/server/container";
import { account } from "@/server/database/auth-schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";

import { bootstrapOwner } from "./bootstrap";
import type { GuardedResult, RoleRepository } from "./ports";

const OWNER_EMAIL = "owner@icos.test";
const PASSWORD = "correct horse battery staple";

describe.skipIf(!dockerAvailable)("Fondation d'identité (Better Auth + rôles ICOS)", () => {
  let ctx: PgContext;
  let container: Container;

  beforeAll(async () => {
    ctx = await startPostgres();
    container = await createContainer({
      env: loadEnv({
        PERSISTENCE: "postgres",
        DATABASE_URL: ctx.container.getConnectionUri(),
        BETTER_AUTH_SECRET: "x".repeat(40),
        BETTER_AUTH_URL: "http://localhost:3000",
      }),
    });
  }, 120_000);

  afterAll(async () => {
    await container?.close();
    await stopPostgres(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx.handle);
  });

  function auth() {
    if (!container.auth || !container.roles) throw new Error("auth non composée");
    return { gateway: container.auth, roles: container.roles, audit: container.audit };
  }

  it("crée un utilisateur via Better Auth (compte credential + hash présent)", async () => {
    const { gateway } = auth();
    const created = await gateway.createHumanUser({ email: OWNER_EMAIL, password: PASSWORD });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const user = await gateway.readHumanUser(created.userId);
    expect(user?.email).toBe(OWNER_EMAIL);
    expect(user?.status).toBe("active");

    const accounts = await ctx.handle.db
      .select()
      .from(account)
      .where(eq(account.userId, created.userId));
    expect(accounts).toHaveLength(1);
    expect(accounts[0].password).toBeTruthy(); // hash présent, non vide
    expect(accounts[0].providerId).toBe("credential");
  });

  it("refuse un email en double (comportement Better Auth)", async () => {
    const { gateway } = auth();
    expect((await gateway.createHumanUser({ email: OWNER_EMAIL, password: PASSWORD })).ok).toBe(
      true,
    );
    const second = await gateway.createHumanUser({ email: OWNER_EMAIL, password: PASSWORD });
    expect(second).toMatchObject({ ok: false, reason: "already_exists" });
  });

  it("attribue et lit les rôles ; grant idempotent ; cascade à la suppression", async () => {
    const { gateway, roles } = auth();
    const created = await gateway.createHumanUser({ email: OWNER_EMAIL, password: PASSWORD });
    if (!created.ok) throw new Error();

    await roles.grantRole(created.userId, "admin");
    await roles.grantRole(created.userId, "admin"); // idempotent
    expect(await roles.listRoles(created.userId)).toEqual(["admin"]);

    await gateway.deleteHumanUser(created.userId);
    expect(await roles.listRoles(created.userId)).toEqual([]);
    expect(await gateway.readHumanUser(created.userId)).toBeNull();
  });

  it("bootstrap : crée le premier owner, idempotent, sans secret dans l'audit", async () => {
    const { gateway, roles, audit } = auth();

    const first = await bootstrapOwner(
      { auth: gateway, roles, audit },
      {
        email: OWNER_EMAIL,
        password: PASSWORD,
      },
    );
    expect(first).toMatchObject({ ok: true, status: "created" });
    const owners = await roles.listActiveOwnerIds();
    expect(owners).toHaveLength(1);

    // Idempotent : second appel → already_present (aucun second owner).
    const second = await bootstrapOwner(
      { auth: gateway, roles, audit },
      {
        email: "someone-else@icos.test",
        password: PASSWORD,
      },
    );
    expect(second).toMatchObject({ ok: true, status: "already_present" });
    expect(await roles.listActiveOwnerIds()).toHaveLength(1);

    // Audit : user.created + bootstrap.succeeded, sans secret.
    const entries = await audit.list();
    const types = entries.map((e) => e.eventType);
    expect(types).toContain("user.created");
    expect(types).toContain("auth.bootstrap.succeeded");
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized.toLowerCase()).not.toContain("password");
  });

  it("bootstrap : répare un utilisateur existant sans rôle owner", async () => {
    const { gateway, roles, audit } = auth();
    const created = await gateway.createHumanUser({ email: OWNER_EMAIL, password: PASSWORD });
    if (!created.ok) throw new Error();

    const result = await bootstrapOwner(
      { auth: gateway, roles, audit },
      {
        email: OWNER_EMAIL,
        password: PASSWORD,
      },
    );
    expect(result).toMatchObject({ ok: true, status: "repaired" });
    expect(await roles.listRoles(created.userId)).toContain("owner");
  });

  it("compensation : échec d'attribution du rôle après création → utilisateur supprimé", async () => {
    const { gateway, audit } = auth();
    // Rôles factices : aucun owner, mais grantRole échoue de façon déterministe.
    const failingRoles: RoleRepository = {
      listActiveOwnerIds: async () => [],
      listRoles: async () => [],
      grantRole: async () => {
        throw new Error("échec déterministe d'attribution");
      },
      revokeRole: async (): Promise<GuardedResult> => ({ ok: false, reason: "not_found" }),
      setUserStatus: async (): Promise<GuardedResult> => ({ ok: false, reason: "not_found" }),
    };

    const result = await bootstrapOwner(
      { auth: gateway, roles: failingRoles, audit },
      { email: OWNER_EMAIL, password: PASSWORD },
    );

    expect(result).toMatchObject({ ok: false, reason: "role_grant_failed" });
    // Compensation : l'utilisateur créé a été supprimé.
    expect(await gateway.readHumanUserByEmail(OWNER_EMAIL)).toBeNull();
    // Aucun secret dans l'audit.
    expect(JSON.stringify(await audit.list())).not.toContain(PASSWORD);
  });

  it("garde du dernier owner : retrait et désactivation refusés (transactionnel)", async () => {
    const { gateway, roles } = auth();
    const created = await gateway.createHumanUser({ email: OWNER_EMAIL, password: PASSWORD });
    if (!created.ok) throw new Error();
    await roles.grantRole(created.userId, "owner");

    expect(await roles.revokeRole(created.userId, "owner")).toMatchObject({
      ok: false,
      reason: "last_owner",
    });
    expect(await roles.setUserStatus(created.userId, "disabled")).toMatchObject({
      ok: false,
      reason: "last_owner",
    });
    // L'owner est toujours présent et actif.
    expect(await roles.listActiveOwnerIds()).toEqual([created.userId]);
  });
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEnv } from "@/config/env";
import { createContainer, type Container } from "@/server/container";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";

const run = promisify(execFile);
const PASSWORD = "correct horse battery staple";

describe.skipIf(!dockerAvailable)("CLI auth:bootstrap (bout en bout via tsx)", () => {
  let ctx: PgContext;
  let container: Container; // pour seeding/inspection (pool distinct de la CLI)
  let baseEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    ctx = await startPostgres();
    const uri = ctx.container.getConnectionUri();
    baseEnv = {
      ...process.env,
      PERSISTENCE: "postgres",
      DATABASE_URL: uri,
      BETTER_AUTH_SECRET: "x".repeat(40),
      BETTER_AUTH_URL: "http://localhost:3000",
    };
    container = await createContainer({
      env: loadEnv({
        PERSISTENCE: "postgres",
        DATABASE_URL: uri,
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

  async function bootstrapCli(email: string): Promise<{ stdout: string; stderr: string }> {
    return run("node_modules/.bin/tsx", ["scripts/auth-bootstrap.ts"], {
      cwd: process.cwd(),
      env: { ...baseEnv, ICOS_OWNER_EMAIL: email, ICOS_OWNER_PASSWORD: PASSWORD },
    });
  }

  it("première exécution → owner_created (utilisateur, compte, rôle, audits, sans secret)", async () => {
    const { stdout } = await bootstrapCli("owner@icos.test");
    expect(stdout.trim()).toBe("owner_created");
    expect(stdout).not.toContain(PASSWORD);

    const roles = container.roles!;
    expect(await roles.listActiveOwnerIds()).toHaveLength(1);

    const audit = await container.audit.list();
    const types = audit.map((e) => e.eventType);
    expect(types).toContain("user.created");
    expect(types).toContain("auth.bootstrap.succeeded");
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
  });

  it("seconde exécution identique → owner_already_present (aucun second owner)", async () => {
    await bootstrapCli("owner@icos.test");
    const { stdout } = await bootstrapCli("owner@icos.test");
    expect(stdout.trim()).toBe("owner_already_present");
    expect(await container.roles!.listActiveOwnerIds()).toHaveLength(1);
  });

  it("réparation : utilisateur existant sans rôle owner → owner_repaired", async () => {
    const created = await container.auth!.createHumanUser({
      email: "owner@icos.test",
      password: PASSWORD,
    });
    if (!created.ok) throw new Error("seed échoué");

    const { stdout } = await bootstrapCli("owner@icos.test");
    expect(stdout.trim()).toBe("owner_repaired");
    expect(await container.roles!.listRoles(created.userId)).toContain("owner");
    expect(await container.roles!.listActiveOwnerIds()).toEqual([created.userId]);
  });
});

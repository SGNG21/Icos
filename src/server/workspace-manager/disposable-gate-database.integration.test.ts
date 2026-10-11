import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { sandboxBackend } from "@/server/workers/process/sandbox-backend";

import {
  DisposableGateDatabase,
  disposableDatabaseName,
  disposableDatabasePrefix,
} from "./disposable-gate-database";
import { Git } from "./git";
import { IntegrationGate, type GateCommands, type GateOptions } from "./integration-gate";
import { WorkspaceManager } from "./manager";
import { InMemoryWorkspaceRegistry } from "./registry";
import { SandboxedCommandRunner } from "./sandboxed-command-runner";
import { FakeProvisioner, makeRepoFixture, type RepoFixture } from "./test-fixtures";
import type { Workspace } from "./types";

/**
 * H1 (ADR 0075), PROVEN ON A REAL CLUSTER AND A REAL SANDBOX.
 *
 * The integration gate runs a worker-authored script as its PostgreSQL step, under bwrap with
 * the network namespace unshared, with a disposable database behind the gatekeeper socket.
 * The script tries what a hostile test would try and writes what it saw into its worktree.
 */

const backend = sandboxBackend().backend;
const ADMIN = new URL(TEST_DATABASE_URL);
const ADMIN_PORT = Number(ADMIN.port || 5432);
const ADMIN_USER = decodeURIComponent(ADMIN.username);
/* The PostgreSQL client, mounted read-only into the sandbox so the probe can use it. */
const PG_PACKAGE = realpathSync(path.join(process.cwd(), "node_modules", "postgres"));

const PROBE = `
import { writeFileSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
const [pkg, adminPort, httpPort, otherDb, adminUser, exitCode] = process.argv.slice(2);
const { default: postgres } = await import(pkg + "/src/index.js");
const url = process.env.ICOS_TEST_DATABASE_URL;
const own = new URL(url);
const ownDb = own.pathname.slice(1);
const tcp = (host, port) => new Promise((resolve) => {
  const s = connect({ host, port: Number(port) }, () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
  setTimeout(() => { s.destroy(); resolve(false); }, 2000);
});
const login = async (options) => {
  const sql = postgres({ host: "127.0.0.1", port: 5432, max: 1, connect_timeout: 5, onnotice: () => {}, ...options });
  try { await sql\`select 1\`; return "connected"; }
  catch (e) { return "refused:" + (e.code ?? e.message); }
  finally { await sql.end({ timeout: 1 }).catch(() => {}); }
};
const fails = async (fn) => { try { await fn(); return false; } catch { return true; } };

const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
const [who] = await sql\`select current_user as "user", current_database() as db,
  (select rolsuper or rolcreatedb or rolcreaterole from pg_roles where rolname = current_user) as privileged\`;
await sql\`create table probe (x int)\`;
await sql\`insert into probe values (1), (2)\`;
const [{ n }] = await sql\`select count(*)::int as n from probe\`;
const createDbRefused = await fails(() => sql.unsafe("create database icos_test_probe_escape"));
const setRoleRefused = await fails(() => sql.unsafe('set role "' + adminUser + '"'));
await sql.end();

const report = {
  own: { ...who, rows: n, createDbRefused, setRoleRefused },
  asAdmin: await login({ user: adminUser, database: ownDb }),
  sharedTestDb: await login({ user: own.username, password: own.password, database: "icos_test" }),
  maintenanceDb: await login({ user: own.username, password: own.password, database: "postgres" }),
  otherRun: await login({ user: otherDb, database: otherDb }),
  tcpAdminCluster: await tcp("127.0.0.1", adminPort),
  tcpHostService: await tcp("127.0.0.1", httpPort),
  tcpInternet: await tcp("1.1.1.1", 443),
  dns: await lookup("example.com").then(() => true, () => false),
  envKeys: Object.keys(process.env).sort(),
  urlUser: own.username,
  adminUrlVisible: Object.values(process.env).some((v) => typeof v === "string" && v.includes(":" + adminPort)),
};
mkdirSync(".probe", { recursive: true });
writeFileSync(".probe/db.json", JSON.stringify(report));
process.exit(Number(exitCode));
`;

const LEASE = { owner: "gate-owner", fencingToken: 1 };
const APPROVED: GateOptions = {
  review: { verdict: "APPROVED", reviewer: "reviewer-1" },
  lease: LEASE,
};

async function prepare(
  fx: RepoFixture,
  manager: WorkspaceManager,
  slug: string,
  files: Record<string, string>,
): Promise<string> {
  const { workspaceId } = await manager.request({
    slug,
    workerId: `worker-${slug}`,
    manual: true,
    fileScope: { owns: [`src/${slug}/**`], shared: [], forbidden: [] },
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

const fakeWs = (workspaceId: string) => ({ workspaceId }) as Workspace;

describe("DisposableGateDatabase — le cluster réel (sans bac à sable)", () => {
  let admin: postgres.Sql;
  beforeAll(() => {
    admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await admin.end();
  });
  const exists = async (name: string) => {
    const [r] = await admin`select
      exists(select 1 from pg_database where datname = ${name}) as db,
      exists(select 1 from pg_roles where rolname = ${name}) as role`;
    return r as { db: boolean; role: boolean };
  };

  it("un rôle LOGIN sans privilège, propriétaire de sa seule base ; CONNECT retiré à PUBLIC", async () => {
    const gdb = new DisposableGateDatabase();
    const a = await gdb.open(fakeWs("ws-iso-a"));
    const b = await gdb.open(fakeWs("ws-iso-b"));
    try {
      const [role] =
        await admin`select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
        from pg_roles where rolname = ${a.database}`;
      expect(role).toEqual({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolcanlogin: true,
      });
      /*
       * Even BYPASSING the gatekeeper (straight to the cluster, as the host can), role A cannot
       * open run B's database: PostgreSQL itself refuses (42501), whatever pg_hba says.
       */
      const direct = postgres({
        host: ADMIN.hostname,
        port: ADMIN_PORT,
        user: a.database,
        password: a.secrets[0],
        database: b.database,
        max: 1,
        onnotice: () => {},
      });
      await expect(direct`select 1`).rejects.toMatchObject({ code: "42501" });
      await direct.end();
      expect(a.env.ICOS_TEST_DATABASE_URL).not.toContain(`:${ADMIN_PORT}/`);
      expect(a.env.ICOS_TEST_DATABASE_URL).toContain(`127.0.0.1:5432/${a.database}`);
      expect(Object.keys(a.env)).toEqual(["ICOS_TEST_DATABASE_URL"]);
    } finally {
      await a.close();
      await b.close();
    }
    expect(await exists(a.database)).toEqual({ db: false, role: false });
    expect(await exists(b.database)).toEqual({ db: false, role: false });
  });

  it("les restes d'un run interrompu du même workspace sont balayés à l'ouverture suivante", async () => {
    const leftover = disposableDatabaseName("ws-crashed", "dead0001");
    await admin.unsafe(`create role "${leftover}" login`);
    await admin.unsafe(`create database "${leftover}" owner "${leftover}"`);
    const gdb = new DisposableGateDatabase();
    const s = await gdb.open(fakeWs("ws-crashed"));
    try {
      expect(await exists(leftover)).toEqual({ db: false, role: false });
      expect(s.database.startsWith(disposableDatabasePrefix("ws-crashed"))).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("refuse un cluster d'administration qui n'est pas une base de test", async () => {
    const gdb = new DisposableGateDatabase({ adminUrl: "postgres://icos@127.0.0.1:1/icos_app" });
    await expect(gdb.open(fakeWs("ws-x"))).rejects.toThrow("TEST_DATABASE_UNSAFE");
  });
});

describe.skipIf(!backend)("IntegrationGate — étape PostgreSQL RÉELLE sous bwrap (H1)", () => {
  let fx: RepoFixture;
  let server: Server;
  let httpPort: number;
  let admin: postgres.Sql;

  beforeAll(async () => {
    fx = makeRepoFixture();
    admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    /* Stands for every host service (model router, Temporal, the app) on loopback. */
    server = createServer((_req, res) => res.end("host"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    httpPort = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await admin.end();
    fx.cleanup();
  });

  async function runGate(slug: string, exitCode: number) {
    const db = new FakeProvisioner();
    const git = new Git(fx.master);
    const manager = new WorkspaceManager({
      git,
      registry: new InMemoryWorkspaceRegistry(),
      provisioner: db,
      worktreeRoot: fx.root,
      masterRepo: fx.master,
    });
    /* Another run, live at the same time: its database must stay out of reach. */
    const gateDb = new DisposableGateDatabase();
    const other = await gateDb.open(fakeWs(`ws-other-${slug}`));
    const noop = ["node", "-e", ""];
    const commands: GateCommands = {
      install: noop,
      typecheck: noop,
      lint: noop,
      unit: noop,
      build: noop,
      postgres: [
        [
          "node",
          `src/${slug}/dbprobe.mjs`,
          PG_PACKAGE,
          String(ADMIN_PORT),
          String(httpPort),
          other.database,
          ADMIN_USER,
          String(exitCode),
        ],
      ],
    };
    const gate = new IntegrationGate({
      git,
      manager,
      database: gateDb,
      runner: new SandboxedCommandRunner({ readOnlyPaths: [PG_PACKAGE] }),
      commands,
    });
    try {
      const id = await prepare(fx, manager, slug, { [`src/${slug}/dbprobe.mjs`]: PROBE });
      const report = await gate.integrate(id, APPROVED);
      const probeFile = path.join(fx.root, slug, ".probe", "db.json");
      const seen = existsSync(probeFile) ? JSON.parse(readFileSync(probeFile, "utf8")) : null;
      const leftovers = await admin`select datname from pg_database
        where datname like ${`${disposableDatabasePrefix(id)}\\_%`}`;
      const leftoverRoles = await admin`select rolname from pg_roles
        where rolname like ${`${disposableDatabasePrefix(id)}\\_%`}`;
      return { report, seen, leftovers: leftovers.length + leftoverRoles.length, other };
    } finally {
      await other.close();
    }
  }

  it("(a) sa base jetable seulement ; (b) ni hôte ni Internet ; (c) ni URL ni rôle admin ; (d) ni autre run ; (e) détruite", async () => {
    const { report, seen, leftovers } = await runGate("h1ok", 0);
    expect(report.postgresTests, report.reasons.join("\n")).toBe("PASS");
    expect(report.decision).toBe("ACCEPT");
    expect(seen).not.toBeNull();

    /* (a) its own disposable database, through the socket, fully usable — and unprivileged. */
    expect(seen.own).toMatchObject({
      rows: 2,
      privileged: false,
      createDbRefused: true,
      setRoleRefused: true,
    });
    expect(seen.own.user).toBe(seen.own.db);
    expect(seen.own.db.startsWith("icos_test_gate_")).toBe(true);

    /* (b) no host service, not the cluster itself, no internet, no DNS. */
    expect(seen.tcpAdminCluster).toBe(false);
    expect(seen.tcpHostService).toBe(false);
    expect(seen.tcpInternet).toBe(false);
    expect(seen.dns).toBe(false);

    /* (c) the admin URL and role are nowhere; logging in as admin through the door fails. */
    expect(seen.adminUrlVisible).toBe(false);
    expect(seen.urlUser).not.toBe(ADMIN_USER);
    expect(seen.asAdmin).toMatch(/^refused:/);
    expect(seen.sharedTestDb).toMatch(/^refused:/);
    expect(seen.maintenanceDb).toMatch(/^refused:/);

    /* (d) another live run's database is unreachable. */
    expect(seen.otherRun).toMatch(/^refused:/);
    expect(report.reasons.join(" ")).toContain("connexion(s) refusée(s)");

    /* (e) dropped, role included. */
    expect(leftovers).toBe(0);
  }, 180_000);

  it("(e) même quand l'étape échoue, la base et le rôle jetables sont détruits", async () => {
    const { report, seen, leftovers, other } = await runGate("h1fail", 3);
    expect(seen).not.toBeNull();
    expect(report.postgresTests).toBe("FAIL");
    expect(report.decision).toBe("REJECT");
    expect(leftovers).toBe(0);
    /* The per-run password never reaches the report. */
    expect(JSON.stringify(report)).not.toContain(other.secrets[0]!);
  }, 180_000);
});

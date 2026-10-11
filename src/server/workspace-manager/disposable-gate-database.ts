import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import postgres from "postgres";

import {
  TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
} from "@/server/database/test-database-guard";

import { startDatabaseGatekeeper, type DatabaseGatekeeper } from "./database-gatekeeper";
import { assertWorkerDatabaseName } from "./guards";
import type { GateDatabase, GateDatabaseSession } from "./integration-gate";
import type { Workspace } from "./types";

/**
 * A DISPOSABLE DATABASE PER POSTGRES STEP, REACHABLE ONLY THROUGH ICOS (H1, ADR 0075).
 *
 * Before: the gate's PostgreSQL step ran worker-authored tests with the HOST network and the
 * shared test-cluster credential. Those tests could reach every localhost service (model
 * router, Temporal, other databases, the app) and the internet, and could read or alter every
 * other workspace's test data.
 *
 * Now, for each run of the step:
 *   1. ICOS — outside the sandbox, with the admin test URL that never enters it — creates a
 *      LOGIN role and a database it owns, both named `icos_test_gate_<hash(workspace)>_<nonce>`.
 *      The role has no SUPERUSER/CREATEDB/CREATEROLE/REPLICATION, and PUBLIC loses CONNECT on
 *      the database, so another run's role cannot open it either.
 *   2. ICOS listens on a UNIX socket in a fresh 0700 directory, bind-mounted into the sandbox.
 *      The {@link startDatabaseGatekeeper gatekeeper} behind it forwards to the test cluster
 *      only a startup packet naming exactly this database and this role.
 *   3. The step keeps its network namespace UNSHARED. Its command is wrapped by a tiny relay
 *      that listens on the sandbox's OWN loopback (127.0.0.1:5432, invisible to the host) and
 *      pipes to the socket, so every PostgreSQL client works with a plain URL.
 *   4. The step's only database variable is that per-run URL. Afterwards — success, failure or
 *      exception — the gatekeeper is closed, the database and role are dropped and the socket
 *      directory removed. Leftovers of a crashed run of the same workspace are swept on the
 *      next open.
 */

/** Port the relay listens on INSIDE the sandbox (its private loopback). */
export const SANDBOX_DATABASE_PORT = 5432;

/** `icos_test_gate_<10 hex of sha256(workspaceId)>` — the per-workspace prefix. */
export function disposableDatabasePrefix(workspaceId: string): string {
  const hash = createHash("sha256").update(workspaceId).digest("hex").slice(0, 10);
  return `icos_test_gate_${hash}`;
}

export function disposableDatabaseName(workspaceId: string, nonce: string): string {
  if (!/^[a-z0-9]{1,12}$/.test(nonce)) throw new Error("GATE_DATABASE_NONCE_INVALID");
  const name = `${disposableDatabasePrefix(workspaceId)}_${nonce}`;
  assertWorkerDatabaseName(name);
  return name;
}

/**
 * Runs inside the sandbox: `node relay.mjs <socket> <port> -- <command…>`. Listens on the
 * sandbox loopback, pipes each connection to the gatekeeper's socket, runs the command and
 * exits with its status. It holds nothing secret and grants nothing: the socket is the door,
 * and the gatekeeper behind it is outside the sandbox.
 */
export const RELAY_SOURCE = `import net from "node:net";
import { spawn } from "node:child_process";
const [socketPath, port, sep, ...command] = process.argv.slice(2);
if (sep !== "--" || command.length === 0) {
  console.error("ICOS_GATE_DB_RELAY: usage: relay <socket> <port> -- <command...>");
  process.exit(2);
}
const server = net.createServer((client) => {
  const upstream = net.connect(socketPath);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});
server.on("error", (e) => {
  console.error("ICOS_GATE_DB_RELAY: " + e.message);
  process.exit(1);
});
server.listen(Number(port), "127.0.0.1", () => {
  const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
  child.on("error", (e) => {
    console.error("ICOS_GATE_DB_RELAY: " + e.message);
    process.exit(127);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
});
`;

export interface DisposableGateDatabaseOptions {
  /** Admin URL of the TEST cluster. Never handed to the step. Default: ICOS_TEST_DATABASE_URL. */
  readonly adminUrl?: string;
  /** Where socket directories are created. Default: the OS temp directory. */
  readonly tmpRoot?: string;
  /** Injectable for tests. */
  readonly nonce?: () => string;
}

const quoteIdent = (name: string) => {
  assertWorkerDatabaseName(name);
  return `"${name}"`;
};

export class DisposableGateDatabase implements GateDatabase {
  private readonly adminUrl: string;
  private readonly tmpRoot: string;
  private readonly nonce: () => string;

  constructor(options: DisposableGateDatabaseOptions = {}) {
    this.adminUrl = options.adminUrl ?? TEST_DATABASE_URL;
    this.tmpRoot = options.tmpRoot ?? tmpdir();
    this.nonce = options.nonce ?? (() => randomBytes(4).toString("hex"));
  }

  private async admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(this.adminUrl, { max: 1, onnotice: () => {} });
    try {
      return await fn(sql);
    } finally {
      await sql.end();
    }
  }

  private async dropRun(sql: postgres.Sql, name: string): Promise<void> {
    await sql.unsafe(`drop database if exists ${quoteIdent(name)} with (force)`);
    await sql.unsafe(`drop role if exists ${quoteIdent(name)}`);
  }

  /** Databases and roles of a previous run of this workspace that never reached `close`. */
  private async sweep(sql: postgres.Sql, prefix: string): Promise<void> {
    const pattern = `${prefix}\\_%`;
    const dbs = await sql<{ name: string }[]>`
      select datname as name from pg_database where datname like ${pattern}`;
    const roles = await sql<{ name: string }[]>`
      select rolname as name from pg_roles where rolname like ${pattern}`;
    for (const name of new Set([...dbs, ...roles].map((r) => r.name))) {
      await this.dropRun(sql, name);
    }
  }

  async open(ws: Workspace): Promise<GateDatabaseSession> {
    /* Never a production cluster: the admin URL must itself name a test database. */
    assertSafeTestDatabaseUrl(this.adminUrl);
    const name = disposableDatabaseName(ws.workspaceId, this.nonce());
    const password = randomBytes(24).toString("hex");
    const admin = new URL(this.adminUrl);
    const upstream = {
      host: admin.hostname.replace(/^\[(.*)\]$/, "$1") || "localhost",
      port: Number(admin.port || 5432),
    };

    let created = false;
    let dir: string | null = null;
    let gatekeeper: DatabaseGatekeeper | null = null;
    const dispose = async () => {
      const errors: unknown[] = [];
      const attempt = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (error) {
          errors.push(error);
        }
      };
      /* Cut the step's connections first: DROP … WITH (FORCE) then has nothing to wait for. */
      if (gatekeeper) await attempt(() => gatekeeper!.close());
      if (created) await attempt(() => this.admin((sql) => this.dropRun(sql, name)));
      if (dir) await attempt(() => rm(dir!, { recursive: true, force: true }));
      if (errors.length) {
        const first = errors[0];
        throw new Error(
          `GATE_DATABASE_CLEANUP_FAILED ${name}: ${first instanceof Error ? first.message : String(first)}`,
        );
      }
    };

    try {
      await this.admin(async (sql) => {
        await this.sweep(sql, disposableDatabasePrefix(ws.workspaceId));
        created = true;
        await sql.unsafe(
          `create role ${quoteIdent(name)} login nosuperuser nocreatedb nocreaterole ` +
            `noreplication noinherit nobypassrls connection limit 32 password '${password}'`,
        );
        await sql.unsafe(`create database ${quoteIdent(name)} owner ${quoteIdent(name)}`);
        await sql.unsafe(`revoke all on database ${quoteIdent(name)} from public`);
      });
      dir = await mkdtemp(path.join(this.tmpRoot, "icos-gate-db-"));
      const socketPath = path.join(dir, `.s.PGSQL.${SANDBOX_DATABASE_PORT}`);
      const relayPath = path.join(dir, "relay.mjs");
      await writeFile(relayPath, RELAY_SOURCE, { mode: 0o600 });
      gatekeeper = await startDatabaseGatekeeper({
        socketPath,
        upstream,
        user: name,
        database: name,
      });
      const url = `postgres://${name}:${password}@127.0.0.1:${SANDBOX_DATABASE_PORT}/${name}`;
      const keeper = gatekeeper;
      return {
        database: name,
        env: { ICOS_TEST_DATABASE_URL: url },
        readWritePaths: [dir],
        secrets: [password],
        wrap: (command) => [
          "node",
          relayPath,
          socketPath,
          String(SANDBOX_DATABASE_PORT),
          "--",
          ...command,
        ],
        refusals: () => [...keeper.refusals],
        close: dispose,
      };
    } catch (error) {
      await dispose().catch(() => {});
      throw error;
    }
  }
}

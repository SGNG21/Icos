import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";

/*
 * D1 — THE CONTAINER MUST RELEASE EVERY CLIENT IT OPENED.
 *
 * `buildPostgresContainer` opens THREE PostgreSQL clients: the shared drizzle handle, plus
 * one each for the workspace registry and the git port (both need a connection outside the
 * drizzle schema). `close()` closed only the handle, so two `postgres.js` pools and their
 * sockets outlived it and kept the Node event loop alive.
 *
 * For a long-lived server that is invisible. For a CLI it is fatal: `scripts/
 * auth-bootstrap.ts` did its work, printed its result, and then never exited — so the test
 * that spawned it waited out its 60s timeout, three times over. D1 was never an auth defect;
 * it was one leaked lifecycle wearing three failures.
 *
 * This counts real backends rather than asserting on internals, so it also catches the NEXT
 * component that opens a connection and forgets to close it.
 */

const DATABASE_URL = TEST_DATABASE_URL;

const env = () =>
  loadEnv({
    NODE_ENV: "test",
    PERSISTENCE: "postgres",
    DATABASE_URL,
    OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
    OMNIROUTE_API_KEY: "lifecycle-test-key",
    ICOS_REVIEWER_MODEL: "lifecycle-test-model",
  });

const open: Container[] = [];

/** Backends currently connected to the test database, counted from PostgreSQL itself. */
async function backendCount(): Promise<number> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const db = new URL(DATABASE_URL).pathname.slice(1);
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where datname = ${db} and pid <> pg_backend_pid()
    `;
    return rows[0]!.n;
  } finally {
    await sql.end();
  }
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
});

describe("D1 — container lifecycle", () => {
  it("RELEASES EVERY PostgreSQL client it opened", async () => {
    const before = await backendCount();

    const container = await buildPostgresContainer(DATABASE_URL, undefined, env());
    open.push(container);
    const during = await backendCount();
    /* It really did open connections — otherwise the assertion below proves nothing. */
    expect(during).toBeGreaterThan(before);

    await container.close();
    open.splice(0);

    /*
     * Back to baseline. `postgres.js` closes sockets asynchronously, so allow a brief
     * settle rather than asserting on the first sample and flaking.
     */
    let after = await backendCount();
    for (let i = 0; i < 20 && after > before; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      after = await backendCount();
    }
    expect(after).toBeLessThanOrEqual(before);
  }, 120_000);

  it("CLOSE IS IDEMPOTENT: a second close does not throw", async () => {
    const container = await buildPostgresContainer(DATABASE_URL, undefined, env());
    await container.close();
    /* Shutdown paths run twice (signal + explicit stop); the second must be harmless. */
    await expect(container.close()).resolves.toBeUndefined();
  }, 120_000);
});

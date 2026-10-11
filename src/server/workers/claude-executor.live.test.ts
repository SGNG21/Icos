import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Attribution } from "@/core/budget/contracts";
import { ambientlyAttributed, ambientlyReserved, SPEND_LEDGER_TENANT_ID } from "@/server/budget/compose-spend";
import { meteredFetch } from "@/server/budget/metered-fetch";
import { PostgresSpendLedger } from "@/server/budget/postgres-spend-ledger";
import { PostgresSpendReservations } from "@/server/budget/postgres-spend-reservations";
import { createDatabase } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";

import { startMeteredEgressProxy } from "./metered-egress-proxy";
import { createEphemeralHome } from "./process/ephemeral-home";
import { runNonInteractive } from "./process/run-process";

/**
 * OPT-IN LIVE PROOF (ICOS_N1_LIVE=1): the REAL `/usr/bin/claude`, through the REAL adapter,
 * in a REAL bwrap sandbox with NO network, reaching OmniRoute only through the REAL metered
 * proxy, whose meter is the production `meteredFetch` over the PostgreSQL ledger AND
 * reservation store (test database) under a 50 000-token goal cap.
 *
 *   ICOS_N1_LIVE=1 ICOS_N1_LIVE_MODEL=<model> ICOS_TEST_DATABASE_URL=… \
 *     pnpm vitest run src/server/workers/claude-executor.live.test.ts
 *
 * It SPENDS (a few thousand tokens). Never part of the default run.
 */

const LIVE = process.env.ICOS_N1_LIVE === "1";
const GATEWAY = process.env.ICOS_N1_LIVE_GATEWAY ?? "http://127.0.0.1:20129";
const MODEL = process.env.ICOS_N1_LIVE_MODEL ?? "nvidia/moonshotai/kimi-k2.6";
const GOAL_CAP_TOKENS = Number(process.env.ICOS_N1_LIVE_GOAL_CAP ?? 50_000);
const ADAPTER = resolve(__dirname, "../../../bin/icos-claude-worker.mjs");

describe.skipIf(!LIVE)("LIVE: Claude Code via OmniRoute, metered and capped by ICOS", () => {
  it("creates hello.txt containing OK; every call is reserved and recorded under the goal", async () => {
    const handle = createDatabase(TEST_DATABASE_URL, { max: 2 });
    const attribution: Attribution = { goalId: `live-goal-${randomUUID()}`, missionId: `live-mission-${randomUUID()}` };
    const caps = async () => ({ kind: "CAPPED" as const, maxTotalTokens: GOAL_CAP_TOKENS });
    const ledger = new PostgresSpendLedger({ db: handle.db, tenantId: SPEND_LEDGER_TENANT_ID, caps });
    const reservations = new PostgresSpendReservations({ db: handle.db, tenantId: SPEND_LEDGER_TENANT_ID, caps });

    const worktree = await mkdtemp(join(tmpdir(), "icos-live-wt-"));
    const socketDir = await mkdtemp(join(tmpdir(), "icos-live-egress-"));
    const status = join(worktree, ".icos-status.json");
    const home = await createEphemeralHome();
    const proxy = await startMeteredEgressProxy({
      socketPath: join(socketDir, "gateway.sock"),
      upstreamBaseUrl: GATEWAY,
      fetch: meteredFetch(globalThis.fetch, {
        ledger: ambientlyAttributed(ledger),
        reservations: ambientlyReserved(reservations),
      }),
      attribution,
    });
    try {
      const run = await runNonInteractive({
        command: ADAPTER,
        args: [
          "--prompt",
          "Create a file named hello.txt in the current directory containing exactly: OK. Then reply DONE.",
          "--model",
          MODEL,
          "--max-budget-usd",
          "0.20",
          "--timeout-ms",
          "240000",
        ],
        cwd: worktree,
        env: {
          HOME: home.path,
          TMPDIR: home.path,
          ICOS_EGRESS_SOCKET: proxy.socketPath,
          ICOS_WORKER_STATUS_FILE: status,
        },
        timeoutMs: 270_000,
        sandbox: {
          readWritePaths: [worktree, home.path],
          readOnlyPaths: [ADAPTER, socketDir],
          allowNetwork: false,
        },
      });
      const window = await ledger.windowFor(attribution);
      const statusJson = await readFile(status, "utf8").catch(() => "{}");
      const hello = await readFile(join(worktree, "hello.txt"), "utf8").catch(() => null);
      /* Evidence, printed for the report: no secret in any of it. */
      console.log(
        JSON.stringify(
          {
            model: MODEL,
            confinement: run.confinement,
            networkEnforced: run.networkEnforced,
            exitCode: run.exitCode,
            stdout: run.stdout.slice(0, 400),
            stderr: run.stderr.slice(-800),
            status: JSON.parse(statusJson),
            proxy: proxy.stats,
            ledgerWindow: window,
            hello,
          },
          null,
          2,
        ),
      );
      expect(run.confinement).toBe("bubblewrap");
      expect(run.networkEnforced).toBe(true);
      expect(proxy.stats.forwarded).toBeGreaterThan(0);
      expect(window.calls).toBe(proxy.stats.forwarded);
      expect(window.unmeteredCalls).toBe(0);
      expect(window.totalTokens).toBeGreaterThan(0);
      expect(window.totalTokens).toBeLessThanOrEqual(GOAL_CAP_TOKENS);
      expect(hello?.trim()).toBe("OK");
      expect(run.exitCode).toBe(0);
    } finally {
      await proxy.close();
      await home.dispose();
      await handle.close();
      await rm(worktree, { recursive: true, force: true });
      await rm(socketDir, { recursive: true, force: true });
    }
  }, 300_000);
});

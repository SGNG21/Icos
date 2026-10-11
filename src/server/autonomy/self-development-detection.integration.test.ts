import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { updateCandidateStatus } from "@/core/autonomy/improvement-backlog";
import { composeSpendMeters } from "@/server/budget/compose-spend";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { createSelfDevelopmentScheduler } from "@/server/system/production-services";

import { CanonicalImprovementProposer } from "./canonical-improvement-proposer";
import { BACKLOG_PARTITION, DurableImprovementBacklog } from "./durable-improvement-backlog";
import { EslintQualityProbe } from "./eslint-quality-probe";
import { OmniRouteCompletionProvider } from "./omniroute-autonomous-mission-planner";
import {
  DETECTION_PARTITION,
  PROPOSAL_SLOT_TYPE,
  SelfDevelopmentDetection,
  detectionDay,
} from "./self-development-detection";

/**
 * DECISION 0076, end to end against PostgreSQL: the self-development TIMER detects a real
 * ESLint warning in a fixture repository (real eslint, confined by the real sandbox runner),
 * proposes exactly ONE candidate through a fake OmniRoute, metered under its own attribution,
 * survives a restart without proposing a second one the same day, and a 1-token cap stops the
 * proposer before the upstream is ever called.
 */

const WORKTREE = process.cwd();
const MODEL = "test/sd-proposer";
const USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };

describe("self-development detection — timer -> probe -> metered proposal -> durable backlog", () => {
  let fixture: string;
  let server: Server;
  let baseUrl: string;
  const upstream: Array<{ body: { messages: Array<{ content: string }>; max_tokens?: number } }> = [];
  const handles: DatabaseHandle[] = [];

  const open = () => {
    const handle = createDatabase(TEST_DATABASE_URL, { max: 4 });
    handles.push(handle);
    return handle;
  };

  /** Everything a process composes at boot — built anew to model a restart. */
  const compose = (handle: DatabaseHandle, maxTokensPerDay?: number) => {
    const spend = composeSpendMeters({
      db: handle.db,
      ...(maxTokensPerDay === undefined ? {} : { maxTotalTokensPerSelfDevelopmentDay: maxTokensPerDay }),
    });
    const memory = new PostgresDurableMemory(handle.db);
    const backlog = new DurableImprovementBacklog(memory);
    const proposer = new CanonicalImprovementProposer({
      provider: new OmniRouteCompletionProvider({
        baseUrl,
        apiKey: "test-only-key",
        model: MODEL,
        timeoutMs: 10_000,
        fetch: spend.selfDevelopment,
      }),
      backlog,
      repoPath: fixture,
      timeoutMs: 10_000,
    });
    const detection = new SelfDevelopmentDetection({
      backlog,
      memory,
      probe: new EslintQualityProbe({
        repoPath: fixture,
        toolRoot: WORKTREE,
        paths: ["src"],
        timeoutMs: 120_000,
      }),
      proposer,
      maxProposalsPerDay: 1,
    });
    return { backlog, memory, detection };
  };

  const advanced: number[] = [];
  const coordinator = {
    advance: async () => {
      advanced.push(Date.now());
      return { status: "NO_CANDIDATE" as const, reason: "advance is not under test here" };
    },
  };

  const until = async (predicate: () => Promise<boolean>, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("condition not reached");
  };

  const ledgerRows = async (handle: DatabaseHandle) =>
    (await handle.db.execute(
      sql`select attribution_key, model_id, usage_kind, total_tokens::int as total_tokens
          from spend_ledger where attribution_key like 'self-development=%' order by recorded_at`,
    )) as unknown as Array<{ attribution_key: string; model_id: string; usage_kind: string; total_tokens: number }>;

  beforeAll(async () => {
    fixture = mkdtempSync(path.join(tmpdir(), "icos-sd-fixture-"));
    mkdirSync(path.join(fixture, "src"));
    writeFileSync(
      path.join(fixture, "eslint.config.mjs"),
      'export default [{ files: ["**/*.js"], rules: { "no-unused-vars": "warn" } }];\n',
    );
    writeFileSync(
      path.join(fixture, "src", "unused.js"),
      "const leftover = 1;\nconst another = 2;\nexport const used = 3;\n",
    );
    writeFileSync(path.join(fixture, "src", "clean.js"), "export const clean = 1;\n");

    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (raw += chunk));
      request.on("end", () => {
        upstream.push({ body: JSON.parse(raw) });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: MODEL,
            usage: USAGE,
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    title: "Remove the unused bindings in src/unused.js",
                    description: "Delete `leftover` and `another`, which ESLint reports as unused.",
                    rationale: "Dead bindings obscure the module's real surface.",
                    category: "maintainability",
                    targetComponent: "src/unused.js",
                    priority: "low",
                  }),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await Promise.all(handles.map((h) => h.close()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(fixture, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const handle = open();
    await handle.db.execute(
      sql`delete from context_items where "missionId" in (${BACKLOG_PARTITION}, ${DETECTION_PARTITION})`,
    );
    await handle.db.execute(sql`TRUNCATE TABLE spend_ledger, spend_reservations`);
    upstream.length = 0;
    advanced.length = 0;
  });

  it("the timer proposes exactly ONE grounded candidate, metered; a restart proposes nothing more today", async () => {
    const first = compose(open());
    const scheduler = createSelfDevelopmentScheduler(coordinator, 50, first.detection);
    scheduler.start();
    try {
      await until(async () => (await first.backlog.list({})).length > 0, 90_000);
      /* Many more ticks: the candidate is selectable, so nothing else is detected or proposed. */
      await new Promise((r) => setTimeout(r, 1_000));
    } finally {
      await scheduler.stop();
    }

    const candidates = await first.backlog.list({});
    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    expect(candidate).toMatchObject({
      status: "proposed",
      category: "maintainability",
      targetComponent: "src/unused.js",
    });
    /* Grounded in what the REAL eslint measured in the fixture. */
    expect(candidate!.rationale).toContain("rule `no-unused-vars` reports 2 warning(s) in `src/unused.js` (lines 1, 2)");
    expect(candidate!.rationale).toContain("confined by bubblewrap, network denied by the OS");
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.body.messages[1]!.content).toContain('targetComponent MUST be exactly "src/unused.js"');
    /* The budget seam bounded the request it forwarded. */
    expect(typeof upstream[0]!.body.max_tokens).toBe("number");
    expect(advanced.length).toBeGreaterThan(0);

    /* Metered under its OWN attribution, in the durable ledger. */
    const day = detectionDay(new Date());
    const verify = open();
    expect(await ledgerRows(verify)).toEqual([
      {
        attribution_key: `self-development=sd-proposal-${day}`,
        model_id: MODEL,
        usage_kind: "METERED",
        total_tokens: USAGE.total_tokens,
      },
    ]);

    /* The mission it became failed: the candidate is rejected, nothing is selectable. */
    const reviewing = updateCandidateStatus(candidate!, "under_review", "test");
    await first.backlog.update({ ...reviewing, updatedAt: new Date(Date.parse(candidate!.updatedAt) + 1).toISOString() });
    const rejected = updateCandidateStatus(reviewing, "rejected", "test", "TASK_FAILED");
    await first.backlog.update({ ...rejected, updatedAt: new Date(Date.parse(candidate!.updatedAt) + 2).toISOString() });

    /* RESTART: a new connection, new services, same database, same day. */
    const restarted = compose(open());
    const again = createSelfDevelopmentScheduler(coordinator, 50, restarted.detection);
    again.start();
    await new Promise((r) => setTimeout(r, 1_500));
    await again.stop();

    expect(await restarted.detection.maybePropose()).toEqual({ status: "SKIPPED", reason: "DAILY_CAP_REACHED" });
    expect(await restarted.backlog.list({})).toHaveLength(1);
    expect(upstream).toHaveLength(1);
    const slots = (await restarted.memory.queryContextItems({ missionId: DETECTION_PARTITION, includeHistory: true })).filter(
      (i) => i.type === PROPOSAL_SLOT_TYPE,
    );
    expect(slots.map((s) => s.id)).toEqual([`sd-proposal-slot-${day}-1`]);
  }, 180_000);

  it("a 1-token cap DENIES the proposer before the upstream is called", async () => {
    const handle = open();
    const { detection, backlog } = compose(handle, 1);

    const outcome = await detection.maybePropose();

    expect(outcome).toEqual({ status: "FAILED", stage: "PROPOSE", reason: "AUTONOMY_PROPOSER_BUDGET_DENIED" });
    expect(upstream).toHaveLength(0);
    expect(await backlog.list({})).toHaveLength(0);
    expect(await ledgerRows(handle)).toEqual([]);
  }, 180_000);
});

import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { AuditEntry } from "@/core/contracts/audit";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { WorkerHealthProber } from "@/server/services/worker-registry/worker-health-prober";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import {
  applyComputeBootstrap,
  DEFAULT_COMPUTE_CAPABILITIES,
  planComputeBootstrap,
} from "@/server/workers/compute-bootstrap";
import { candidateWorkerId } from "@/server/workers/compute-fleet";
import { readFleetReadiness } from "@/server/workers/fleet-readiness";

/*
 * MIGRATION 0062 + PROBER + RETIREMENT + READINESS, against a real PostgreSQL.
 *
 * Every phase uses a FRESH handle: the durable row is the only carrier, which is what
 * proves the failure class, the retirement marker and the readiness figures survive a
 * restart rather than living in some process's memory. Test database only.
 */

const SERVED = [
  "claude/claude-sonnet-5",
  "claude/claude-opus-5",
  "codex/gpt-5.6-sol",
  "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
];
const OPTIONS = { runtime: "binary" as const, capabilities: [...DEFAULT_COMPUTE_CAPABILITIES] };
const GONE_MODEL = "codex/gpt-5.6-sol";
const GONE = candidateWorkerId(GONE_MODEL);
const SONNET = candidateWorkerId("claude/claude-sonnet-5");

const handles: DatabaseHandle[] = [];

async function restart() {
  const db = await createDatabase(TEST_DATABASE_URL);
  handles.push(db);
  const store = new PostgresWorkerRegistryStore(db.db);
  const registration = new WorkerRegistrationService(store);
  const audit = new PostgresAuditRepository(db.db);
  return {
    db,
    store,
    registration,
    audit,
    router: new CapabilityRouter(store),
    boot: async (listed: readonly string[] = SERVED) =>
      applyComputeBootstrap(
        registration,
        planComputeBootstrap({
          source: "https://gateway.invalid",
          listed,
          existing: await store.list(),
          options: OPTIONS,
        }),
        { audit },
      ),
    /* Model workers probed by message: nvidia has no credential, the rest answer. */
    prober: () =>
      new WorkerHealthProber(store, registration, {
        selectProbe: (w) => ({
          probe: async () => {
            if (w.metadata.provider === "nvidia") {
              throw new Error("404 no active credentials for provider nvidia");
            }
            if (w.id === GONE) throw new Error("404 unknown model");
            return { health: "healthy" as const, availability: "available" as const };
          },
        }),
      }),
  };
}

async function fleetAudit(
  audit: PostgresAuditRepository,
  eventType: "worker.fleet.retired" | "worker.fleet.reinstated",
  since: string,
): Promise<AuditEntry[]> {
  return (await audit.query({ eventType })).filter(
    (e) => e.details.workerId === GONE && e.occurredAt >= since,
  );
}

beforeEach(async () => {
  const db = await createDatabase(TEST_DATABASE_URL);
  await db.db.execute(sql.raw("TRUNCATE TABLE workers RESTART IDENTITY CASCADE"));
  await db.close();
});

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

describe("0062 fleet readiness evidence (PostgreSQL)", () => {
  it("MIGRATION: the column exists, nullable, and both CHECKs refuse what they must", async () => {
    const { db, registration } = await restart();
    const [column] = (await db.db.execute(
      sql.raw(
        "select is_nullable from information_schema.columns where table_name = 'workers' and column_name = 'last_probe_error_class'",
      ),
    )) as unknown as Array<{ is_nullable: string }>;
    expect(column?.is_nullable).toBe("YES");

    await registration.register({
      id: SONNET,
      workerKind: "agent",
      displayName: "w",
      runtime: "binary",
      runtimeSupport: "SUPPORTED_RUNTIME",
    });
    /* An out-of-vocabulary class — e.g. raw error text — cannot be stored at all. */
    await expect(
      db.db.execute(
        sql`update workers set last_probe_error_class = 'Bearer sk-xyz', last_probe_outcome = 'failed', last_probe_at = now() where id = ${SONNET}`,
      ),
    ).rejects.toThrow();
    /* A class cannot accompany a successful probe. */
    await expect(
      db.db.execute(
        sql`update workers set last_probe_error_class = 'UNKNOWN', last_probe_outcome = 'ok', last_probe_at = now() where id = ${SONNET}`,
      ),
    ).rejects.toThrow();
    await db.db.execute(
      sql`update workers set last_probe_error_class = 'RATE_LIMITED', last_probe_outcome = 'failed', last_probe_at = now() where id = ${SONNET}`,
    );

    const audits = (await db.db.execute(
      sql.raw(
        "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'audit_event_type_check'",
      ),
    )) as unknown as Array<{ def: string }>;
    expect(audits[0]?.def).toContain("worker.fleet.retired");
    expect(audits[0]?.def).toContain("worker.fleet.reinstated");
    expect(audits[0]?.def).toContain("tool.approval.consumed"); // the union, not a rewrite
  });

  it("PROBER + READINESS: the failure class is durable and readiness reads it after a restart", async () => {
    const first = await restart();
    await first.boot();
    await first.prober().probeAll();

    const cold = await restart();
    const nvidia = (await cold.store.get(
      candidateWorkerId("nvidia/nvidia/nemotron-3-ultra-550b-a55b"),
    ))!;
    expect(nvidia.lastProbeOutcome).toBe("failed");
    expect(nvidia.lastProbeErrorClass).toBe("NOT_CONFIGURED");
    expect((await cold.store.get(SONNET))!.lastProbeErrorClass).toBeNull();

    const readiness = await readFleetReadiness(cold.db.db, new Date());
    const byProvider = Object.fromEntries(readiness.providers.map((p) => [p.provider, p]));
    expect(byProvider.nvidia).toMatchObject({ active: 1, routable: 0, notConfigured: 1 });
    expect(byProvider.claude).toMatchObject({ active: 2, routable: 2 });
    expect(byProvider.codex!.failing.UNAVAILABLE).toBe(1);

    /* THE agreement the self-model lacked: readiness == what the router would route to. */
    const routed = await cold.router.route({ requiredCapabilities: ["code_editing"] });
    const eligible = routed.candidates.filter((c) => c.eligible).length;
    expect(readiness.total.routable).toBe(eligible);
  });

  it("RETIREMENT: a failing orphan is retired once with an audit row, then reinstated when listed again", async () => {
    const since = new Date().toISOString();
    const a = await restart();
    await a.boot();
    await a.prober().probeAll();

    const b = await restart();
    expect((await b.boot(SERVED.filter((m) => m !== GONE_MODEL))).retired).toEqual([GONE]);
    /* Idempotent across restarts. */
    const c = await restart();
    expect((await c.boot(SERVED.filter((m) => m !== GONE_MODEL))).retired).toEqual([]);

    const retired = (await c.store.get(GONE))!;
    expect(retired.status).toBe("inactive");
    expect(retired.health).toBe("unknown");
    expect(retired.metadata.fleetRetirement).toBe("ORPHAN_NOT_LISTED");
    expect(await fleetAudit(c.audit, "worker.fleet.retired", since)).toHaveLength(1);

    const readiness = await readFleetReadiness(c.db.db, new Date());
    const codex = readiness.providers.find((p) => p.provider === "codex")!;
    expect(codex).toMatchObject({ active: 0, disabled: 1, routable: 0 });

    const d = await restart();
    expect((await d.boot()).reinstated).toEqual([GONE]);
    const back = (await d.store.get(GONE))!;
    expect(back.status).toBe("active");
    expect(back.lastProbeOutcome).toBe("never");
    expect(back.metadata.fleetRetirement).toBeUndefined();
    expect(await fleetAudit(d.audit, "worker.fleet.reinstated", since)).toHaveLength(1);

    /* And reinstated means declared again, not changed again: the next boot is a no-op. */
    const e = await restart();
    const next = await e.boot();
    expect(next.unchanged).toContain(GONE);
    expect(next.reinstated).toEqual([]);
  });
});

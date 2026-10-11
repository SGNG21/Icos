import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { capabilityFacts, type CapabilityFact } from "@/core/cognitive/self-model";
import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { scheduledJobs } from "@/server/database/schema";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { WorkerHealthProber } from "@/server/services/worker-registry/worker-health-prober";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import {
  applyComputeBootstrap,
  DEFAULT_COMPUTE_CAPABILITIES,
  planComputeBootstrap,
} from "@/server/workers/compute-bootstrap";

import { seedClientDirectory } from "./client-directory-seed";
import type { CognitionEngine } from "./cognition";
import {
  runtimeProbesFor,
  SCHEDULER_LIVENESS_HORIZON_MS,
  type CognitiveComposition,
} from "./index";
import { systemClock } from "./conversation-store";
import { PostgresCognitiveMemoryStore } from "./memory-store";
import { RuntimeSelfModel } from "./runtime-self-model";

/*
 * P0 AUTONOMY UNBLOCK — the live capability table, measured on a REAL PostgreSQL.
 *
 * Nothing here is declared: every state comes from the same probes the conversation and the
 * cockpit read, over durable rows written by the real fleet bootstrap, the real prober, the
 * real scheduler table and the real client seed. Test database only.
 */

const SERVED = [
  "claude/claude-sonnet-5",
  "claude/claude-opus-5",
  "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
];
const OPTIONS = { runtime: "binary" as const, capabilities: [...DEFAULT_COMPUTE_CAPABILITIES] };
const engine = { label: "test-engine" } as unknown as CognitionEngine;
const COMPOSED: CognitiveComposition = {
  resolverWired: true,
  knowledgeSources: {
    durableMemory: true,
    scopeFiltered: true,
    operational: true,
    currentState: true,
    realtime: false,
  },
  executionRiskGate: () => ({ enforced: true, policyVersion: "test" }),
};
const handles: DatabaseHandle[] = [];

async function open() {
  const handle = await createDatabase(TEST_DATABASE_URL);
  handles.push(handle);
  return handle.db;
}

/** Boots the fleet and probes it. `failing` providers answer with the given error. */
async function fleet(failing: Record<string, string>) {
  const db = await open();
  const store = new PostgresWorkerRegistryStore(db);
  const registration = new WorkerRegistrationService(store);
  await applyComputeBootstrap(
    registration,
    planComputeBootstrap({
      source: "https://gateway.invalid",
      listed: SERVED,
      existing: await store.list(),
      options: OPTIONS,
    }),
    { audit: new PostgresAuditRepository(db) },
  );
  await new WorkerHealthProber(store, registration, {
    selectProbe: (w) => ({
      probe: async () => {
        const error = failing[String(w.metadata.provider)];
        if (error) throw new Error(error);
        return { health: "healthy" as const, availability: "available" as const };
      },
    }),
  }).probeAll();
  return db;
}

async function schedulerCompleted(db: Awaited<ReturnType<typeof open>>, agoMs: number) {
  const at = new Date(Date.now() - agoMs);
  const id = randomUUID();
  await db.insert(scheduledJobs).values({
    id,
    kind: "probe_workers",
    payload: {},
    payloadHash: id,
    idempotencyKey: `liveness-${id}`,
    state: "succeeded",
    nextRunAt: at,
    completedAt: at,
  });
}

async function table(db: Awaited<ReturnType<typeof open>>, composition = COMPOSED) {
  const probes = runtimeProbesFor(db, engine, true, {} as NodeJS.ProcessEnv, composition);
  const facts = capabilityFacts(await new RuntimeSelfModel(probes).probe());
  return (key: string): CapabilityFact => facts.find((f) => f.key === key)!;
}

beforeEach(async () => {
  const db = await open();
  await db.execute(
    sql.raw(
      "TRUNCATE TABLE workers, scheduled_jobs, memory_entities, memory_records RESTART IDENTITY CASCADE",
    ),
  );
});

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

describe("live capability table (PostgreSQL)", () => {
  it("a credential-less provider makes compute PARTIAL and NAMED; delegation follows", async () => {
    const db = await fleet({ nvidia: "404 no active credentials for provider nvidia" });
    await schedulerCompleted(db, 30_000);
    const fact = await table(db);
    expect(fact("compute.providers").state).toBe("PARTIAL");
    expect(fact("compute.providers").evidence).toContain("nvidia 0/1 1 non configuré(s)");
    expect(fact("workforce.delegate").state).toBe("PARTIAL");
  });

  it("PROVIDER FAILURE (configured, down) is DEGRADED — never hidden as PARTIAL", async () => {
    const db = await fleet({
      nvidia: "404 no active credentials for provider nvidia",
      claude: "503 upstream unavailable",
    });
    await schedulerCompleted(db, 30_000);
    const fact = await table(db);
    expect(fact("compute.providers").state).toBe("NOT_CONNECTED");
    const partial = await fleet({ nvidia: "503 upstream unavailable" });
    expect((await table(partial))("compute.providers").state).toBe("DEGRADED");
  });

  it("a fully healthy fleet with a LIVE scheduler is READY; a dead scheduler withdraws it", async () => {
    const db = await fleet({});
    const fact = await table(db);
    /* No job completed within the horizon: nothing would recover a lost worker. */
    expect(fact("workforce.delegate").state).toBe("GOVERNED");
    expect(fact("mission.execute").state).toBe("NOT_CONNECTED");
    await schedulerCompleted(db, SCHEDULER_LIVENESS_HORIZON_MS + 60_000);
    expect((await table(db))("workforce.delegate").state).toBe("GOVERNED");
    await schedulerCompleted(db, 10_000);
    const live = await table(db);
    expect(live("compute.providers").state).toBe("READY");
    expect(live("workforce.delegate").state).toBe("READY");
    expect(live("mission.execute").state).toBe("AUTONOMOUS_BY_POLICY");
    const ungated = await table(db, { ...COMPOSED, executionRiskGate: undefined });
    expect(ungated("mission.execute").state).toBe("GOVERNED");
  });

  it("context.scope is NOT_CONFIGURED on an empty directory and READY once seeded", async () => {
    const db = await open();
    expect((await table(db))("context.scope").state).toBe("NOT_CONFIGURED");
    await seedClientDirectory(
      new PostgresCognitiveMemoryStore(db, systemClock),
      CURRENT_SINGLE_TENANT_ID,
    );
    const fact = (await table(db))("context.scope");
    expect(fact.state).toBe("READY");
    expect(fact.evidence).toMatch(/résolveur actif sur [1-9]\d* client/);
  });

  it("tools and realtime claim nothing without a live grant or a launchable executor", async () => {
    const db = await open();
    const fact = await table(db);
    expect(fact("tools.governed").state).toBe("NOT_CONNECTED");
    expect(fact("external.realtime").state).toBe("NOT_CONNECTED");
    expect(fact("knowledge.routing").state).toBe("PARTIAL");
    expect(fact("knowledge.routing").evidence).toContain("recherche web");
  });
});

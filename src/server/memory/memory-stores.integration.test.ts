import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MemoryPolicyError,
  MemorySecretRejectedError,
  MemoryTenantRequiredError,
  type HumanActor,
  type MemoryActor,
  type MissionMemoryInputRaw,
  type ProceduralObservationRaw,
  type BusinessMemoryInputRaw,
} from "@/core/memory";
import type { DatabaseHandle } from "@/server/database/client";
import { PostgresBusinessMemoryStore } from "./postgres-business-memory-store";
import { PostgresMissionMemoryStore } from "./postgres-mission-memory-store";
import { PostgresProceduralMemoryStore } from "./postgres-procedural-memory-store";
import { insertMission, OTHER_TENANT, openTestDb, resetMemory, TENANT } from "./testing/support";

const DAY = 86_400_000;
const T0 = new Date("2026-09-19T12:00:00.000Z");
const clock = { t: T0 };
const deps = { now: () => clock.t };

const sys: MemoryActor = { tenantId: TENANT, kind: "system", id: "icos-runtime", permissions: [] };
const agent: MemoryActor = { tenantId: TENANT, kind: "agent", id: "agent-cto", permissions: [] };
const human: HumanActor = { tenantId: TENANT, kind: "human", id: "user-1", permissions: [] };
const otherTenantSys: MemoryActor = { ...sys, tenantId: OTHER_TENANT };

let h: DatabaseHandle;
let mission: PostgresMissionMemoryStore;
let proc: PostgresProceduralMemoryStore;
let biz: PostgresBusinessMemoryStore;

beforeAll(() => {
  h = openTestDb();
  mission = new PostgresMissionMemoryStore(h.db, deps);
  proc = new PostgresProceduralMemoryStore(h.db, deps);
  biz = new PostgresBusinessMemoryStore(h.db, deps);
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  clock.t = T0;
  await resetMemory(h);
  await insertMission(h, "m1");
  await insertMission(h, "m2");
});

const count = async (table: string) =>
  Number((await h.db.execute(sql.raw(`select count(*)::int as n from ${table}`)))[0].n);

// ── Mission memory ───────────────────────────────────────────────────────────
const mInput = (over: Partial<MissionMemoryInputRaw> = {}): MissionMemoryInputRaw => ({
  missionId: "m1",
  kind: "result",
  title: "Build ok",
  summary: "The build succeeded",
  payload: { outcome: "success" },
  provenance: { sourceType: "execution_result", sourceId: "res-1" },
  occurredAt: "2026-09-19T11:00:00.000Z",
  confidence: { value: 1, basis: "observed" },
  ...over,
});

describe("mission memory", () => {
  it("stores structured provenance with a server-assigned recordedAt", async () => {
    const { entry, created } = await mission.append(sys, mInput());
    expect(created).toBe(true);
    expect(entry).toMatchObject({
      tenantId: TENANT,
      missionId: "m1",
      scope: "mission",
      kind: "result",
      sourceType: "execution_result",
      sourceId: "res-1",
      recordedByType: "system",
      recordedBy: "icos-runtime",
      occurredAt: "2026-09-19T11:00:00.000Z",
      recordedAt: T0.toISOString(),
      lastVerifiedAt: T0.toISOString(),
      staleAfter: null,
      expiresAt: null,
      confidence: 1,
      confidenceBasis: "observed",
      visibility: "tenant",
      payload: { outcome: "success" },
    });
  });

  it("is replay-safe: same source+kind returns the existing entry", async () => {
    const a = await mission.append(sys, mInput());
    clock.t = new Date(T0.getTime() + 1000);
    const b = await mission.append(sys, mInput({ summary: "changed on replay" }));
    expect(b.created).toBe(false);
    expect(b.entry.id).toBe(a.entry.id);
    expect(b.entry.summary).toBe("The build succeeded");
    expect(await count("mission_memory_entries")).toBe(1);
  });

  it("refuses any operation without tenant context", async () => {
    await expect(mission.append({ ...sys, tenantId: "" }, mInput())).rejects.toBeInstanceOf(
      MemoryTenantRequiredError,
    );
    await expect(
      mission.find(
        { ...sys, tenantId: "" },
        { missionId: "m1", includeSuperseded: false, limit: 10 },
      ),
    ).rejects.toBeInstanceOf(MemoryTenantRequiredError);
    expect(await count("mission_memory_entries")).toBe(0);
  });

  it("rejects secrets and stores nothing", async () => {
    await expect(
      mission.append(sys, mInput({ payload: { note: "Bearer abcdefghijklmnopqrstuvwxyz" } })),
    ).rejects.toBeInstanceOf(MemorySecretRejectedError);
    await expect(
      mission.append(sys, mInput({ summary: "key sk-abcdefghijklmnopqrstuvwx" })),
    ).rejects.toBeInstanceOf(MemorySecretRejectedError);
    expect(await count("mission_memory_entries")).toBe(0);
  });

  it("workers cannot forge provenance: agents only cite agent_report (<=0.7 declared)", async () => {
    await expect(mission.append(agent, mInput())).rejects.toBeInstanceOf(MemoryPolicyError);
    await expect(
      mission.append(
        agent,
        mInput({
          provenance: { sourceType: "agent_report", sourceId: "rep-1" },
          confidence: { value: 0.9, basis: "declared" },
        }),
      ),
    ).rejects.toBeInstanceOf(MemoryPolicyError);
    const ok = await mission.append(
      agent,
      mInput({
        provenance: { sourceType: "agent_report", sourceId: "rep-1" },
        confidence: { value: 0.6, basis: "declared" },
      }),
    );
    expect(ok.entry.recordedByType).toBe("agent");
    expect(ok.entry.recordedBy).toBe("agent-cto");
  });

  it("returns a chronological timeline scoped to one mission and tenant", async () => {
    await mission.append(
      sys,
      mInput({
        kind: "objective",
        provenance: { sourceType: "mission", sourceId: "m1" },
        occurredAt: "2026-09-19T09:00:00.000Z",
      }),
    );
    await mission.append(sys, mInput({ occurredAt: "2026-09-19T11:00:00.000Z" }));
    await mission.append(
      sys,
      mInput({
        kind: "error",
        provenance: { sourceType: "execution_result", sourceId: "res-0" },
        occurredAt: "2026-09-19T10:00:00.000Z",
      }),
    );
    await mission.append(
      sys,
      mInput({
        missionId: "m2",
        provenance: { sourceType: "execution_result", sourceId: "res-m2" },
      }),
    );
    await mission.append(
      otherTenantSys,
      mInput({ provenance: { sourceType: "execution_result", sourceId: "res-other" } }),
    );

    const all = await mission.find(sys, { missionId: "m1", includeSuperseded: false, limit: 10 });
    expect(all.entries.map((r) => r.entry.kind)).toEqual(["objective", "error", "result"]);
    expect(all.entries.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(all.stats).toMatchObject({
      matched: 3,
      returned: 3,
      denied: 0,
      expired: 0,
      inactive: 0,
    });

    const errors = await mission.find(sys, {
      missionId: "m1",
      kinds: ["error"],
      includeSuperseded: false,
      limit: 10,
    });
    expect(errors.entries).toHaveLength(1);

    const foreign = await mission.find(otherTenantSys, {
      missionId: "m1",
      includeSuperseded: false,
      limit: 10,
    });
    expect(foreign.entries.map((r) => r.entry.sourceId)).toEqual(["res-other"]);
  });

  it("filters by task scope", async () => {
    await mission.append(
      sys,
      mInput({
        missionTaskId: "mt-1",
        provenance: { sourceType: "execution_result", sourceId: "r-t1" },
      }),
    );
    await mission.append(
      sys,
      mInput({
        missionTaskId: "mt-2",
        provenance: { sourceType: "execution_result", sourceId: "r-t2" },
      }),
    );
    const res = await mission.find(sys, {
      missionId: "m1",
      missionTaskId: "mt-1",
      includeSuperseded: false,
      limit: 10,
    });
    expect(res.entries.map((r) => r.entry.sourceId)).toEqual(["r-t1"]);
    expect(res.entries[0].entry.scope).toBe("task");
  });

  it("supersession: corrected entries hide the original unless asked; cross-mission supersede is rejected", async () => {
    const a = await mission.append(sys, mInput());
    const b = await mission.append(
      sys,
      mInput({
        provenance: { sourceType: "review_decision", sourceId: "rev-1" },
        summary: "corrected",
        supersedesId: a.entry.id,
      }),
    );
    const visible = await mission.find(sys, {
      missionId: "m1",
      includeSuperseded: false,
      limit: 10,
    });
    expect(visible.entries.map((r) => r.entry.id)).toEqual([b.entry.id]);
    expect(visible.stats.inactive).toBe(1);
    const withHistory = await mission.find(sys, {
      missionId: "m1",
      includeSuperseded: true,
      limit: 10,
    });
    expect(withHistory.entries).toHaveLength(2);

    await expect(
      mission.append(
        sys,
        mInput({
          missionId: "m2",
          provenance: { sourceType: "system", sourceId: "x" },
          supersedesId: a.entry.id,
        }),
      ),
    ).rejects.toBeInstanceOf(MemoryPolicyError);
  });

  it("visibility is enforced in SQL: denied rows are counted, never returned", async () => {
    await mission.append(
      sys,
      mInput({
        provenance: { sourceType: "audit_entry", sourceId: "aud-1" },
        visibility: {
          visibility: "restricted",
          requiredPermission: "audit.read.full",
          ownerSubject: null,
        },
      }),
    );
    await mission.append(
      sys,
      mInput({ provenance: { sourceType: "execution_result", sourceId: "pub" } }),
    );
    const denied = await mission.find(agent, {
      missionId: "m1",
      includeSuperseded: false,
      limit: 10,
    });
    expect(denied.entries.map((r) => r.entry.sourceId)).toEqual(["pub"]);
    expect(denied.stats).toMatchObject({ matched: 2, returned: 1, denied: 1 });
    const allowed = await mission.find(
      { ...agent, permissions: ["audit.read.full"] },
      { missionId: "m1", includeSuperseded: false, limit: 10 },
    );
    expect(allowed.entries).toHaveLength(2);
  });

  it("getById does not leak entries from another tenant", async () => {
    const { entry } = await mission.append(sys, mInput());
    expect(await mission.getById(sys, entry.id)).toMatchObject({ id: entry.id });
    expect(await mission.getById(otherTenantSys, entry.id)).toBeNull();
  });

  it("respects the limit (matched > returned)", async () => {
    for (let i = 0; i < 3; i++) {
      await mission.append(
        sys,
        mInput({
          provenance: { sourceType: "execution_result", sourceId: `r${i}` },
          occurredAt: `2026-09-19T10:0${i}:00.000Z`,
        }),
      );
    }
    const res = await mission.find(sys, { missionId: "m1", includeSuperseded: false, limit: 2 });
    expect(res.entries.map((r) => r.entry.sourceId)).toEqual(["r0", "r1"]);
    expect(res.stats).toMatchObject({ matched: 3, returned: 2 });
  });
});

// ── Procedural memory ────────────────────────────────────────────────────────
const pObs = (over: Partial<ProceduralObservationRaw> = {}): ProceduralObservationRaw => ({
  kind: "strategy",
  scope: "capability",
  scopeKey: "website.build",
  signature: "website.build|hermes",
  title: "Build with hermes",
  summary: "hermes builds websites reliably",
  payload: { workerKind: "hermes" },
  outcome: "success",
  provenance: { sourceType: "execution_result", sourceId: "res-1" },
  missionId: "m1",
  occurredAt: "2026-09-19T11:00:00.000Z",
  ...over,
});
const src = (id: string) => ({ sourceType: "execution_result" as const, sourceId: id });

describe("procedural memory", () => {
  it("creates a candidate from an objective observation, with an evidence trail", async () => {
    const e = await proc.observe(sys, pObs());
    expect(e).toMatchObject({
      status: "candidate",
      occurrenceCount: 1,
      successCount: 1,
      failureCount: 0,
      scope: "capability",
      scopeKey: "website.build",
      sourceType: "execution_result",
      sourceId: "res-1",
      confidenceBasis: "derived",
      staleAfter: new Date(T0.getTime() + 30 * DAY).toISOString(),
      expiresAt: new Date(T0.getTime() + 180 * DAY).toISOString(),
    });
    expect(e.confidence).toBeCloseTo(2 / 3);
    const ev = await proc.listEvidence(sys, e.id);
    expect(ev).toEqual([
      expect.objectContaining({
        sourceType: "execution_result",
        sourceId: "res-1",
        missionId: "m1",
        outcome: "success",
      }),
    ]);
  });

  it("aggregates distinct observations, is idempotent on replay, and counters equal the evidence rows", async () => {
    const a = await proc.observe(sys, pObs());
    clock.t = new Date(T0.getTime() + DAY);
    await proc.observe(sys, pObs({ provenance: src("res-2") }));
    await proc.observe(sys, pObs({ provenance: src("res-3"), outcome: "failure" }));
    const replay = await proc.observe(sys, pObs({ provenance: src("res-2") }));
    expect(replay.id).toBe(a.id);
    expect(replay).toMatchObject({ occurrenceCount: 3, successCount: 2, failureCount: 1 });
    expect(replay.confidence).toBeCloseTo(3 / 5);
    expect(replay.lastVerifiedAt).toBe(clock.t.toISOString());
    expect(await count("procedural_memory_entries")).toBe(1);
    expect(await proc.listEvidence(sys, a.id)).toHaveLength(3);
  });

  it("concurrent observations of the same signature do not lose or duplicate updates", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => proc.observe(sys, pObs({ provenance: src(`c-${i}`) }))),
    );
    const found = await proc.find(sys, { statuses: ["candidate"], minConfidence: 0, limit: 10 });
    expect(found.entries).toHaveLength(1);
    expect(found.entries[0].entry).toMatchObject({ occurrenceCount: 12, successCount: 12 });
    expect(await count("procedural_memory_evidence")).toBe(12);
  });

  it("only the system derives procedural memory, from objective sources", async () => {
    await expect(
      proc.observe(agent, pObs({ provenance: { sourceType: "agent_report", sourceId: "r" } })),
    ).rejects.toBeInstanceOf(MemoryPolicyError);
    await expect(
      proc.observe(human, pObs({ provenance: { sourceType: "human_input", sourceId: "r" } })),
    ).rejects.toBeInstanceOf(MemoryPolicyError);
    await expect(
      proc.observe(sys, pObs({ provenance: { sourceType: "system", sourceId: "r" } })),
    ).rejects.toBeInstanceOf(MemoryPolicyError);
    expect(await count("procedural_memory_entries")).toBe(0);
  });

  it("rejects secrets and the reserved validated_remediation kind on observation", async () => {
    await expect(proc.observe(sys, pObs({ payload: { api_key: "x" } }))).rejects.toBeInstanceOf(
      MemorySecretRejectedError,
    );
    await expect(proc.observe(sys, pObs({ kind: "validated_remediation" }))).rejects.toThrow();
  });

  it("validation is human-only, needs human/review evidence, and cannot revive a deprecated entry", async () => {
    const e = await proc.observe(
      sys,
      pObs({ kind: "recovery_pattern", signature: "retry-with-backoff" }),
    );
    await expect(
      proc.validate(agent as never, e.id, { sourceType: "review_decision", sourceId: "rev-1" }),
    ).rejects.toBeInstanceOf(MemoryPolicyError);
    await expect(
      proc.validate(sys as never, e.id, { sourceType: "review_decision", sourceId: "rev-1" }),
    ).rejects.toBeInstanceOf(MemoryPolicyError);
    await expect(
      proc.validate(human, e.id, { sourceType: "execution_result" as never, sourceId: "x" }),
    ).rejects.toBeInstanceOf(MemoryPolicyError);

    const v = await proc.validate(human, e.id, {
      sourceType: "review_decision",
      sourceId: "rev-1",
    });
    expect(v).toMatchObject({
      status: "validated",
      validatedBy: "user-1",
      confidenceBasis: "validated",
    });
    expect(v.validatedAt).toBe(T0.toISOString());

    await proc.deprecate(human, e.id);
    await expect(
      proc.validate(human, e.id, { sourceType: "review_decision", sourceId: "rev-2" }),
    ).rejects.toBeInstanceOf(MemoryPolicyError);
  });

  it("records a validated remediation directly (human), always with evidence", async () => {
    const r = await proc.recordValidatedRemediation(human, {
      scope: "worker_kind",
      scopeKey: "hermes",
      signature: "hermes|WORKER_TIMEOUT",
      title: "Timeout remediation",
      summary: "Raise timeout to 900s and retry once",
      payload: { steps: ["raise-timeout", "retry"] },
      evidence: { sourceType: "review_decision", sourceId: "rev-9" },
      occurredAt: "2026-09-19T11:30:00.000Z",
    });
    expect(r).toMatchObject({
      kind: "validated_remediation",
      status: "validated",
      validatedBy: "user-1",
      sourceType: "review_decision",
      sourceId: "rev-9",
    });
    await expect(
      proc.recordValidatedRemediation(agent as never, {
        scope: "tenant",
        signature: "x",
        title: "t",
        summary: "s",
        payload: {},
        evidence: { sourceType: "human_input", sourceId: "h" },
        occurredAt: "2026-09-19T11:30:00.000Z",
      }),
    ).rejects.toBeInstanceOf(MemoryPolicyError);
  });

  it("retrieval is scoped: capability/worker filters include tenant-wide entries and exclude others", async () => {
    await proc.observe(sys, pObs()); // capability website.build
    await proc.observe(
      sys,
      pObs({
        scope: "capability",
        scopeKey: "website.qa",
        signature: "qa",
        provenance: src("r-qa"),
      }),
    );
    await proc.observe(
      sys,
      pObs({
        scope: "tenant",
        scopeKey: undefined,
        signature: "global-plan",
        kind: "successful_plan",
        provenance: src("r-g"),
      }),
    );
    await proc.observe(
      sys,
      pObs({ scope: "worker_kind", scopeKey: "hermes", signature: "w", provenance: src("r-w") }),
    );

    const cap = await proc.find(sys, {
      capability: "website.build",
      statuses: ["candidate", "validated"],
      minConfidence: 0,
      limit: 10,
    });
    expect(cap.entries.map((r) => r.entry.signature).sort()).toEqual([
      "global-plan",
      "website.build|hermes",
    ]);
    const worker = await proc.find(sys, {
      workerKind: "hermes",
      statuses: ["candidate"],
      minConfidence: 0,
      limit: 10,
    });
    expect(worker.entries.map((r) => r.entry.signature).sort()).toEqual(["global-plan", "w"]);
    const bySig = await proc.find(sys, {
      signature: "qa",
      statuses: ["candidate"],
      minConfidence: 0,
      limit: 10,
    });
    expect(bySig.entries).toHaveLength(1);
    const foreign = await proc.find(otherTenantSys, {
      statuses: ["candidate"],
      minConfidence: 0,
      limit: 10,
    });
    expect(foreign.entries).toHaveLength(0);
  });

  it("status and confidence filters: deprecated is hidden by default", async () => {
    const a = await proc.observe(sys, pObs());
    const b = await proc.observe(
      sys,
      pObs({ signature: "bad", provenance: src("r-b"), outcome: "failure" }),
    );
    await proc.deprecate(human, a.id);
    const def = await proc.find(sys, {
      statuses: ["candidate", "validated"],
      minConfidence: 0,
      limit: 10,
    });
    expect(def.entries.map((r) => r.entry.id)).toEqual([b.id]);
    expect(def.stats.inactive).toBe(1);
    const confident = await proc.find(sys, {
      statuses: ["candidate", "validated", "deprecated"],
      minConfidence: 0.5,
      limit: 10,
    });
    expect(confident.entries.map((r) => r.entry.id)).toEqual([a.id]);
  });

  it("freshness: stale is returned tagged and ranked last; expired is never returned", async () => {
    await proc.observe(sys, pObs({ signature: "old", provenance: src("r-old") }));
    clock.t = new Date(T0.getTime() + 20 * DAY);
    await proc.observe(sys, pObs({ signature: "new", provenance: src("r-new") }));
    clock.t = new Date(T0.getTime() + 35 * DAY); // old: stale (30d), new: fresh
    let res = await proc.find(sys, { statuses: ["candidate"], minConfidence: 0, limit: 10 });
    expect(res.entries.map((r) => [r.entry.signature, r.freshness])).toEqual([
      ["new", "fresh"],
      ["old", "stale"],
    ]);
    clock.t = new Date(T0.getTime() + 181 * DAY); // old expired (180d), new stale
    res = await proc.find(sys, { statuses: ["candidate"], minConfidence: 0, limit: 10 });
    expect(res.entries.map((r) => r.entry.signature)).toEqual(["new"]);
    expect(res.stats.expired).toBe(1);
  });

  it("ranks validated before candidate, then confidence", async () => {
    const a = await proc.observe(sys, pObs({ signature: "a", provenance: src("ra") }));
    const b = await proc.observe(sys, pObs({ signature: "b", provenance: src("rb") }));
    await proc.observe(sys, pObs({ signature: "b", provenance: src("rb2") })); // b: 2 successes > a
    await proc.validate(human, a.id, { sourceType: "human_input", sourceId: "u" });
    const res = await proc.find(sys, {
      statuses: ["candidate", "validated"],
      minConfidence: 0,
      limit: 10,
    });
    expect(res.entries.map((r) => r.entry.id)).toEqual([a.id, b.id]);
  });
});

// ── Business / user memory ───────────────────────────────────────────────────
const bInput = (over: Partial<BusinessMemoryInputRaw> = {}): BusinessMemoryInputRaw => ({
  kind: "preference",
  scope: "tenant",
  subjectKey: "brand.tone",
  summary: "Brand tone is warm",
  value: { tone: "warm" },
  provenance: { sourceType: "human_input", sourceId: "form-1" },
  occurredAt: "2026-09-19T11:00:00.000Z",
  confidence: { value: 1, basis: "declared" },
  ...over,
});

describe("user/business memory", () => {
  it("a human records an active version 1 with decision provenance", async () => {
    const e = await biz.record(human, bInput());
    expect(e).toMatchObject({
      status: "active",
      version: 1,
      decidedBy: "user-1",
      decidedAt: T0.toISOString(),
      scopeKey: "*",
      sourceType: "human_input",
      recordedByType: "human",
      recordedBy: "user-1",
      visibility: "tenant",
    });
    expect(e.staleAfter).toBe(new Date(T0.getTime() + 180 * DAY).toISOString());
    expect(e.expiresAt).toBeNull();
  });

  it("workers cannot write: record/approve/reject/retract are human-only; propose is the only worker path", async () => {
    await expect(biz.record(agent as never, bInput())).rejects.toBeInstanceOf(MemoryPolicyError);
    await expect(biz.record(sys as never, bInput())).rejects.toBeInstanceOf(MemoryPolicyError);
    // Même avec une provenance « cohérente » pour le worker, la voie directe reste fermée :
    const agentSource = bInput({
      provenance: { sourceType: "agent_report", sourceId: "rep-x" },
      confidence: { value: 0.5, basis: "declared" },
    });
    await expect(biz.record(agent as never, agentSource)).rejects.toThrow(/humain/);
    expect(await count("business_memory_entries")).toBe(0);
    const p = await biz.propose(
      agent,
      bInput({
        provenance: { sourceType: "agent_report", sourceId: "rep" },
        confidence: { value: 0.5, basis: "declared" },
      }),
    );
    expect(p).toMatchObject({
      status: "proposed",
      version: null,
      decidedBy: null,
      recordedByType: "agent",
    });
    await expect(biz.approve(agent as never, p.id)).rejects.toBeInstanceOf(MemoryPolicyError);
    await expect(biz.reject(sys as never, p.id)).rejects.toBeInstanceOf(MemoryPolicyError);
    await expect(biz.retract(agent as never, p.id)).rejects.toBeInstanceOf(MemoryPolicyError);
  });

  it("proposals are invisible to retrieval until a human approves them", async () => {
    const p = await biz.propose(
      agent,
      bInput({
        provenance: { sourceType: "agent_report", sourceId: "rep" },
        confidence: { value: 0.5, basis: "declared" },
      }),
    );
    expect((await biz.find(human, { limit: 10 })).entries).toHaveLength(0);
    expect((await biz.listProposals(human)).map((x) => x.id)).toEqual([p.id]);
    await expect(biz.listProposals(agent as never)).rejects.toBeInstanceOf(MemoryPolicyError);

    const active = await biz.approve(human, p.id);
    expect(active).toMatchObject({
      status: "active",
      version: 1,
      decidedBy: "user-1",
      recordedByType: "agent",
      recordedBy: "agent-cto",
    });
    expect((await biz.find(human, { limit: 10 })).entries.map((r) => r.entry.id)).toEqual([p.id]);
    await expect(biz.approve(human, p.id)).rejects.toBeInstanceOf(MemoryPolicyError); // not proposed anymore
  });

  it("agent proposals obey provenance and confidence policy", async () => {
    await expect(biz.propose(agent, bInput())).rejects.toBeInstanceOf(MemoryPolicyError);
    await expect(
      biz.propose(
        agent,
        bInput({
          provenance: { sourceType: "agent_report", sourceId: "r" },
          confidence: { value: 0.95, basis: "declared" },
        }),
      ),
    ).rejects.toBeInstanceOf(MemoryPolicyError);
  });

  it("new versions supersede the previous active one; history stays immutable", async () => {
    const v1 = await biz.record(human, bInput());
    clock.t = new Date(T0.getTime() + 1000);
    const v2 = await biz.record(
      human,
      bInput({
        value: { tone: "formal" },
        provenance: { sourceType: "human_input", sourceId: "form-2" },
      }),
    );
    expect(v2).toMatchObject({ version: 2, status: "active", supersedesId: v1.id });
    const rows =
      await h.sql`select id, status, version from business_memory_entries order by version`;
    expect(rows.map((r) => [r.status, r.version])).toEqual([
      ["superseded", 1],
      ["active", 2],
    ]);
    const found = await biz.find(human, { limit: 10 });
    expect(found.entries.map((r) => r.entry.value)).toEqual([{ tone: "formal" }]);
    expect(found.stats.inactive).toBe(1);
  });

  it("concurrent records on one subject serialize: versions 1..n, exactly one active", async () => {
    await Promise.all(
      [1, 2, 3, 4].map((i) =>
        biz.record(
          human,
          bInput({
            value: { n: i },
            provenance: { sourceType: "human_input", sourceId: `f-${i}` },
          }),
        ),
      ),
    );
    const rows = await h.sql`select status, version from business_memory_entries order by version`;
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
  });

  it("reject and retract are terminal", async () => {
    const p = await biz.propose(
      agent,
      bInput({
        provenance: { sourceType: "agent_report", sourceId: "r" },
        confidence: { value: 0.4, basis: "declared" },
      }),
    );
    expect(await biz.reject(human, p.id)).toMatchObject({
      status: "rejected",
      decidedBy: "user-1",
    });
    await expect(biz.approve(human, p.id)).rejects.toBeInstanceOf(MemoryPolicyError);

    const a = await biz.record(human, bInput({ subjectKey: "x.y" }));
    expect(await biz.retract(human, a.id)).toMatchObject({ status: "retracted" });
    expect((await biz.find(human, { limit: 10 })).entries).toHaveLength(0);
    await expect(biz.retract(human, a.id)).rejects.toBeInstanceOf(MemoryPolicyError);
  });

  it("user-scoped memory is private to its owner by default", async () => {
    await biz.record(
      human,
      bInput({
        scope: "user",
        scopeKey: "user-1",
        subjectKey: "ui.density",
        value: { density: "compact" },
      }),
    );
    const other: MemoryActor = { ...human, id: "user-2" };
    expect((await biz.find(human, { limit: 10 })).entries).toHaveLength(1);
    const denied = await biz.find(other, { limit: 10 });
    expect(denied.entries).toHaveLength(0);
    expect(denied.stats.denied).toBe(1);
    expect((await biz.find(agent, { limit: 10 })).entries).toHaveLength(0);
    expect(
      (await biz.find({ ...agent, onBehalfOfUserId: "user-1" }, { limit: 10 })).entries,
    ).toHaveLength(1);
  });

  it("filters by scope, subject prefix and kind; enforces tenant isolation", async () => {
    await biz.record(human, bInput({ subjectKey: "brand.tone" }));
    await biz.record(
      human,
      bInput({
        subjectKey: "brand.colors",
        kind: "guideline",
        provenance: { sourceType: "human_input", sourceId: "f2" },
      }),
    );
    await biz.record(
      human,
      bInput({
        subjectKey: "legal.terms",
        kind: "constraint",
        provenance: { sourceType: "human_input", sourceId: "f3" },
      }),
    );
    const brand = await biz.find(human, { subjectKeyPrefix: "brand.", limit: 10 });
    expect(brand.entries.map((r) => r.entry.subjectKey)).toEqual(["brand.colors", "brand.tone"]);
    const constraints = await biz.find(human, { kinds: ["constraint"], limit: 10 });
    expect(constraints.entries).toHaveLength(1);
    expect(
      (await biz.find({ ...human, tenantId: OTHER_TENANT }, { limit: 10 })).entries,
    ).toHaveLength(0);
  });

  it("rejects secrets in value/summary", async () => {
    await expect(biz.record(human, bInput({ value: { password: "x" } }))).rejects.toBeInstanceOf(
      MemorySecretRejectedError,
    );
    await expect(
      biz.record(human, bInput({ summary: "use postgres://u:p@h/db" })),
    ).rejects.toBeInstanceOf(MemorySecretRejectedError);
    expect(await count("business_memory_entries")).toBe(0);
  });
});

// ── Separation ───────────────────────────────────────────────────────────────
describe("mission / procedural / business separation", () => {
  it("each memory writes only its own tables and never leaks into another retrieval", async () => {
    await mission.append(sys, mInput());
    expect([
      await count("mission_memory_entries"),
      await count("procedural_memory_entries"),
      await count("business_memory_entries"),
    ]).toEqual([1, 0, 0]);
    await proc.observe(sys, pObs());
    expect([
      await count("mission_memory_entries"),
      await count("procedural_memory_entries"),
      await count("business_memory_entries"),
    ]).toEqual([1, 1, 0]);
    await biz.record(human, bInput());
    expect([
      await count("mission_memory_entries"),
      await count("procedural_memory_entries"),
      await count("business_memory_entries"),
    ]).toEqual([1, 1, 1]);

    const m = await mission.find(sys, { missionId: "m1", includeSuperseded: false, limit: 50 });
    const p = await proc.find(sys, {
      statuses: ["candidate", "validated"],
      minConfidence: 0,
      limit: 50,
    });
    const b = await biz.find(sys, { limit: 50 });
    expect(m.entries.map((r) => r.entry.kind)).toEqual(["result"]);
    expect(p.entries.map((r) => r.entry.kind)).toEqual(["strategy"]);
    expect(b.entries.map((r) => r.entry.kind)).toEqual(["preference"]);
  });
});

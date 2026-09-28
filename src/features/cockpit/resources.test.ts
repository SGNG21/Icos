import { describe, expect, it } from "vitest";

import type { AuditEntry } from "@/core/contracts";

import { AUDIT_PAGE_SIZE, queryAudit } from "./audit-view";
import { UNDECLARED, buildResourceTree } from "./resources";
import type { WorkerView } from "./snapshot";
import { missing, real } from "./truth";

function view(id: string, meta: { provider?: string; account?: string; model?: string }, pool?: { name: string; limit: number | null }, used = 1): WorkerView {
  const t = (v?: string) => (v ? real(v) : missing<string>("not_available", "none", "BR-03"));
  return {
    id,
    name: id,
    kind: "hermes",
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
    status: "active",
    health: "healthy",
    availability: "available",
    probe: { outcome: "ok", at: null, ageMs: null },
    model: t(meta.model),
    provider: t(meta.provider),
    account: t(meta.account),
    slots: { used: real(used), max: 3 },
    pool: pool ?? null,
    capabilities: [],
    features: [],
    tags: [],
    metadata: {},
    assignments: [],
    tone: "ok",
    routable: true,
  };
}

describe("buildResourceTree", () => {
  it("nests provider › account › model without merging concepts", () => {
    const { providers } = buildResourceTree([
      view("w1", { provider: "nvidia", account: "A", model: "nemotron" }),
      view("w2", { provider: "nvidia", account: "A", model: "nemotron" }),
      view("w3", { provider: "nvidia", account: "B", model: "nemotron" }),
      view("w4", {}),
    ]);
    expect(providers.map((p) => p.provider)).toEqual(["nvidia", UNDECLARED]);
    expect(providers[0].accounts.map((a) => a.account)).toEqual(["A", "B"]);
    expect(providers[0].accounts[0].models[0].workers.map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(providers[1]).toMatchObject({ declared: false, workerCount: 1 });
  });

  it("aggregates shared capacity pools with the smallest limit", () => {
    const { pools } = buildResourceTree([
      view("w1", {}, { name: "nv-quota", limit: 3 }, 1),
      view("w2", {}, { name: "nv-quota", limit: 2 }, 1),
      view("w3", {}),
    ]);
    expect(pools).toEqual([{ pool: "nv-quota", limit: 2, used: expect.objectContaining({ value: 2 }), workers: ["w1", "w2"] }]);
  });

  it("keeps pool load UNKNOWN when a member's load is unknown", () => {
    const w = { ...view("w1", {}, { name: "p", limit: null }), slots: { used: missing<number>("unknown", "x"), max: 1 } };
    expect(buildResourceTree([w]).pools[0].used.kind).toBe("unknown");
  });
});

describe("queryAudit", () => {
  const e = (id: string, at: string, type: string, kind: "human" | "system", taskId?: string) =>
    ({ id, occurredAt: at, createdAt: at, eventType: type, actor: { kind, id: kind }, taskId, details: {} }) as AuditEntry;
  const entries = [
    e("1", "2026-09-28T10:00:00Z", "task.created", "human", "t1"),
    e("2", "2026-09-28T11:00:00Z", "auth.access.denied", "system"),
    e("3", "2026-09-28T12:00:00Z", "task.transitioned", "system", "t2"),
  ];

  it("orders newest first and filters by type, actor, task and mission", () => {
    expect(queryAudit(entries, {}).rows.map((r) => r.id)).toEqual(["3", "2", "1"]);
    expect(queryAudit(entries, { actorKind: "human" }).rows.map((r) => r.id)).toEqual(["1"]);
    expect(queryAudit(entries, { missionTaskIds: new Set(["t2"]) }).rows.map((r) => r.id)).toEqual(["3"]);
    expect(queryAudit(entries, { tone: "critical" }).rows.map((r) => r.id)).toEqual(["2"]);
    expect(queryAudit(entries, {}).eventTypes).toEqual(["auth.access.denied", "task.created", "task.transitioned"]);
  });

  it("paginates large timelines and clamps the page", () => {
    const many = Array.from({ length: 1234 }, (_, i) => e(String(i), new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), "task.created", "system"));
    const out = queryAudit(many, { page: 99 });
    expect(out.pages).toBe(Math.ceil(1234 / AUDIT_PAGE_SIZE));
    expect(out.page).toBe(out.pages);
    expect(out.rows.length).toBe(1234 % AUDIT_PAGE_SIZE);
    expect(queryAudit(many, { page: 1 }).rows[0].id).toBe("1233");
  });
});

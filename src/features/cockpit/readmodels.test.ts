import { describe, expect, it } from "vitest";

import { buildBusinessView, notConnectedBusiness, parseBusiness } from "./business";
import type { Truth } from "./truth";
import {
  buildWorkforceView,
  notConnectedWorkforce,
  parseWorkforce,
  workforceView,
} from "./workforce";

const NOW = new Date("2026-09-30T12:00:00Z");
const value = <T>(t: Truth<T>): T => {
  if (t.kind !== "real") throw new Error(`expected REAL, got ${t.kind}`);
  return t.value;
};
const human = { kind: "human", id: "owner" };
const agent = (id: string, over: Record<string, unknown> = {}) => ({
  agentId: id,
  tenantId: "t",
  kind: "DURABLE_AGENT",
  roleId: "SALES_DIRECTOR",
  roleVersion: "1.0.0",
  displayName: id,
  departmentId: "sales",
  supervisorAgentId: "central",
  parentAgentId: null,
  depth: 1,
  scope: { clientIds: ["*"], projectIds: [] },
  memoryScope: { read: ["sales"], write: [] },
  policy: {
    autonomyLevel: 1,
    toolGrants: [
      {
        toolId: "crm.read",
        grantedBy: human,
        grantedAt: "2026-09-01T00:00:00Z",
        expiresAt: "2026-10-03T00:00:00Z",
      },
      {
        toolId: "mail.send",
        grantedBy: human,
        grantedAt: "2026-09-01T00:00:00Z",
        expiresAt: "2026-09-29T00:00:00Z",
      },
    ],
    budget: { computeUnits: 100, financialCents: 5_000 },
    bounds: { maxDepth: 3, maxDescendants: 5, maxConcurrentAssignments: 2 },
  },
  kpis: [{ kpiId: "pipeline.value", description: "Pipeline value", target: "100k" }],
  status: "active",
  ...over,
});
const projection = {
  agents: [
    agent("a1"),
    agent("a2", { status: "suspended" }),
    agent("a3", {
      kind: "EPHEMERAL_SPECIALIST",
      expiresAt: "2026-09-30T11:00:00Z",
      memoryScope: { read: [], write: ["seo"] },
    }),
  ],
  departments: [{ departmentId: "sales", name: "Sales" }],
  roles: [{ roleId: "SALES_DIRECTOR", version: "1.0.0", status: "active", kpis: [] }],
  skills: [
    { skillId: "LEAD_SCORING", status: "active" },
    { skillId: "OLD", status: "retired" },
  ],
  assignments: [
    {
      assignmentId: "as-1",
      assigneeAgentId: "a1",
      status: "assigned",
      approval: { required: true, reasons: [] },
    },
    {
      assignmentId: "as-2",
      assigneeAgentId: "a1",
      status: "changes_requested",
      approval: { required: false, reasons: [] },
    },
  ],
  performance: null,
};

describe("workforce read model", () => {
  it("is NOT_CONNECTED until wired, and a malformed projection is UNKNOWN", async () => {
    expect((await notConnectedWorkforce.read()).kind).toBe("not_connected");
    expect(parseWorkforce({ agents: "nope" }).kind).toBe("unknown");
    expect(workforceView(await notConnectedWorkforce.read(), NOW).kind).toBe("not_connected");
  });

  it("summarizes agents, grants, budgets, autonomy, memory scopes and attention without inventing", () => {
    const v = buildWorkforceView(value(parseWorkforce(projection)), NOW);
    expect(v.agents).toMatchObject({ total: 3, byStatus: { active: 2, suspended: 1 } });
    expect(v.budgets).toEqual({ computeUnits: 300, financialCents: 15_000 });
    expect(v.autonomy).toEqual({ L1: 3 });
    expect(v.toolGrants).toEqual({ total: 6, expiringWithin7d: 3, expired: 3 });
    expect(v.memoryScopes).toEqual({ agentsWithRead: 2, agentsWithWrite: 1, namespaces: 2 });
    expect(v.skills).toEqual({ active: 1, total: 2 });
    expect(v.assignments.awaitingApproval).toBe(1);
    expect(v.attention.map((a) => a.reason).sort()).toEqual([
      "agent suspended",
      "changes_requested",
      "specialist past its expiry",
    ]);
    expect(v.kpis.defined).toBe(3);
    expect(v.kpis.measured.kind).toBe("not_available"); // targets are not measurements
    expect(v.performance.kind).toBe("unknown"); // no observation is not a 0% success rate
  });
});

describe("business read model", () => {
  it("is NOT_CONNECTED until a source exists", async () => {
    expect((await notConnectedBusiness.read()).kind).toBe("not_connected");
    expect(parseBusiness({}).kind).toBe("unknown");
  });

  it("shows REAL facts only; SIMULATED / NOT_CONNECTED rows are withheld and counted", () => {
    const asOf = "2026-09-30T00:00:00Z";
    const m = parseBusiness({
      clients: [
        { clientId: "lds", name: "LDS Renov", status: "at_risk", source: "REAL", asOf },
        { clientId: "demo", name: "Demo", status: "active", source: "SIMULATED", asOf },
      ],
      leads: [{ leadId: "l1", clientId: "lds", stage: "new", source: "NOT_CONNECTED", asOf }],
      pipeline: [
        {
          stage: "proposal",
          count: 2,
          valueCents: 1_000_000,
          currency: "EUR",
          source: "REAL",
          asOf,
        },
      ],
      marketing: [
        {
          channel: "seo",
          metric: "clicks",
          value: 120,
          unit: "count",
          period: "7d",
          source: "REAL",
          asOf,
        },
        {
          channel: "tiktok-ads",
          metric: "spend",
          value: 50,
          unit: "EUR",
          period: "7d",
          source: "REAL",
          asOf,
        },
        {
          channel: "ads",
          metric: "cpc",
          value: 1,
          unit: "EUR",
          period: "7d",
          source: "SIMULATED",
          asOf,
        },
      ],
      kpis: [],
    });
    const v = buildBusinessView(value(m));
    expect(v.clients).toMatchObject({ withheld: 1 });
    expect(v.clients.rows.map((c) => c.clientId)).toEqual(["lds"]);
    expect(v.atRiskClients).toBe(1);
    expect(v.leads).toEqual({ rows: [], withheld: 1 });
    expect(Object.keys(v.marketingByChannel).sort()).toEqual(["seo", "tiktok-ads"]); // open channel set
    expect(v.marketingWithheld).toBe(1);
  });
});

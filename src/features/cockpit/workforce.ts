import { z } from "zod";

import { isReal, missing, real, type Truth } from "./truth";

/**
 * Digital Workforce — cockpit READ model (lane D, committed on feat/digital-workforce:
 * `src/core/workforce/contracts.ts`, `WorkforceService.listAgents/listAssignments/listEvents/
 * performance`, store `listDepartments/listRoles/listSkills`). Structural subset, parsed
 * defensively (extra keys pass). The cockpit has NO mutation path to the workforce: every
 * change (policy, status, delegation, approval) stays a WorkforceService call behind its own
 * governance. Until the projection is wired the port answers NOT_CONNECTED.
 */

const actor = z.object({ kind: z.string(), id: z.string() }).passthrough();
const kpi = z.object({ kpiId: z.string(), description: z.string(), target: z.string().optional() });

export const workforceAgentSchema = z
  .object({
    agentId: z.string(),
    kind: z.string(),
    roleId: z.string(),
    roleVersion: z.string(),
    displayName: z.string(),
    departmentId: z.string().nullable(),
    supervisorAgentId: z.string().nullable(),
    depth: z.number(),
    memoryScope: z.object({ read: z.array(z.string()), write: z.array(z.string()) }),
    policy: z.object({
      autonomyLevel: z.number(),
      toolGrants: z.array(
        z
          .object({ toolId: z.string(), grantedBy: actor, expiresAt: z.string().optional() })
          .passthrough(),
      ),
      budget: z.object({ computeUnits: z.number(), financialCents: z.number() }),
    }),
    kpis: z.array(kpi).default([]),
    expiresAt: z.string().optional(),
    status: z.string(),
  })
  .passthrough();
export type WorkforceAgentFact = z.infer<typeof workforceAgentSchema>;

export const workforceProjectionSchema = z.object({
  agents: z.array(workforceAgentSchema),
  departments: z.array(z.object({ departmentId: z.string(), name: z.string() }).passthrough()),
  roles: z.array(
    z
      .object({
        roleId: z.string(),
        version: z.string(),
        status: z.string(),
        kpis: z.array(kpi).default([]),
      })
      .passthrough(),
  ),
  skills: z.array(
    z.object({ skillId: z.string(), status: z.string().default("active") }).passthrough(),
  ),
  assignments: z.array(
    z
      .object({
        assignmentId: z.string(),
        assigneeAgentId: z.string(),
        status: z.string(),
        approval: z
          .object({ required: z.boolean(), approvedAt: z.string().optional() })
          .passthrough(),
      })
      .passthrough(),
  ),
  /** `summarizePerformance` output (REAL observations only); null when not requested. */
  performance: z
    .object({
      count: z.number(),
      successRate: z.number().nullable(),
      firstPassApprovals: z.number(),
      meanCorrections: z.number().nullable(),
      meanLatencyMs: z.number().nullable(),
      totalCostCents: z.number().nullable(),
    })
    .passthrough()
    .nullable(),
});
export type WorkforceProjection = z.infer<typeof workforceProjectionSchema>;

/** Read port the integrator wires to WorkforceService (server side, with the caller's principal). */
export interface WorkforceReadPort {
  read(): Promise<Truth<WorkforceProjection>>;
}

export const notConnectedWorkforce: WorkforceReadPort = {
  read: async () =>
    missing(
      "not_connected",
      "Digital Workforce (lane D) has no read projection wired into this build.",
      "BR-29",
    ),
};

/** Parse whatever the integration hands over; a malformed projection is UNKNOWN, never guessed. */
export function parseWorkforce(raw: unknown): Truth<WorkforceProjection> {
  const parsed = workforceProjectionSchema.safeParse(raw);
  return parsed.success
    ? real(parsed.data)
    : missing("unknown", "The workforce projection did not match the expected read contract.");
}

const count = <T>(xs: readonly T[], key: (x: T) => string) =>
  xs.reduce<Record<string, number>>((m, x) => ({ ...m, [key(x)]: (m[key(x)] ?? 0) + 1 }), {});

const WEEK_MS = 7 * 86_400_000;
const TERMINAL_AGENT = new Set(["retired", "blocked"]);

export interface WorkforceView {
  agents: { total: number; byStatus: Record<string, number>; byKind: Record<string, number> };
  departments: number;
  roles: { total: number; byStatus: Record<string, number> };
  skills: { active: number; total: number };
  assignments: { byStatus: Record<string, number>; awaitingApproval: number };
  /** Budgets / autonomy / grants / memory scopes cover live (non-terminal) agents only. */
  budgets: { computeUnits: number; financialCents: number };
  autonomy: Record<string, number>;
  toolGrants: { total: number; expiringWithin7d: number; expired: number };
  memoryScopes: { agentsWithRead: number; agentsWithWrite: number; namespaces: number };
  /** Workforce defines KPI TARGETS; measured values are not part of its contract. */
  kpis: { defined: number; measured: Truth<number> };
  performance: Truth<NonNullable<WorkforceProjection["performance"]>>;
  /** Needs a human now: suspended agents, bounced assignments, specialists past expiry (terminal states excluded). */
  attention: { id: string; label: string; reason: string }[];
}

export function buildWorkforceView(p: WorkforceProjection, now: Date): WorkforceView {
  const t = now.getTime();
  // Terminal agents (retired, blocked) and terminal assignments (blocked, synthesized) are
  // history in lane D's contract: no transition leaves them, so they are neither live totals
  // nor something a human can act on.
  const live = p.agents.filter((a) => !TERMINAL_AGENT.has(a.status));
  const grants = live.flatMap((a) => a.policy.toolGrants);
  const exp = (g: (typeof grants)[number]) => (g.expiresAt ? Date.parse(g.expiresAt) : Infinity);
  const attention = [
    ...p.agents
      .filter((a) => a.status === "suspended")
      .map((a) => ({ id: a.agentId, label: a.displayName, reason: "agent suspended" })),
    ...p.agents
      .filter((a) => a.status === "active" && a.expiresAt && Date.parse(a.expiresAt) <= t)
      .map((a) => ({ id: a.agentId, label: a.displayName, reason: "specialist past its expiry" })),
    ...p.assignments
      .filter((x) => x.status === "changes_requested")
      .map((x) => ({
        id: x.assignmentId,
        label: `assignment ${x.assignmentId.slice(0, 8)}`,
        reason: x.status,
      })),
  ];
  const namespaces = new Set(live.flatMap((a) => [...a.memoryScope.read, ...a.memoryScope.write]));
  return {
    agents: {
      total: p.agents.length,
      byStatus: count(p.agents, (a) => a.status),
      byKind: count(p.agents, (a) => a.kind),
    },
    departments: p.departments.length,
    roles: { total: p.roles.length, byStatus: count(p.roles, (r) => r.status) },
    skills: {
      active: p.skills.filter((s) => s.status === "active").length,
      total: p.skills.length,
    },
    assignments: {
      byStatus: count(p.assignments, (x) => x.status),
      // Approval gates only a not-yet-started assignment.
      awaitingApproval: p.assignments.filter(
        (x) => x.status === "assigned" && x.approval.required && !x.approval.approvedAt,
      ).length,
    },
    budgets: live.reduce(
      (b, a) => ({
        computeUnits: b.computeUnits + a.policy.budget.computeUnits,
        financialCents: b.financialCents + a.policy.budget.financialCents,
      }),
      { computeUnits: 0, financialCents: 0 },
    ),
    autonomy: count(live, (a) => `L${a.policy.autonomyLevel}`),
    toolGrants: {
      total: grants.length,
      expiringWithin7d: grants.filter((g) => exp(g) > t && exp(g) - t <= WEEK_MS).length,
      expired: grants.filter((g) => exp(g) <= t).length,
    },
    memoryScopes: {
      agentsWithRead: live.filter((a) => a.memoryScope.read.length > 0).length,
      agentsWithWrite: live.filter((a) => a.memoryScope.write.length > 0).length,
      namespaces: namespaces.size,
    },
    kpis: {
      defined: live.reduce((n, a) => n + a.kpis.length, 0),
      measured: missing(
        "not_available",
        "The workforce contract defines KPI targets, not measurements.",
      ),
    },
    performance:
      p.performance && p.performance.count > 0
        ? real(
            p.performance,
            "as reported by WorkforceService.performance() (REAL-only by default)",
          )
        : missing("unknown", "No performance observation recorded yet."),
    attention,
  };
}

export const workforceView = (t: Truth<WorkforceProjection>, now: Date): Truth<WorkforceView> =>
  isReal(t) ? real(buildWorkforceView(t.value, now)) : (t as Truth<WorkforceView>);

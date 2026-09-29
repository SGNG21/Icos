import type { AuditEntry } from "@/core/contracts";

import type { Alert, CockpitSnapshot, MissionSummary } from "./snapshot";
import { isReal, mapTruth, missing, real, type Truth } from "./truth";

/**
 * Executive / business read model. Objectives, milestones, blockers, workforce
 * and autonomous actions are derived from canonical mission, worker and audit
 * state. Business data ICOS does not hold (clients, projects, KPIs, the digital
 * workforce, proposals) is an explicit NOT_CONNECTED contract, never invented.
 */
export interface ExecutiveView {
  objectives: Truth<
    Pick<
      MissionSummary,
      | "id"
      | "title"
      | "objective"
      | "status"
      | "progressPct"
      | "completed"
      | "total"
      | "remainingCriticalPath"
      | "tone"
    >[]
  >;
  blockers: Truth<{ id: string; title: string; href?: string }[]>;
  workforce: Truth<{ total: number; routable: number; busy: number }>;
  autonomousActions24h: Truth<number>;
  humanActions24h: Truth<number>;
  /** Owned by other lanes / backends; the cockpit only declares the slot. */
  proposals: Truth<number>;
  digitalWorkforce: Truth<number>;
  clients: Truth<number>;
  kpis: Truth<number>;
}

const ACTIVE = new Set(["planning", "ready", "running", "blocked", "awaiting_approval"]);
const DAY_MS = 86_400_000;

export function buildExecutiveView(
  snapshot: CockpitSnapshot,
  audit: Truth<AuditEntry[]>,
): ExecutiveView {
  const objectives = mapTruth(snapshot.missions, (ms) =>
    ms
      .filter((m) => ACTIVE.has(m.status))
      .map(
        ({
          id,
          title,
          objective,
          status,
          progressPct,
          completed,
          total,
          remainingCriticalPath,
          tone,
        }) => ({
          id,
          title,
          objective,
          status,
          progressPct,
          completed,
          total,
          remainingCriticalPath,
          tone,
        }),
      ),
  );

  const blocking = (a: Alert) => a.severity === "P0" || a.category === "MISSION";
  const blockers = mapTruth(snapshot.missions, (ms) => [
    ...ms
      .filter((m) => m.attention)
      .map((m) => ({
        id: `mission-${m.id}`,
        title: `${m.title} — ${m.status.replace("_", " ")}`,
        href: `/cockpit/missions/${m.id}`,
      })),
    ...snapshot.alerts
      .filter(blocking)
      .filter((a) => !a.href?.startsWith("/cockpit/missions/"))
      .map((a) => ({ id: a.id, title: a.title, href: a.href })),
  ]);

  const workforce = mapTruth(snapshot.workers, (ws) => ({
    total: ws.length,
    routable: ws.filter((w) => w.routable).length,
    busy: ws.filter((w) => w.assignments.length > 0).length,
  }));

  const since = Date.parse(snapshot.generatedAt) - DAY_MS;
  // The full audit source, not the capped timeline: a count must not be truncated.
  const byActor = (pred: (kind: string) => boolean, derivation: string): Truth<number> =>
    isReal(audit)
      ? real(
          audit.value.filter((e) => Date.parse(e.occurredAt) >= since && pred(e.actor.kind)).length,
          derivation,
        )
      : (audit as Truth<number>);

  return {
    objectives,
    blockers,
    workforce,
    autonomousActions24h: byActor(
      (k) => k !== "human",
      "audit entries by agent/system actors, 24h",
    ),
    humanActions24h: byActor((k) => k === "human", "audit entries by human actors, 24h"),
    proposals: missing(
      "not_connected",
      "Improvement proposals are persisted by the durable backlog on the CORE3/control branches, not integrated here.",
      "BR-08",
    ),
    digitalWorkforce: missing(
      "not_connected",
      "Digital Workforce / Mini-ICOS is another lane; no committed read contract yet.",
      "lane D",
    ),
    clients: missing(
      "not_connected",
      "ICOS holds no client/project records the cockpit can read.",
      "business OS",
    ),
    kpis: missing(
      "not_connected",
      "No business KPI source exists; none is estimated.",
      "business OS",
    ),
  };
}

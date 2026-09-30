import Link from "next/link";

import { MetricTile, Panel, ToneBadge, TruthValue } from "@/components/cockpit/primitives";
import { sectionTruth } from "@/features/cockpit/business";
import { buildExecutiveView } from "@/features/cockpit/executive";
import { loadReadModels, loadSnapshot, loadSources } from "@/features/cockpit/load";
import { mapTruth } from "@/features/cockpit/truth";

export const metadata = { title: "Executive" };

export default async function ExecutivePage() {
  const [snapshot, sources, models] = await Promise.all([
    loadSnapshot(),
    loadSources(),
    loadReadModels(),
  ]);
  if (!snapshot || !sources || !models) return null;
  const v = buildExecutiveView(snapshot, sources.audit, models.workforce, models.business);
  const wf = v.digitalWorkforce;
  const biz = v.business;

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Executive · business</p>
          <h1>What ICOS is delivering</h1>
        </div>
        <nav className="cx-modes" aria-label="Cockpit mode">
          <Link href="/cockpit">System</Link>
          <Link href="/cockpit/executive" aria-current="page">
            Executive
          </Link>
        </nav>
      </div>

      <div className="cx-metrics">
        <MetricTile label="Active objectives" truth={mapTruth(v.objectives, (o) => o.length)} />
        <MetricTile
          label="Blockers"
          truth={mapTruth(v.blockers, (b) => b.length)}
          tone={v.blockers.kind === "real" && v.blockers.value.length > 0 ? "critical" : "ok"}
        />
        <MetricTile
          label="Routable workforce"
          truth={mapTruth(v.workforce, (w) => `${w.routable}/${w.total}`)}
        />
        <MetricTile
          label="Agent/system actions 24h"
          truth={v.autonomousActions24h}
          tone="autonomy"
        />
        <MetricTile label="Human actions 24h" truth={v.humanActions24h} />
        <MetricTile label="ICOS proposals" truth={v.proposals} tone="autonomy" />
        <MetricTile
          label="Digital workforce agents (all registered)"
          truth={mapTruth(wf, (w) => w.agents.total)}
        />
        <MetricTile
          label="Workforce needing attention"
          truth={mapTruth(wf, (w) => w.attention.length)}
          tone={wf.kind === "real" && wf.value.attention.length > 0 ? "critical" : "ok"}
        />
        <MetricTile
          label="Assignments awaiting approval"
          truth={mapTruth(wf, (w) => w.assignments.awaitingApproval)}
        />
        <MetricTile
          label="Clients (at risk)"
          truth={sectionTruth(
            biz,
            (b) => b.clients,
            (rows) => `${rows.length} (${rows.filter((c) => c.status === "at_risk").length})`,
          )}
        />
        <MetricTile
          label="Leads"
          truth={sectionTruth(
            biz,
            (b) => b.leads,
            (rows) => rows.length,
          )}
        />
        <MetricTile
          label="Sales pipeline (deals)"
          truth={sectionTruth(
            biz,
            (b) => b.pipeline,
            (rows) => rows.reduce((n, s) => n + s.count, 0),
          )}
        />
        <MetricTile
          label="Marketing · SEO · Ads channels"
          truth={sectionTruth(
            biz,
            (b) => b.marketing,
            (rows) => new Set(rows.map((r) => r.channel)).size,
          )}
        />
        <MetricTile
          label="Business KPIs reported"
          truth={sectionTruth(
            biz,
            (b) => b.kpis,
            (rows) => rows.length,
          )}
        />
      </div>

      <div className="cx-grid2">
        <Panel title="Objectives & milestones" eyebrow="Active missions">
          {v.objectives.kind !== "real" ? (
            <TruthValue truth={v.objectives} />
          ) : v.objectives.value.length === 0 ? (
            <p className="cx-empty">No active mission.</p>
          ) : (
            <ul className="cx-list">
              {v.objectives.value.map((o) => (
                <li key={o.id}>
                  <Link href={`/cockpit/missions/${o.id}`}>
                    <strong>{o.title}</strong>
                  </Link>{" "}
                  <ToneBadge tone={o.tone} label={o.status.replace("_", " ")} size="sm" />
                  <p className="cx-dim">{o.objective}</p>
                  <p className="cx-dim">
                    Milestones {o.completed}/{o.total} ({o.progressPct}%) · critical path remaining{" "}
                    {o.remainingCriticalPath}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Blockers" eyebrow="What needs a decision">
          {v.blockers.kind !== "real" ? (
            <TruthValue truth={v.blockers} />
          ) : v.blockers.value.length === 0 ? (
            <p className="cx-empty">No blocker is known from mission state or alerts.</p>
          ) : (
            <ul className="cx-list">
              {v.blockers.value.map((b) => (
                <li key={b.id}>{b.href ? <Link href={b.href}>{b.title}</Link> : b.title}</li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

import Link from "next/link";

import { MetricTile, Panel, ToneBadge, TruthValue } from "@/components/cockpit/primitives";
import { buildExecutiveView } from "@/features/cockpit/executive";
import { loadSnapshot, loadSources } from "@/features/cockpit/load";
import { mapTruth } from "@/features/cockpit/truth";

export const metadata = { title: "Executive" };

export default async function ExecutivePage() {
  const [snapshot, sources] = await Promise.all([loadSnapshot(), loadSources()]);
  if (!snapshot || !sources) return null;
  const v = buildExecutiveView(snapshot, sources.audit);

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
        <MetricTile label="Autonomous actions 24h" truth={v.autonomousActions24h} tone="autonomy" />
        <MetricTile label="Human actions 24h" truth={v.humanActions24h} />
        <MetricTile label="ICOS proposals" truth={v.proposals} tone="autonomy" />
        <MetricTile label="Digital workforce" truth={v.digitalWorkforce} />
        <MetricTile label="Clients / projects" truth={v.clients} />
        <MetricTile label="Business KPIs" truth={v.kpis} />
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

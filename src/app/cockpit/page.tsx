import { Bell, Bot, Cpu, MessageSquare, Workflow } from "lucide-react";
import Link from "next/link";

import { AlertList } from "@/components/cockpit/alert-list";
import { NODE_TONE, nodeLabel } from "@/components/cockpit/node-tone";
import { MetricTile, Panel, ToneBadge, TruthValue, formatTime } from "@/components/cockpit/primitives";
import { SystemMap } from "@/components/cockpit/system-map";
import { loadSnapshot } from "@/features/cockpit/load";
import type { CockpitSnapshot, MetricKey, Tone } from "@/features/cockpit/snapshot";

// A layout title template does not apply to a page in the same segment.
export const metadata = { title: "Overview · ICOS" };

const HEALTH_TONE: Record<CockpitSnapshot["health"]["level"], Tone> = {
  healthy: "ok",
  degraded: "warn",
  critical: "critical",
  unknown: "unknown",
};

const METRICS: { key: MetricKey; label: string; tone?: (v: number | string) => Tone; mobile?: boolean }[] = [
  { key: "globalHealth", label: "Global health", tone: (v) => HEALTH_TONE[v as keyof typeof HEALTH_TONE] ?? "unknown" },
  { key: "autonomyLevel", label: "Autonomy level", tone: () => "autonomy", mobile: true },
  { key: "activeMissions", label: "Active missions", mobile: true },
  { key: "activeWorkers", label: "Active workers", mobile: true },
  { key: "readyQueue", label: "Ready queue" },
  { key: "reviewBacklog", label: "Review backlog", tone: (v) => (Number(v) > 0 ? "warn" : "ok") },
  { key: "integrationBacklog", label: "Integration backlog" },
  { key: "mustNow", label: "MUST NOW", tone: (v) => (Number(v) > 0 ? "critical" : "ok"), mobile: true },
  { key: "providerHealth", label: "Provider health" },
  { key: "cost", label: "Cost today" },
  { key: "tokenThroughput", label: "Token throughput" },
  { key: "latency", label: "Latency" },
  { key: "humanInterventions", label: "Human interventions 24h", tone: () => "autonomy" },
];

export default async function OverviewPage() {
  const snapshot = await loadSnapshot();
  if (!snapshot) return null;
  const healthTone = HEALTH_TONE[snapshot.health.level];
  const p0 = snapshot.alerts.filter((a) => a.severity === "P0");
  const missions = snapshot.missions.kind === "real" ? snapshot.missions.value : [];
  const activeMissions = missions.filter((m) => !["succeeded", "cancelled", "failed", "draft"].includes(m.status));
  const running = activeMissions.filter((m) => m.running > 0);

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">ICOS · Overview</p>
          <h1>Control plane</h1>
        </div>
        <p className="cx-dim">Snapshot {formatTime(snapshot.generatedAt)}</p>
      </div>

      {/* Mobile home: the four questions, answered first. */}
      <section className="cx-hero" data-tone={healthTone} aria-label="Status summary">
        <div className="cx-hero__row">
          <span className="cx-hero__q">Is ICOS healthy?</span>
          <ToneBadge tone={healthTone} label={snapshot.health.level.toUpperCase()} />
        </div>
        <div className="cx-hero__row">
          <span className="cx-hero__q">What is running?</span>
          <strong>
            {snapshot.missions.kind === "real" ? `${running.length} mission(s) executing` : <TruthValue truth={snapshot.missions} />}
          </strong>
        </div>
        <div className="cx-hero__row">
          <span className="cx-hero__q">What is blocked?</span>
          <strong>{missions.filter((m) => m.attention).length} mission(s) need attention</strong>
        </div>
        <div className="cx-hero__row">
          <span className="cx-hero__q">Must you act?</span>
          <ToneBadge tone={p0.length ? "critical" : "ok"} label={p0.length ? `YES · ${p0.length} P0` : "No"} />
        </div>
      </section>

      <nav className="cx-quick" aria-label="Quick actions">
        <Link href="/cockpit/ask">
          <MessageSquare aria-hidden size={20} /> Ask ICOS
        </Link>
        <Link href="/cockpit/missions">
          <Workflow aria-hidden size={20} /> Missions
        </Link>
        <Link href="/cockpit/workers">
          <Bot aria-hidden size={20} /> Workers
        </Link>
        <Link href="/cockpit/alerts">
          <Bell aria-hidden size={20} /> Alerts
        </Link>
        <Link href="/cockpit/autonomy">
          <Cpu aria-hidden size={20} /> Autonomy
        </Link>
      </nav>

      <div className="cx-metrics cx-metrics--overview" role="list" aria-label="Global metrics">
        {METRICS.map((m) => {
          const truth = snapshot.metrics[m.key];
          return (
            <div role="listitem" key={m.key} data-mobile={m.mobile || undefined}>
              <MetricTile label={m.label} truth={truth} tone={truth.kind === "real" && m.tone ? m.tone(truth.value) : undefined} />
            </div>
          );
        })}
      </div>

      <div className="cx-overview">
        <Panel title="ICOS system map" eyebrow="Live topology" className="cx-overview__map">
          <SystemMap snapshot={snapshot} />
          <ul className="cx-domains" aria-label="Domains">
            {snapshot.domains.map((d) => (
              <li key={d.key}>
                <Link href={d.href} data-tone={d.tone}>
                  <span>{d.label}</span>
                  <TruthValue truth={d.metric} />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="cx-overview__side">
          <Panel title="Must now" eyebrow={`${snapshot.alerts.length} open signals`} actions={<Link href="/cockpit/alerts">All alerts</Link>}>
            <AlertList alerts={snapshot.alerts.filter((a) => a.severity !== "P2").slice(0, 6)} empty="Nothing requires you right now." />
          </Panel>

          <Panel title="Current critical path" eyebrow={snapshot.focus ? snapshot.focus.title : "No active chain"}>
            {snapshot.focus ? (
              <ol className="cx-path">
                {snapshot.focus.path.map((step) => (
                  <li key={step.id} data-tone={NODE_TONE[step.status]}>
                    <span className="cx-path__dot" aria-hidden />
                    <span className="cx-path__title">{step.title}</span>
                    <ToneBadge tone={NODE_TONE[step.status]} label={nodeLabel(step.status)} size="sm" />
                  </li>
                ))}
                <li className="cx-path__more">
                  <Link href={`/cockpit/missions/${snapshot.focus.missionId}`}>Open mission graph →</Link>
                </li>
              </ol>
            ) : (
              <p className="cx-empty">No active mission has unfinished work.</p>
            )}
          </Panel>
        </div>
      </div>

      <div className="cx-grid3">
        <Panel title="Active missions" eyebrow="Missions" actions={<Link href="/cockpit/missions">All</Link>}>
          {snapshot.missions.kind !== "real" ? (
            <TruthValue truth={snapshot.missions} />
          ) : activeMissions.length === 0 ? (
            <p className="cx-empty">No active mission.</p>
          ) : (
            <ul className="cx-list">
              {activeMissions.slice(0, 6).map((m) => (
                <li key={m.id}>
                  <Link href={`/cockpit/missions/${m.id}`}>
                    <span className="cx-list__main">
                      <strong>{m.title}</strong>
                      <span className="cx-progress" aria-label={`${m.progressPct}% complete`}>
                        <span style={{ width: `${m.progressPct}%` }} />
                      </span>
                    </span>
                    <ToneBadge tone={m.tone} label={m.status} size="sm" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Workers" eyebrow="Fleet" actions={<Link href="/cockpit/workers">All</Link>}>
          {snapshot.workers.kind !== "real" ? (
            <TruthValue truth={snapshot.workers} />
          ) : snapshot.workers.value.length === 0 ? (
            <p className="cx-empty">No worker is registered.</p>
          ) : (
            <ul className="cx-list">
              {[...snapshot.workers.value]
                .sort((a, b) => toneRank(a.tone) - toneRank(b.tone))
                .slice(0, 8)
                .map((w) => (
                  <li key={w.id}>
                    <Link href={`/cockpit/workers#${w.id}`}>
                      <span className="cx-list__main">
                        <strong>{w.name}</strong>
                        <span className="cx-dim">
                          {w.kind} · {w.runtime} · slots <TruthValue truth={w.slots.used} />/{w.slots.max}
                        </span>
                      </span>
                      <ToneBadge tone={w.tone} label={w.health} size="sm" />
                    </Link>
                  </li>
                ))}
            </ul>
          )}
        </Panel>

        <Panel title="Timeline" eyebrow="Audit" actions={<Link href="/cockpit/audit">Full audit</Link>}>
          {snapshot.timeline.kind !== "real" ? (
            <TruthValue truth={snapshot.timeline} />
          ) : (
            <ol className="cx-timeline">
              {snapshot.timeline.value.slice(0, 10).map((e) => (
                <li key={e.id} data-tone={e.tone}>
                  <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</time>
                  <code>{e.type}</code>
                  <span className="cx-dim">{e.actorKind}</span>
                </li>
              ))}
              {snapshot.timeline.value.length === 0 && <li className="cx-empty">No audit events.</li>}
            </ol>
          )}
        </Panel>
      </div>
    </>
  );
}

const RANK: Record<Tone, number> = { critical: 0, warn: 1, unknown: 2, flow: 3, autonomy: 3, ok: 4 };
const toneRank = (t: Tone) => RANK[t];

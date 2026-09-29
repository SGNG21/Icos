import Link from "next/link";

import { CommandButton, NotCommandable } from "@/components/cockpit/command-button";
import { DagView } from "@/components/cockpit/dag-view";
import { NODE_TONE, nodeLabel } from "@/components/cockpit/node-tone";
import { Panel, ToneBadge, TruthValue, formatTime } from "@/components/cockpit/primitives";
import { isFinished } from "@/features/cockpit/dag";
import { loadMissionDetail, loadSnapshot } from "@/features/cockpit/load";
import { missing } from "@/features/cockpit/truth";

export const metadata = { title: "Mission" };

export default async function MissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, snapshot] = await Promise.all([loadMissionDetail(id), loadSnapshot()]);
  if (!detail || !snapshot) return null;
  const { mission, dag } = detail;
  const summary =
    snapshot.missions.kind === "real"
      ? snapshot.missions.value.find((m) => m.id === id)
      : undefined;
  const workerNames =
    snapshot.workers.kind === "real"
      ? Object.fromEntries(snapshot.workers.value.map((w) => [w.id, w.name]))
      : {};
  const current = dag.nodes.filter((n) => ["RUNNING", "DISPATCHED", "CLAIMED"].includes(n.status));
  const target = { kind: "mission" as const, id: mission.id };
  const elapsedMs = Date.parse(snapshot.generatedAt) - new Date(mission.createdAt).getTime();
  const layers = Math.max(0, ...dag.nodes.map((n) => n.layer + 1));

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">
            <Link href="/cockpit/missions">Missions</Link> / {mission.id.slice(0, 8)}
          </p>
          <h1>{mission.title}</h1>
        </div>
        <div className="cx-actions" aria-label="Mission controls">
          <CommandButton type="PAUSE_MISSION" target={target} label={mission.title} />
          <CommandButton type="RESUME_MISSION" target={target} label={mission.title} />
          <CommandButton type="CANCEL_MISSION" target={target} label={mission.title} />
          <NotCommandable label="Change priority" requirement="no command" />
        </div>
      </div>

      <div className="cx-metrics">
        <div className="cx-metric" data-tone={summary?.tone ?? "unknown"}>
          <span className="cx-metric__label">State</span>
          <span className="cx-metric__value">{mission.status.replace("_", " ")}</span>
        </div>
        <div className="cx-metric" data-tone="flow">
          <span className="cx-metric__label">Progress</span>
          <span className="cx-metric__value">
            {summary ? (
              <>
                {summary.completed}/{summary.total}{" "}
                <small className="cx-dim">{summary.progressPct}%</small>
              </>
            ) : (
              <TruthValue truth={missing("unknown", "Mission summary could not be read.")} />
            )}
          </span>
        </div>
        <div className="cx-metric" data-tone="ok">
          <span className="cx-metric__label">Current task</span>
          <span className="cx-metric__value" style={{ fontSize: 14 }}>
            {current.length ? current.map((n) => n.title).join(", ") : "none executing"}
          </span>
        </div>
        <div className="cx-metric" data-tone="flow">
          <span className="cx-metric__label">Elapsed</span>
          <span className="cx-metric__value">{formatDuration(elapsedMs)}</span>
        </div>
        <div className="cx-metric" data-tone="autonomy">
          <span className="cx-metric__label">Critical path left</span>
          <span className="cx-metric__value">{dag.criticalRemaining}</span>
        </div>
        <div className="cx-metric" data-tone="unknown">
          <span className="cx-metric__label">Cost</span>
          <span className="cx-metric__value">
            <TruthValue truth={missing("not_available", "No cost ledger.", "BR-05")} />
          </span>
        </div>
      </div>

      <Panel title="Task graph" eyebrow={`Plan · ${dag.nodes.length} tasks`}>
        {/* Phone: the graph as ordered stages, same data, thumb-sized. */}
        <div className="cx-stages">
          {Array.from({ length: layers }, (_, layer) => (
            <section key={layer}>
              <h4>Stage {layer + 1}</h4>
              <ol>
                {dag.nodes
                  .filter((n) => n.layer === layer)
                  .map((n) => (
                    <li key={n.id} data-tone={NODE_TONE[n.status]}>
                      <span>
                        {n.onCriticalPath && <span aria-label="critical path">◆ </span>}
                        {n.title}
                        {n.blockedReason && <small className="cx-dim"> — {n.blockedReason}</small>}
                      </span>
                      <ToneBadge tone={NODE_TONE[n.status]} label={nodeLabel(n.status)} size="sm" />
                    </li>
                  ))}
              </ol>
            </section>
          ))}
        </div>
        <DagView dag={dag} workerNames={workerNames} />
      </Panel>

      <div className="cx-grid2">
        <Panel title="Mission" eyebrow="Objective">
          <p style={{ marginTop: 0 }}>{mission.objective}</p>
          <dl className="cx-kv">
            <dt>Created</dt>
            <dd>{formatTime(new Date(mission.createdAt).toISOString())}</dd>
            <dt>Updated</dt>
            <dd>{formatTime(new Date(mission.updatedAt).toISOString())}</dd>
            {mission.goalId && (
              <>
                <dt>Goal</dt>
                <dd>
                  <code>{mission.goalId}</code>
                </dd>
              </>
            )}
            {mission.planId && (
              <>
                <dt>Plan</dt>
                <dd>
                  <code>{mission.planId}</code>
                </dd>
              </>
            )}
            <dt>Dispatch ledger</dt>
            <dd>
              {detail.attempts.kind === "real" ? (
                `${detail.attempts.value.length} active attempt(s)`
              ) : (
                <TruthValue truth={detail.attempts} />
              )}
            </dd>
            <dt>Reviews</dt>
            <dd>
              {detail.reviews.kind === "real" ? (
                `${detail.reviews.value.length} decision(s)`
              ) : (
                <TruthValue truth={detail.reviews} />
              )}
            </dd>
          </dl>
        </Panel>

        <Panel title="Why is this mission where it is?" eyebrow="WHY">
          <ul className="cx-why">
            {dag.nodes
              .filter((n) => n.blockedReason && !isFinished(n.status))
              .slice(0, 6)
              .map((n) => (
                <li key={n.id}>
                  <strong>{n.title}:</strong> {n.blockedReason}
                </li>
              ))}
            {dag.nodes
              .filter((n) => n.review && n.review.decision !== "APPROVE")
              .slice(0, 4)
              .map((n) => (
                <li key={`r-${n.id}`}>
                  <strong>
                    Review {n.review!.decision} on {n.title}:
                  </strong>{" "}
                  {n.review!.reasons.join(" · ")}
                </li>
              ))}
            <li>
              <strong>Why this priority / these workers?</strong>{" "}
              <span className="cx-missing" data-kind="not_available">
                WHY DATA NOT AVAILABLE <span className="cx-missing__req">BR-09</span>
              </span>
            </li>
          </ul>
        </Panel>
      </div>
    </>
  );
}

function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

import Link from "next/link";

import { MetricTile, Panel, ToneBadge, TruthValue, formatTime } from "@/components/cockpit/primitives";
import { loadSnapshot, loadSources } from "@/features/cockpit/load";
import { buildPipeline, leaseState } from "@/features/cockpit/pipeline";

export const metadata = { title: "Pipeline" };

const LEASE_TONE = { held: "ok", expired: "critical", none: "unknown" } as const;

export default async function PipelinePage() {
  const [sources, snapshot] = await Promise.all([loadSources(), loadSnapshot()]);
  if (!sources || !snapshot) return null;
  const { stages } = buildPipeline(sources);
  const names =
    snapshot.workers.kind === "real"
      ? Object.fromEntries(snapshot.workers.value.map((w) => [w.id, w.name]))
      : {};
  const workspaces =
    sources.workspaces.kind === "real"
      ? [...sources.workspaces.value]
          .filter((w) => w.status !== "abandoned")
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : null;

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Attempt → review → correction → gate → apply</p>
          <h1>Execution pipeline</h1>
        </div>
      </div>

      <div className="cx-metrics">
        {stages.map((s) => (
          <MetricTile key={s.key} label={s.label} truth={s.count} tone={s.tone} />
        ))}
      </div>

      <Panel title="Quality control queue" eyebrow="Independent review · corrections">
        {sources.qualityJobs.kind !== "real" ? (
          <TruthValue truth={sources.qualityJobs} />
        ) : sources.qualityJobs.value.length === 0 ? (
          <p className="cx-empty">No result is waiting for review or a decision.</p>
        ) : (
          <div className="cx-scroll">
            <table className="cx-table">
              <thead>
                <tr>
                  <th>Mission</th>
                  <th>Task</th>
                  <th>Attempt</th>
                  <th>Reviews</th>
                  <th>State</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {sources.qualityJobs.value.map((j) => (
                  <tr key={j.workflowId}>
                    <td>
                      <Link href={`/cockpit/missions/${j.missionId}`}>{j.missionId.slice(0, 8)}</Link>
                    </td>
                    <td>
                      <code>{j.taskId.slice(0, 8)}</code>
                    </td>
                    <td>{j.executionAttempt}</td>
                    <td>{j.reviewAttemptCount}</td>
                    <td>
                      <ToneBadge
                        tone={j.state === "review_unavailable" ? "critical" : j.state === "decision_ready" ? "warn" : "flow"}
                        label={j.state.replace("_", " ")}
                        size="sm"
                      />
                    </td>
                    <td className="cx-dim">{j.lastError ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Workspaces" eyebrow="Integration lifecycle · leases · fencing">
        {!workspaces ? (
          <TruthValue truth={sources.workspaces} />
        ) : workspaces.length === 0 ? (
          <p className="cx-empty">No workspace is registered.</p>
        ) : (
          <div className="cx-scroll">
            <table className="cx-table">
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>Status</th>
                  <th>Worker</th>
                  <th>Mission</th>
                  <th>Lease</th>
                  <th>Fencing</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map((w) => {
                  const lease = leaseState(w, sources.now);
                  return (
                    <tr key={w.id}>
                      <td>
                        <code>{w.slug}</code>
                      </td>
                      <td>
                        <ToneBadge
                          tone={
                            w.status === "blocked"
                              ? "critical"
                              : w.status === "accepted"
                                ? "ok"
                                : w.status === "rejected" || w.status === "ready_for_integration"
                                  ? "warn"
                                  : "flow"
                          }
                          label={w.status.replaceAll("_", " ")}
                          size="sm"
                        />
                      </td>
                      <td>{names[w.workerId] ?? <code>{w.workerId.slice(0, 8)}</code>}</td>
                      <td>
                        {w.missionId ? (
                          <Link href={`/cockpit/missions/${w.missionId}`}>{w.missionId.slice(0, 8)}</Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <ToneBadge tone={LEASE_TONE[lease]} label={lease} size="sm" />
                        {w.leaseExpiresAt && lease !== "none" && (
                          <span className="cx-dim"> {formatTime(w.leaseExpiresAt)}</span>
                        )}
                      </td>
                      <td>
                        <code>{w.fencingToken}</code>
                      </td>
                      <td className="cx-dim">{formatTime(w.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

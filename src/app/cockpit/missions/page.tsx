import Link from "next/link";

import { Panel, ToneBadge, TruthValue, formatTime } from "@/components/cockpit/primitives";
import { loadSnapshot } from "@/features/cockpit/load";

export const metadata = { title: "Missions" };

const FILTERS = [
  { key: "active", label: "Active" },
  { key: "attention", label: "Needs attention" },
  { key: "all", label: "All" },
] as const;

export default async function MissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const snapshot = await loadSnapshot();
  if (!snapshot) return null;
  const view = (await searchParams).view ?? "active";

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Missions</p>
          <h1>Mission control</h1>
        </div>
        <nav className="cx-filters" aria-label="Filter missions">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={`/cockpit/missions?view=${f.key}`}
              aria-current={view === f.key ? "true" : undefined}
            >
              {f.label}
            </Link>
          ))}
        </nav>
      </div>

      <Panel title="Missions" eyebrow="Scoped to your operational access">
        {snapshot.missions.kind !== "real" ? (
          <TruthValue truth={snapshot.missions} />
        ) : (
          (() => {
            const rows = snapshot.missions.value.filter((m) =>
              view === "attention"
                ? m.attention
                : view === "active"
                  ? !["succeeded", "cancelled", "failed"].includes(m.status)
                  : true,
            );
            if (rows.length === 0) return <p className="cx-empty">No mission matches this view.</p>;
            return (
              <div className="cx-scroll">
                <table className="cx-table">
                  <thead>
                    <tr>
                      <th>Mission</th>
                      <th>State</th>
                      <th>Progress</th>
                      <th className="cx-hide-sm">Running</th>
                      <th className="cx-hide-sm">Ready</th>
                      <th className="cx-hide-sm">Failed</th>
                      <th className="cx-hide-sm">Critical path</th>
                      <th className="cx-hide-sm">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <Link href={`/cockpit/missions/${m.id}`}>{m.title}</Link>
                        </td>
                        <td>
                          <ToneBadge tone={m.tone} label={m.status.replace("_", " ")} size="sm" />
                        </td>
                        <td style={{ minWidth: 110 }}>
                          {m.completed}/{m.total}
                          <span className="cx-progress" aria-label={`${m.progressPct}% complete`}>
                            <span style={{ width: `${m.progressPct}%` }} />
                          </span>
                        </td>
                        <td className="cx-hide-sm">{m.running}</td>
                        <td className="cx-hide-sm">{m.ready}</td>
                        <td className="cx-hide-sm">{m.failed}</td>
                        <td className="cx-hide-sm">{m.remainingCriticalPath} left</td>
                        <td className="cx-hide-sm cx-dim">{formatTime(m.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()
        )}
      </Panel>
    </>
  );
}

import Link from "next/link";

import { Panel, ToneBadge, TruthValue, formatTime } from "@/components/cockpit/primitives";
import { queryAudit } from "@/features/cockpit/audit-view";
import { loadSources } from "@/features/cockpit/load";
import type { Tone } from "@/features/cockpit/snapshot";

export const metadata = { title: "Audit" };

type Params = { eventType?: string; actorKind?: string; taskId?: string; missionId?: string; tone?: string; page?: string };
const TONES: Tone[] = ["critical", "warn", "ok", "flow", "autonomy"];

export default async function AuditPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sources = await loadSources();
  if (!sources) return null;
  const p = await searchParams;

  if (sources.audit.kind !== "real") {
    return (
      <Panel title="Audit timeline" eyebrow="Audit">
        <TruthValue truth={sources.audit} />
      </Panel>
    );
  }

  const missions = sources.missions.kind === "real" ? sources.missions.value : [];
  const mission = missions.find((m) => m.mission.id === p.missionId);
  const result = queryAudit(sources.audit.value, {
    eventType: p.eventType || undefined,
    actorKind: p.actorKind || undefined,
    taskId: p.taskId || undefined,
    missionTaskIds: p.missionId ? new Set(mission?.tasks.map((t) => t.taskId) ?? []) : undefined,
    tone: TONES.includes(p.tone as Tone) ? (p.tone as Tone) : undefined,
    page: Number(p.page) || 1,
  });
  const pageHref = (page: number) => `/cockpit/audit?${new URLSearchParams({ ...p, page: String(page) } as Record<string, string>)}`;

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Audit · append-only log</p>
          <h1>Operational timeline</h1>
        </div>
        <p className="cx-dim">
          {result.total} event(s) · {sources.scope} scope
        </p>
      </div>

      {/* Plain GET form: filters work without JavaScript and survive reloads. */}
      <form className="cx-auditfilter" method="get" aria-label="Filter audit">
        <label className="cx-field">
          Event type
          <select name="eventType" defaultValue={p.eventType ?? ""}>
            <option value="">All</option>
            {result.eventTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="cx-field">
          Mission
          <select name="missionId" defaultValue={p.missionId ?? ""}>
            <option value="">All</option>
            {missions.map((m) => (
              <option key={m.mission.id} value={m.mission.id}>
                {m.mission.title}
              </option>
            ))}
          </select>
        </label>
        <label className="cx-field">
          Actor
          <select name="actorKind" defaultValue={p.actorKind ?? ""}>
            <option value="">All</option>
            <option value="human">human</option>
            <option value="agent">agent</option>
            <option value="system">system</option>
          </select>
        </label>
        <label className="cx-field">
          Severity
          <select name="tone" defaultValue={p.tone ?? ""}>
            <option value="">All</option>
            {TONES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="cx-field">
          Task id
          <input name="taskId" defaultValue={p.taskId ?? ""} autoComplete="off" />
        </label>
        <button className="cx-btn cx-btn--primary" type="submit">
          Apply
        </button>
        <Link className="cx-btn cx-btn--ghost" href="/cockpit/audit">
          Reset
        </Link>
      </form>

      <Panel title="Events" eyebrow={`Page ${result.page} of ${result.pages}`}>
        {result.rows.length === 0 ? (
          <p className="cx-empty">No audit event matches.</p>
        ) : (
          <div className="cx-scroll">
            <table className="cx-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Actor</th>
                  <th className="cx-hide-sm">Task</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((e) => (
                  <tr key={e.id}>
                    <td className="cx-dim">
                      <time dateTime={e.at}>{formatTime(e.at)}</time>
                    </td>
                    <td>
                      <ToneBadge tone={e.tone} label={e.type} size="sm" />
                    </td>
                    <td>
                      {e.actorKind} <code>{e.actor.slice(0, 12)}</code>
                    </td>
                    <td className="cx-hide-sm">
                      {e.taskId ? <Link href={`/cockpit/audit?taskId=${e.taskId}`}>{e.taskId.slice(0, 8)}</Link> : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.pages > 1 && (
          <nav className="cx-filters" aria-label="Pages" style={{ marginTop: 12 }}>
            {result.page > 1 && <Link href={pageHref(result.page - 1)}>← Newer</Link>}
            {result.page < result.pages && <Link href={pageHref(result.page + 1)}>Older →</Link>}
          </nav>
        )}
      </Panel>

      <p className="cx-dim" style={{ margin: 0 }}>
        Runtime events (worker started/failed, review required, integration, provider degraded) are not yet emitted into the audit log (BR-02).
      </p>
    </>
  );
}

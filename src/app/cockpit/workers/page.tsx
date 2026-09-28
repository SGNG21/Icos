import Link from "next/link";

import { CommandButton } from "@/components/cockpit/command-button";
import { Panel, ToneBadge, TruthValue, formatAge } from "@/components/cockpit/primitives";
import { loadSnapshot } from "@/features/cockpit/load";
import type { Tone, WorkerView } from "@/features/cockpit/snapshot";
import { missing } from "@/features/cockpit/truth";

export const metadata = { title: "Workers" };

const FILTERS: { key: string; label: string; match: (w: WorkerView) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "busy", label: "Executing", match: (w) => w.assignments.length > 0 },
  { key: "attention", label: "Attention", match: (w) => w.tone === "critical" || w.tone === "warn" },
  { key: "unknown", label: "No evidence", match: (w) => w.tone === "unknown" },
];

const RANK: Record<Tone, number> = { critical: 0, warn: 1, unknown: 2, flow: 3, autonomy: 3, ok: 4 };

export default async function WorkersPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const snapshot = await loadSnapshot();
  if (!snapshot) return null;
  const view = (await searchParams).view ?? "all";
  const filter = FILTERS.find((f) => f.key === view) ?? FILTERS[0];

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Workers</p>
          <h1>Worker fleet</h1>
        </div>
        <nav className="cx-filters" aria-label="Filter workers">
          {FILTERS.map((f) => (
            <Link key={f.key} href={`/cockpit/workers?view=${f.key}`} aria-current={filter.key === f.key ? "true" : undefined}>
              {f.label}
            </Link>
          ))}
        </nav>
      </div>

      {snapshot.workers.kind !== "real" ? (
        <Panel title="Workers">
          <TruthValue truth={snapshot.workers} />
        </Panel>
      ) : snapshot.workers.value.length === 0 ? (
        <Panel title="Workers">
          <p className="cx-empty">No worker is registered in the durable registry.</p>
        </Panel>
      ) : (
        <div className="cx-workers">
          {snapshot.workers.value
            .filter(filter.match)
            .sort((a, b) => RANK[a.tone] - RANK[b.tone] || a.name.localeCompare(b.name))
            .map((w) => (
              <WorkerCard key={w.id} worker={w} />
            ))}
        </div>
      )}
    </>
  );
}

function WorkerCard({ worker: w }: { worker: WorkerView }) {
  const target = { kind: "worker" as const, id: w.id, label: w.name };
  const used = w.slots.used.kind === "real" ? w.slots.used.value : 0;
  const current = w.assignments[0];

  return (
    <article className="cx-worker" id={w.id} data-tone={w.tone} aria-labelledby={`${w.id}-name`}>
      <header className="cx-worker__head">
        <div>
          <h3 id={`${w.id}-name`}>{w.name}</h3>
          <code>{w.id}</code>
        </div>
        <ToneBadge tone={w.tone} label={`${w.health} · ${w.availability}`} />
      </header>

      <div className="cx-identity" aria-label="Execution identity">
        <div>
          <span>Worker kind</span>
          <span>{w.kind}</span>
        </div>
        <div>
          <span>Runtime</span>
          <span title={w.runtimeSupport}>{w.runtime}</span>
        </div>
        <div>
          <span>Model</span>
          <span>
            <TruthValue truth={w.model} />
          </span>
        </div>
        <div>
          <span>Provider</span>
          <span>
            <TruthValue truth={w.provider} />
          </span>
        </div>
        <div>
          <span>Account</span>
          <span>
            <TruthValue truth={w.account} />
          </span>
        </div>
        <div>
          <span>Capacity slots</span>
          <span>
            <TruthValue truth={w.slots.used} />/{w.slots.max}
            {w.pool && <span className="cx-dim"> · pool {w.pool.name}{w.pool.limit ? ` ≤${w.pool.limit}` : ""}</span>}
          </span>
        </div>
      </div>

      <div className="cx-slots" aria-hidden>
        {Array.from({ length: Math.min(w.slots.max, 24) }, (_, i) => (
          <i key={i} data-used={i < used || undefined} />
        ))}
      </div>

      <dl className="cx-kv">
        <dt>Registry status</dt>
        <dd>{w.status}</dd>
        <dt>Last health evidence</dt>
        <dd>
          {w.probe.outcome} · {formatAge(w.probe.ageMs)}
        </dd>
        <dt>Current work</dt>
        <dd>
          {current ? (
            <Link href={`/cockpit/missions/${current.missionId}`}>
              task <code>{current.taskId.slice(0, 8)}</code> · attempt #{current.attempt} · {current.state}
            </Link>
          ) : (
            "idle"
          )}
          {w.assignments.length > 1 && <span className="cx-dim"> +{w.assignments.length - 1} more</span>}
        </dd>
        {current?.failureClass && (
          <>
            <dt>Last failure</dt>
            <dd>
              <code>{current.failureClass}</code> {current.lastError}
            </dd>
          </>
        )}
        <dt>Lease · fencing</dt>
        <dd>
          <TruthValue truth={missing("not_available", "Lease owner/expiry/fencing token are not readable.", "BR-15")} />
        </dd>
        <dt>Latency · throughput · cost</dt>
        <dd>
          <TruthValue truth={missing("not_available", "No per-worker telemetry.", "BR-04")} />
        </dd>
      </dl>

      {(w.capabilities.length > 0 || w.features.length > 0) && (
        <div className="cx-tags">
          {w.capabilities.map((c) => (
            <span key={c} className="cx-chip" data-tone="flow">
              {c}
            </span>
          ))}
          {w.features.map((f) => (
            <span key={f} className="cx-chip">
              {f}
            </span>
          ))}
        </div>
      )}

      {Object.keys(w.metadata).length > 0 && (
        <details>
          <summary className="cx-dim">Declared metadata (unverified)</summary>
          <dl className="cx-kv">
            {Object.entries(w.metadata).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      <div className="cx-actions" aria-label={`Controls for ${w.name}`}>
        <CommandButton action="worker.pause" target={target} expectedStateVersion={w.probe.at} />
        <CommandButton action="worker.resume" target={target} expectedStateVersion={w.probe.at} />
        <CommandButton action="worker.retry" target={target} expectedStateVersion={w.probe.at} />
        <CommandButton action="worker.stop" target={target} expectedStateVersion={w.probe.at} />
      </div>
    </article>
  );
}

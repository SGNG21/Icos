import Link from "next/link";

import { Panel, TruthValue } from "@/components/cockpit/primitives";
import { WorkerCard } from "@/components/cockpit/worker-card";
import { loadSnapshot } from "@/features/cockpit/load";
import type { Tone, WorkerView } from "@/features/cockpit/snapshot";

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

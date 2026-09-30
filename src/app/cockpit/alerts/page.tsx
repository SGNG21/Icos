import Link from "next/link";

import { AlertList } from "@/components/cockpit/alert-list";
import { Panel, Unavailable } from "@/components/cockpit/primitives";
import { loadSnapshot } from "@/features/cockpit/load";
import type { Alert, AlertCategory } from "@/features/cockpit/snapshot";

export const metadata = { title: "Alerts" };

const CATEGORIES: AlertCategory[] = [
  "CRITICAL",
  "SECURITY",
  "MISSION",
  "WORKER",
  "PROVIDER",
  "RECOVERY",
  "GOVERNANCE",
  "SELF_DEVELOPMENT",
  "COST",
  "CAPACITY",
];
const SEVERITIES: Alert["severity"][] = ["P0", "P1", "P2"];
const SEVERITY_HINT = {
  P0: "immediate human attention",
  P1: "normal notification",
  P2: "cockpit only",
};

/** Categories whose signal source does not exist yet: silence there is NOT "all clear". */
const BLIND: Partial<Record<AlertCategory, string>> = {
  PROVIDER: "BR-04",
  COST: "BR-05",
  SELF_DEVELOPMENT: "BR-08",
};

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ severity?: string }>;
}) {
  const snapshot = await loadSnapshot();
  if (!snapshot) return null;
  const sev = (await searchParams).severity;
  const alerts = SEVERITIES.includes(sev as Alert["severity"])
    ? snapshot.alerts.filter((a) => a.severity === sev)
    : snapshot.alerts;

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Alerts</p>
          <h1>Signals</h1>
        </div>
        <nav className="cx-filters" aria-label="Filter by severity">
          <Link href="/cockpit/alerts" aria-current={!sev ? "true" : undefined}>
            All ({snapshot.alerts.length})
          </Link>
          {SEVERITIES.map((s) => (
            <Link
              key={s}
              href={`/cockpit/alerts?severity=${s}`}
              aria-current={sev === s ? "true" : undefined}
              title={SEVERITY_HINT[s]}
            >
              {s} ({snapshot.alerts.filter((a) => a.severity === s).length})
            </Link>
          ))}
        </nav>
      </div>

      <p className="cx-dim" style={{ margin: 0 }}>
        Alerts are derived from canonical ICOS state at each snapshot. They are not persisted,
        acknowledged or deduplicated server-side (BR-22).
      </p>

      <div className="cx-grid2">
        {CATEGORIES.map((category) => {
          const list = alerts.filter((a) => a.category === category);
          const blind = BLIND[category];
          if (list.length === 0 && !blind && sev) return null;
          return (
            <Panel
              key={category}
              title={category.replace("_", "-")}
              eyebrow={`${list.length} signal(s)`}
            >
              {blind && list.length === 0 ? (
                <Unavailable title="This category has no signal source" requirement={blind}>
                  An empty list here would be a false “all clear”.
                </Unavailable>
              ) : (
                <AlertList alerts={list} empty="No open signal." />
              )}
            </Panel>
          );
        })}
      </div>

      <Panel title="Notification preferences" eyebrow="Delivery">
        <Unavailable
          title="Push delivery and per-category preferences are NOT CONNECTED"
          requirement="BR-19"
        >
          P0 is meant to reach your phone immediately, P1 as a normal notification, P2 only here.
        </Unavailable>
      </Panel>
    </>
  );
}

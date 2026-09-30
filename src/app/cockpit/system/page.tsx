import { CommandButton, NotCommandable } from "@/components/cockpit/command-button";
import { ControlStatePanel } from "@/components/cockpit/control-state";
import { Panel, ToneBadge } from "@/components/cockpit/primitives";
import { loadSnapshot, loadSystemFacts } from "@/features/cockpit/load";

export const metadata = { title: "System" };

const RUNTIME = { kind: "runtime" as const, id: "global" as const };

/** Emergency levers the owner expects but the control plane does not expose yet. */
const NOT_COMMANDABLE = [
  { label: "Pause new work only", requirement: "BR-26" },
  { label: "Freeze integrations only", requirement: "BR-26" },
  { label: "Lock external actions only", requirement: "BR-26" },
  { label: "Stop external workers", requirement: "no command" },
];

export default async function SystemPage() {
  const [facts, snapshot] = await Promise.all([loadSystemFacts(), loadSnapshot()]);
  if (!facts || !snapshot) return null;

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">System · governance</p>
          <h1>System & emergency</h1>
        </div>
      </div>

      <Panel title="Emergency controls" eyebrow="Safe mode" className="cx-panel--danger">
        <ControlStatePanel />
        <div className="cx-emergency">
          <div>
            <strong>Enter safe mode</strong>
            <p>
              No new dispatch, no integration, no external action. Running state and evidence are
              preserved; the cockpit stays observable. MEDIUM risk: reachable under stress.
            </p>
            <CommandButton type="ENTER_SAFE_MODE" target={RUNTIME} label="ICOS" />
          </div>
          <div>
            <strong>Exit safe mode</strong>
            <p>
              Re-opens dispatch and integration. CRITICAL: fresh password proof and the exact
              confirmation phrase are required.
            </p>
            <CommandButton type="EXIT_SAFE_MODE" target={RUNTIME} label="ICOS" />
          </div>
        </div>
        <div className="cx-actions" aria-label="Not commandable yet">
          {NOT_COMMANDABLE.map((c) => (
            <NotCommandable key={c.label} {...c} />
          ))}
        </div>
        <div className="cx-safemode" aria-label="What safe mode guarantees">
          <h4>Safe mode guarantees (control foundation)</h4>
          <ul>
            <li>no new autonomous dispatch at any admission point</li>
            <li>no integration (gate and applier refuse)</li>
            <li>state and evidence preserved</li>
            <li>an unreadable flag row is treated as everything off (fail closed)</li>
          </ul>
        </div>
      </Panel>

      <div className="cx-grid2">
        <Panel title="Composed services" eyebrow={`Backend: ${facts.backend}`}>
          <table className="cx-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Role</th>
                <th>Composed in this process</th>
              </tr>
            </thead>
            <tbody>
              {facts.services.map((s) => (
                <tr key={s.key}>
                  <td>{s.label}</td>
                  <td className="cx-dim">{s.essential ? "essential" : "optional"}</td>
                  <td>
                    <ToneBadge
                      tone={s.composed ? "ok" : s.essential ? "critical" : "unknown"}
                      label={s.composed ? "composed" : "not composed"}
                      size="sm"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="cx-dim">
            “Composed” means the process wired the service at start-up. It is not a live
            reachability probe of Temporal, workers or providers.
          </p>
        </Panel>

        <Panel title="Health rationale" eyebrow={`Global health: ${snapshot.health.level}`}>
          <ul className="cx-why">
            {snapshot.health.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <h4>Unavailable subsystems</h4>
          <ul className="cx-why">
            {snapshot.domains
              .filter((d) => d.metric.kind !== "real")
              .map((d) => (
                <li key={d.key}>
                  <strong>{d.label}</strong>{" "}
                  <span className="cx-dim">
                    {d.metric.kind !== "real" && d.metric.reason}{" "}
                    {d.metric.kind !== "real" && d.metric.requirement}
                  </span>
                </li>
              ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}

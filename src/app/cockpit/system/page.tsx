import { CommandButton } from "@/components/cockpit/command-button";
import { Panel, ToneBadge } from "@/components/cockpit/primitives";
import { COMMAND_ACTIONS, type CommandAction } from "@/features/cockpit/commands";
import { loadSnapshot, loadSystemFacts } from "@/features/cockpit/load";

export const metadata = { title: "System" };

const EMERGENCY: { action: CommandAction; effect: string }[] = [
  { action: "system.pause_new_work", effect: "No new task is dispatched; running work continues." },
  { action: "system.freeze_integrations", effect: "No result is integrated; reviews and evidence continue to accumulate." },
  { action: "system.stop_external_workers", effect: "External worker processes are stopped; in-flight attempts must be recovered." },
  { action: "system.lock_self_modification", effect: "No self-development change can be planned, executed or integrated." },
  { action: "system.enter_safe_mode", effect: "All of the above except stopping workers: ICOS observes, preserves state, acts on nothing." },
];

const SYSTEM = { kind: "system" as const, id: "icos", label: "ICOS" };

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
        <div className="cx-safestate" role="status">
          <span className="cx-missing" data-kind="unknown" title="No runtime control flags exist to read (BR-12).">
            SAFE MODE STATE: UNKNOWN <span className="cx-missing__req">BR-12</span>
          </span>
          <p>
            The cockpit cannot read any emergency flag, so it never shows one as engaged. Until the command bus (BR-10) and runtime control
            flags (BR-12) exist, these controls confirm your intent and then report <strong>NOT YET WIRED</strong>: nothing is executed. In a real
            emergency, stop ICOS processes at the host.
          </p>
        </div>
        <div className="cx-emergency">
          {EMERGENCY.map(({ action, effect }) => (
            <div key={action}>
              <strong>{COMMAND_ACTIONS[action].label}</strong>
              <p>{effect}</p>
              <p className="cx-dim">
                Current state:{" "}
                <span className="cx-missing" data-kind="unknown">
                  UNKNOWN
                </span>
              </p>
              <CommandButton action={action} target={SYSTEM} />
            </div>
          ))}
        </div>
        <div className="cx-safemode" aria-label="What safe mode guarantees">
          <h4>Safe mode, once wired, must guarantee</h4>
          <ul>
            <li>no new autonomous dispatch</li>
            <li>no autonomous integration</li>
            <li>state and evidence preserved</li>
            <li>cockpit remains observable</li>
            <li>a flag read failure is treated as “safe mode ON” (fail closed)</li>
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
            “Composed” means the process wired the service at start-up. It is not a live reachability probe of Temporal, workers or providers.
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
                    {d.metric.kind !== "real" && d.metric.reason} {d.metric.kind !== "real" && d.metric.requirement}
                  </span>
                </li>
              ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}

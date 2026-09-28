import { MetricTile, Panel, Unavailable } from "@/components/cockpit/primitives";
import { loadSnapshot } from "@/features/cockpit/load";
import { missing } from "@/features/cockpit/truth";

export const metadata = { title: "Autonomy" };

const LEVELS = [
  ["L0", "Manual", "Every step is performed by a human."],
  ["L1", "Assisted", "ICOS proposes, humans execute."],
  ["L2", "Orchestrated", "ICOS plans and dispatches; humans supervise."],
  ["L3", "Recovering", "ICOS recovers from worker/provider failures on its own."],
  ["L4", "Self-developing", "ICOS proposes and ships its own improvements under governance."],
  ["L5", "Self-prioritizing", "ICOS chooses what to improve next from measured value."],
  ["L6", "Continuous autonomy", "Human role is governance and exception handling only."],
] as const;

const DIMENSIONS = ["Planning", "Routing", "Recovery", "Review", "Integration", "Self-development", "Deployment"];

export default async function AutonomyPage() {
  const snapshot = await loadSnapshot();
  if (!snapshot) return null;
  const assessment = missing<number>("not_available", "No autonomy assessment is produced by ICOS.", "BR-06");

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Autonomy center</p>
          <h1>How autonomous is ICOS?</h1>
        </div>
      </div>

      <div className="cx-metrics">
        <MetricTile label="Overall autonomy" truth={assessment} />
        <MetricTile label="Current level" truth={snapshot.metrics.autonomyLevel} />
        <MetricTile label="Human interventions 24h" truth={snapshot.metrics.humanInterventions} tone="autonomy" />
        <MetricTile label="Manual intervention debt" truth={missing("not_available", "Interventions are not tagged in the audit log.", "BR-07")} />
      </div>

      <div className="cx-grid2">
        <Panel title="Autonomy levels" eyebrow="The level is never guessed">
          <ol className="cx-ladder">
            {LEVELS.map(([id, name, meaning]) => (
              <li key={id}>
                <b>{id}</b>
                <span>
                  <strong>{name}</strong>
                  <br />
                  <span className="cx-dim">{meaning}</span>
                </span>
                <span className="cx-missing" data-kind="unknown" title="No evidence source exists to place ICOS on this ladder (BR-06).">
                  UNKNOWN
                </span>
              </li>
            ))}
          </ol>
        </Panel>

        <Panel title="Autonomy by dimension" eyebrow="Evidence required per dimension">
          <table className="cx-table">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {DIMENSIONS.map((d) => (
                <tr key={d}>
                  <td>{d} autonomy</td>
                  <td>
                    <span className="cx-missing" data-kind="not_available" title="No per-dimension measurement exists.">
                      NOT AVAILABLE <span className="cx-missing__req">BR-06</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="cx-dim">
            Human interventions are counted from human-actor audit entries (partial proxy). Every manual action should eventually be recorded as
            autonomy debt (BR-07).
          </p>
        </Panel>
      </div>

      <Unavailable title="Autonomy assessment is not produced by the backend" requirement="BR-06">
        The self-development metrics service exists in code but is not exposed on the ICOS container, so no score is shown.
      </Unavailable>
    </>
  );
}

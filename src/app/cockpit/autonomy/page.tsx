import {
  AUTONOMY_LEVELS,
  type AutonomyAssessment,
  type AutonomyLevel,
  type Certification,
  type DimensionAssessment,
} from "@/core/autonomy/assessment";
import {
  MetricTile,
  MissingBadge,
  Panel,
  Unavailable,
  formatTime,
} from "@/components/cockpit/primitives";
import { loadSnapshot } from "@/features/cockpit/load";
import { isReal, real } from "@/features/cockpit/truth";

export const dynamic = "force-dynamic";

const LEVELS: ReadonlyArray<readonly [AutonomyLevel, string, string]> = [
  ["L0", "Manual", "Every step is performed by a human."],
  ["L1", "Assisted", "ICOS proposes, humans execute."],
  ["L2", "Orchestrated", "ICOS plans and dispatches; humans supervise."],
  ["L3", "Recovering", "ICOS recovers from worker/provider failures on its own."],
  ["L4", "Self-developing", "ICOS proposes and ships its own improvements under governance."],
  ["L5", "Self-prioritizing", "ICOS chooses what to improve next from measured value."],
  ["L6", "Continuous autonomy", "Human role is governance and exception handling only."],
];

/** The ladder is ordinal: a reached level proves every rung below it. */
function rungStatus(
  assessment: AutonomyAssessment,
  level: AutonomyLevel,
): "REACHED" | "NOT_REACHED" | "UNKNOWN" {
  if (assessment.unmeasurableLevels.includes(level)) return "UNKNOWN";
  if (assessment.level === "UNKNOWN") return "UNKNOWN";
  return AUTONOMY_LEVELS.indexOf(level) <= AUTONOMY_LEVELS.indexOf(assessment.level)
    ? "REACHED"
    : "NOT_REACHED";
}

const CERTIFICATION_WORD: Record<Certification, string> = {
  NONE: "NO SOURCE",
  CODE_READY: "CODE_READY",
  LAB_CERTIFIED: "LAB_CERTIFIED",
  LIVE_CERTIFIED: "LIVE_CERTIFIED",
};

function DimensionRow({ d }: { d: DimensionAssessment }) {
  return (
    <tr>
      <td>{d.label} autonomy</td>
      <td>
        {d.state === "PROVEN" ? (
          <span className="cx-badge" data-tone="autonomy">
            PROVEN ×{d.proofs}
          </span>
        ) : (
          <span
            className="cx-missing"
            data-kind={d.state === "UNKNOWN" ? "unknown" : "not_available"}
            title={d.limits.join(" ")}
          >
            {d.state === "UNKNOWN" ? "UNKNOWN" : "UNPROVEN"}{" "}
            <span className="cx-missing__req">BR-06</span>
          </span>
        )}
      </td>
      <td>{CERTIFICATION_WORD[d.certification]}</td>
      <td>{d.lastEvidenceAt ? formatTime(d.lastEvidenceAt) : "—"}</td>
      <td>
        {d.evidence.length > 0 ? (
          <ul className="cx-list">
            {d.evidence.map((e) => (
              <li key={`${e.source}:${e.ref}`}>
                <code>
                  {e.source}:{e.ref}
                </code>{" "}
                <span className="cx-dim">{e.summary}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="cx-dim">{d.limits[0]}</span>
        )}
      </td>
    </tr>
  );
}

export default async function AutonomyPage() {
  const snapshot = await loadSnapshot();
  if (!snapshot) return null;
  const assessment = snapshot.autonomy;
  const value = isReal(assessment) ? assessment.value : null;
  /* The miss, typed as such: it carries no value, so it fits any tile. */
  const miss = isReal(assessment) ? null : assessment;
  const provenCount = value ? value.dimensions.filter((d) => d.state === "PROVEN").length : 0;

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Autonomy center</p>
          <h1>How autonomous is ICOS?</h1>
        </div>
      </div>

      <div className="cx-metrics">
        <MetricTile
          label="Proven dimensions"
          truth={
            value
              ? real(`${provenCount}/${value.dimensions.length}`, "dimensions with a durable proof")
              : miss!
          }
          tone="autonomy"
        />
        <MetricTile label="Current level" truth={snapshot.metrics.autonomyLevel} />
        <MetricTile
          label="Human interventions 24h"
          truth={snapshot.metrics.humanInterventions}
          tone="autonomy"
        />
        <MetricTile
          label="Manual intervention debt"
          truth={snapshot.metrics.interventionDebt}
          tone="autonomy"
        />
      </div>

      <div className="cx-grid2">
        <Panel
          title="Autonomy levels"
          eyebrow={
            value
              ? `${value.levelReason} Certification: ${CERTIFICATION_WORD[value.certification]}${value.tier ? ` (tier ${value.tier})` : " (tier undeclared)"}`
              : "The level is never guessed"
          }
        >
          <ol className="cx-ladder">
            {LEVELS.map(([id, name, meaning]) => {
              const status = value ? rungStatus(value, id) : "UNKNOWN";
              return (
                <li key={id}>
                  <b>{id}</b>
                  <span>
                    <strong>{name}</strong>
                    <br />
                    <span className="cx-dim">{meaning}</span>
                  </span>
                  {status === "REACHED" ? (
                    <span className="cx-badge" data-tone="autonomy">
                      REACHED
                    </span>
                  ) : status === "NOT_REACHED" ? (
                    <span className="cx-badge" data-tone="unknown">
                      NOT REACHED
                    </span>
                  ) : (
                    <span
                      className="cx-missing"
                      data-kind="unknown"
                      title={
                        value?.unmeasurableLevels.includes(id)
                          ? value.limits[0]
                          : (value?.levelReason ??
                            "No evidence source could be read to place ICOS on this ladder (BR-06).")
                      }
                    >
                      UNKNOWN
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </Panel>

        <Panel
          title="Autonomy by dimension"
          eyebrow="Durable proofs only — rows ICOS already writes"
        >
          {value ? (
            <table className="cx-table">
              <thead>
                <tr>
                  <th>Dimension</th>
                  <th>State</th>
                  <th>Certification</th>
                  <th>Last proof</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {value.dimensions.map((d) => (
                  <DimensionRow key={d.key} d={d} />
                ))}
              </tbody>
            </table>
          ) : (
            <MissingBadge truth={miss!} />
          )}
          <p className="cx-dim">
            PROVEN = at least one durable row proves the dimension in this runtime. UNPROVEN = the
            source was read and holds no proof yet. UNKNOWN = the source could not be read.
            CODE_READY = the code exists; LAB/LIVE_CERTIFIED = proofs recorded in a runtime that
            declares that tier (ICOS_RUNTIME_TIER).
          </p>
        </Panel>
      </div>

      {value ? (
        <Panel
          title="Limits of this measurement"
          eyebrow={`Assessed ${formatTime(value.assessedAt)}`}
        >
          <ul className="cx-list">
            {value.limits.map((l) => (
              <li key={l}>{l}</li>
            ))}
            <li>
              Human interventions are the entries TAGGED at their source (approval decisions,
              executed control commands — BR-07); untagged human entries are a proxy, counted apart.
            </li>
          </ul>
        </Panel>
      ) : (
        <Unavailable title="Autonomy assessment could not be read" requirement="BR-06">
          {miss?.reason ?? "No assessment."}
        </Unavailable>
      )}
    </>
  );
}

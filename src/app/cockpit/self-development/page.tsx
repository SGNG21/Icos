import { Panel, Unavailable } from "@/components/cockpit/primitives";
import { getCockpitContext } from "@/features/cockpit/load";

export const metadata = { title: "Self-development" };

const LIFECYCLE = [
  "DETECTED",
  "CANDIDATE",
  "GOAL",
  "MISSION",
  "PLAN",
  "EXECUTION",
  "REVIEW",
  "INTEGRATION",
  "MEASURED",
  "LEARNED",
];
const COLUMNS = [
  "Candidate",
  "Source",
  "Impact",
  "Risk",
  "Reversibility",
  "Effort",
  "Confidence",
  "Autonomy gain",
  "Reliability gain",
  "Security gain",
  "Cost gain",
  "Throughput gain",
  "State",
];

export default async function SelfDevelopmentPage() {
  if (!(await getCockpitContext())) return null;

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Self-development</p>
          <h1>ICOS improves ICOS</h1>
        </div>
      </div>

      <Panel title="Improvement lifecycle" eyebrow="Governed path of every self-change">
        <ol className="cx-lifecycle" aria-label="Improvement lifecycle">
          {LIFECYCLE.map((s) => (
            <li key={s}>
              {s}
              <span
                className="cx-missing"
                data-kind="not_available"
                title="Candidates ARE persisted; no cockpit read path counts them (BR-08)."
              >
                —
              </span>
            </li>
          ))}
        </ol>
        <p className="cx-dim">
          Stage counts appear here once a cockpit read path exposes the durable backlog.
        </p>
      </Panel>

      <Panel title="Improvement candidates" eyebrow="Backlog">
        <div className="cx-scroll">
          <table className="cx-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={COLUMNS.length}>
                  <Unavailable title="Improvement candidates are NOT AVAILABLE" requirement="BR-08">
                    The backlog IS durable: <code>DurableImprovementBacklog</code> persists every
                    candidate in durable memory, so a restart no longer forgets them. What is
                    missing is a cockpit read path — nothing here can read that store yet, so no
                    candidate is shown rather than an invented one.
                  </Unavailable>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

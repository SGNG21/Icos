import { Panel, ToneBadge, TruthValue, Unavailable } from "@/components/cockpit/primitives";
import { getCockpitContext, loadTruthProjection } from "@/features/cockpit/load";
import { candidatesByStatus } from "@/features/cockpit/truth-projection";

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
  "Category",
  "Target",
  "Priority",
  "Proposed by",
  "Proposed at",
  "State",
];

/** Backlog statuses mapped onto the lifecycle stages they evidence. Others have no source yet. */
const STAGE_OF_STATUS: Partial<Record<string, string>> = {
  proposed: "CANDIDATE",
  under_review: "CANDIDATE",
  approved: "GOAL",
  implemented: "INTEGRATION",
};

export default async function SelfDevelopmentPage() {
  if (!(await getCockpitContext())) return null;
  const truth = await loadTruthProjection();
  const backlog = truth?.selfDevelopment;
  const candidates = backlog?.kind === "real" ? backlog.value : null;
  const byStatus = candidates ? candidatesByStatus(candidates) : null;
  const stageCount = (stage: string): number | null => {
    if (!byStatus) return null;
    const statuses = Object.entries(STAGE_OF_STATUS)
      .filter(([, s]) => s === stage)
      .map(([status]) => status as keyof typeof byStatus);
    return statuses.length ? statuses.reduce((n, s) => n + byStatus[s], 0) : null;
  };

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
          {LIFECYCLE.map((s) => {
            const n = stageCount(s);
            return (
              <li key={s}>
                {s}
                {n === null ? (
                  <span
                    className="cx-missing"
                    data-kind="not_available"
                    title="No durable source records this stage yet."
                  >
                    —
                  </span>
                ) : (
                  <strong>{n}</strong>
                )}
              </li>
            );
          })}
        </ol>
        <p className="cx-dim">
          CANDIDATE, GOAL and INTEGRATION are counted from the durable backlog (proposed / under
          review, approved, implemented). The other stages have no durable source yet and stay
          unmarked rather than guessed.
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
              {!candidates ? (
                <tr>
                  <td colSpan={COLUMNS.length}>
                    {backlog ? (
                      <TruthValue truth={backlog} />
                    ) : (
                      <Unavailable
                        title="Improvement candidates are NOT AVAILABLE"
                        requirement="BR-08"
                      >
                        The durable backlog could not be read in this scope.
                      </Unavailable>
                    )}
                  </td>
                </tr>
              ) : candidates.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length}>
                    <p className="cx-empty">The durable backlog holds no candidate.</p>
                  </td>
                </tr>
              ) : (
                candidates.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.title}</strong>
                      <p className="cx-dim">{c.rationale}</p>
                    </td>
                    <td>{c.category}</td>
                    <td>
                      <code>{c.targetComponent}</code>
                    </td>
                    <td>{c.priority}</td>
                    <td>{c.proposedBy}</td>
                    <td>{new Date(c.proposedAt).toISOString().slice(0, 16).replace("T", " ")}</td>
                    <td>
                      <ToneBadge
                        tone={
                          c.status === "implemented"
                            ? "ok"
                            : c.status === "rejected" || c.status === "superseded"
                              ? "unknown"
                              : "autonomy"
                        }
                        label={c.status}
                        size="sm"
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

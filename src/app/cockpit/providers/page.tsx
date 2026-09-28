import Link from "next/link";

import {
  MetricTile,
  Panel,
  ToneBadge,
  TruthValue,
  Unavailable,
} from "@/components/cockpit/primitives";
import { loadSnapshot } from "@/features/cockpit/load";
import { UNDECLARED, buildResourceTree, providerTelemetry } from "@/features/cockpit/resources";
import { missing } from "@/features/cockpit/truth";

export const metadata = { title: "Providers" };

export default async function ProvidersPage() {
  const snapshot = await loadSnapshot();
  if (!snapshot) return null;
  const tree = snapshot.workers.kind === "real" ? buildResourceTree(snapshot.workers.value) : null;
  const cost = missing<number>("not_available", "No cost ledger.", "BR-05");

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Providers · capacity · cost</p>
          <h1>Resources</h1>
        </div>
      </div>

      <div className="cx-metrics">
        <MetricTile label="Provider health" truth={providerTelemetry()} />
        <MetricTile label="Latency p95" truth={providerTelemetry()} />
        <MetricTile label="Token throughput" truth={providerTelemetry()} />
        <MetricTile label="Cost today" truth={cost} />
        <MetricTile label="Cost by provider" truth={cost} />
        <MetricTile label="Cost by mission" truth={cost} />
        <MetricTile label="Cost by client" truth={cost} />
        <MetricTile label="Queue pressure" truth={snapshot.metrics.readyQueue} />
      </div>

      <Panel title="Provider › Account › Model › Worker" eyebrow="Declared in the worker registry">
        {!tree ? (
          <TruthValue truth={snapshot.workers} />
        ) : tree.providers.length === 0 ? (
          <p className="cx-empty">No worker is registered, so no resource is known.</p>
        ) : (
          <ul className="cx-tree">
            {tree.providers.map((p) => (
              <li key={p.provider}>
                <div className="cx-tree__row">
                  <strong>{p.declared ? p.provider : "Provider not declared"}</strong>
                  {!p.declared && (
                    <span
                      className="cx-missing"
                      data-kind="not_available"
                      title="Workers here declare no provider."
                    >
                      {UNDECLARED} <span className="cx-missing__req">BR-03</span>
                    </span>
                  )}
                  <span className="cx-dim">{p.workerCount} worker(s)</span>
                  <TruthValue truth={providerTelemetry()} />
                </div>
                <ul>
                  {p.accounts.map((a) => (
                    <li key={a.account}>
                      <div className="cx-tree__row">
                        <span className="cx-dim">Account</span>{" "}
                        {a.account === UNDECLARED ? (
                          <em className="cx-dim">not declared</em>
                        ) : (
                          a.account
                        )}
                      </div>
                      <ul>
                        {a.models.map((m) => (
                          <li key={m.model}>
                            <div className="cx-tree__row">
                              <span className="cx-dim">Model</span>{" "}
                              {m.model === UNDECLARED ? (
                                <em className="cx-dim">not declared</em>
                              ) : (
                                m.model
                              )}
                            </div>
                            <ul>
                              {m.workers.map((w) => (
                                <li key={w.id} className="cx-tree__row">
                                  <Link href={`/cockpit/workers#${w.id}`}>{w.name}</Link>
                                  <span className="cx-dim">{w.runtime}</span>
                                  <span className="cx-dim">
                                    slots <TruthValue truth={w.used} />/{w.max}
                                  </span>
                                  <ToneBadge tone={w.tone} size="sm" />
                                </li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Capacity pools" eyebrow="Shared quotas (distinct from API keys)">
        {!tree ? (
          <TruthValue truth={snapshot.workers} />
        ) : tree.pools.length === 0 ? (
          <p className="cx-empty">No worker declares a shared capacity pool.</p>
        ) : (
          <table className="cx-table">
            <thead>
              <tr>
                <th>Pool</th>
                <th>Used / limit</th>
                <th>Workers</th>
              </tr>
            </thead>
            <tbody>
              {tree.pools.map((p) => (
                <tr key={p.pool}>
                  <td>
                    <code>{p.pool}</code>
                  </td>
                  <td>
                    <TruthValue truth={p.used} /> /{" "}
                    {p.limit ?? <span className="cx-dim">no declared limit</span>}
                  </td>
                  <td>{p.workers.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Unavailable
        title="Billing, per-provider latency and token metering have no ICOS source"
        requirement="BR-04 · BR-05"
      >
        These views stay empty rather than estimated.
      </Unavailable>
    </>
  );
}

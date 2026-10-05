import Link from "next/link";

import {
  MetricTile,
  Panel,
  ToneBadge,
  TruthValue,
  Unavailable,
} from "@/components/cockpit/primitives";
import { buildCompute } from "@/features/cockpit/compute";
import { loadSnapshot, loadSources } from "@/features/cockpit/load";
import { UNDECLARED, buildResourceTree, providerTelemetry } from "@/features/cockpit/resources";
import { missing } from "@/features/cockpit/truth";

export const metadata = { title: "Providers" };

export default async function ProvidersPage() {
  const [snapshot, sources] = await Promise.all([loadSnapshot(), loadSources()]);
  if (!snapshot || !sources) return null;
  const compute =
    snapshot.workers.kind === "real"
      ? buildCompute(snapshot.workers.value, sources.attempts)
      : null;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const tree = snapshot.workers.kind === "real" ? buildResourceTree(snapshot.workers.value) : null;
  // Money is real only when every call in the window is priced; otherwise the tile says
  // UNPRICED with the count (decision 0066). Breakdowns by provider/mission/client stay
  // unavailable: the ledger carries goal and model, not provider or client.
  const cost = snapshot.metrics.cost;
  const breakdown = missing<number>(
    "not_available",
    "The spend ledger attributes calls to goals and models, not to providers or clients.",
    "BR-05",
  );

  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Compute · providers · capacity · cost</p>
          <h1>Compute</h1>
        </div>
      </div>

      <div className="cx-metrics">
        <MetricTile label="Routable workers" truth={snapshot.metrics.providerHealth} />
        <MetricTile label="Latency p95" truth={providerTelemetry()} />
        <MetricTile label="Tokens 24h" truth={snapshot.metrics.tokenThroughput} />
        <MetricTile label="Cost 24h" truth={cost} />
        <MetricTile label="Cost by provider" truth={breakdown} />
        <MetricTile label="Cost by mission" truth={breakdown} />
        <MetricTile label="Cost by client" truth={breakdown} />
        <MetricTile label="Queue pressure" truth={snapshot.metrics.readyQueue} />
      </div>

      <Panel
        title="Compute fleet"
        eyebrow="Candidates = registered workers (decision 0054) · grouped by model family"
      >
        {!compute ? (
          <TruthValue truth={snapshot.workers} />
        ) : compute.length === 0 ? (
          <p className="cx-empty">No compute candidate is registered.</p>
        ) : (
          compute.map((g) => (
            <section key={g.family} aria-label={`Family ${g.family}`}>
              <h3 className="cx-eyebrow">
                {g.declared ? g.family : "Family not declared"} · {g.rows.length}
              </h3>
              <div className="cx-scroll">
                <table className="cx-table">
                  <thead>
                    <tr>
                      <th>Model (registered)</th>
                      <th>Provider · capacity pool</th>
                      <th>Health</th>
                      <th>Load</th>
                      <th>Steered model (requested via {"{{model}}"})</th>
                      <th>Router history: timeouts</th>
                      <th>Router history: infra failures (incl. timeouts)</th>
                      <th>Finished-attempt rates</th>
                      <th>Rate limit</th>
                      <th>Latency</th>
                      <th>Steered</th>
                      <th>Fallbacks (in-flight)</th>
                      <th>Routing reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((r) => (
                      <tr key={r.workerId}>
                        <td>
                          <Link href={`/cockpit/workers#${r.workerId}`}>
                            <TruthValue truth={r.modelId} />
                          </Link>
                        </td>
                        <td>
                          <TruthValue truth={r.provider} />{" "}
                          <span className="cx-dim">
                            <TruthValue truth={r.capacityPool} />
                          </span>
                        </td>
                        <td>
                          <ToneBadge
                            tone={r.tone}
                            label={`${r.health} · ${r.availability}`}
                            size="sm"
                          />
                        </td>
                        <td>
                          <TruthValue truth={r.load.used} />/{r.load.max}
                        </td>
                        <td>
                          <TruthValue truth={r.effectiveModel} />
                        </td>
                        <td>
                          <TruthValue truth={r.timeoutRate} format={pct} />
                        </td>
                        <td>
                          <TruthValue truth={r.infraFailureRate} format={pct} />
                        </td>
                        <td>
                          <TruthValue truth={r.finishedAttemptRates} />
                        </td>
                        <td>
                          <TruthValue truth={r.rateLimit} />
                        </td>
                        <td>
                          <TruthValue truth={r.latency} />
                        </td>
                        <td>
                          <TruthValue
                            truth={r.modelSteered}
                            format={(v) => (v ? "yes" : "label only")}
                          />
                        </td>
                        <td>
                          <TruthValue truth={r.fallbackEvents} />
                        </td>
                        <td>
                          <TruthValue truth={r.routingReason} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        )}
        <p className="cx-dim">
          Credential health is never exposed here; an authentication failure appears as a routing
          cooldown. Model list comes from OmniRoute through registration, not from this screen.
        </p>
      </Panel>

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
        title="Per-provider latency and cost breakdowns have no ICOS source"
        requirement="BR-04 · BR-05"
      >
        Tokens and call counts come from the spend ledger; money appears only once a price table
        prices every call in the window. Latency is not measured. These views stay empty rather than
        estimated.
      </Unavailable>
    </>
  );
}

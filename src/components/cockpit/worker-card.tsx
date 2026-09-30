import Link from "next/link";

import type { WorkerView } from "@/features/cockpit/snapshot";
import { missing } from "@/features/cockpit/truth";

import { CommandButton, NotCommandable } from "./command-button";
import { ToneBadge, TruthValue, formatAge } from "./primitives";

/**
 * One worker. Worker, runtime, model, provider, account and capacity slots are
 * rendered as separate facts; registry values are shown verbatim.
 */
export function WorkerCard({ worker: w }: { worker: WorkerView }) {
  const target = { kind: "worker" as const, id: w.id };
  const used = w.slots.used.kind === "real" ? w.slots.used.value : 0;
  const current = w.assignments[0];

  return (
    <article className="cx-worker" id={w.id} data-tone={w.tone} aria-labelledby={`${w.id}-name`}>
      <header className="cx-worker__head">
        <div>
          <h3 id={`${w.id}-name`}>{w.name}</h3>
          <code>{w.id}</code>
        </div>
        <ToneBadge tone={w.tone} label={`${w.health} · ${w.availability}`} />
      </header>

      <div className="cx-identity" aria-label="Execution identity">
        <div>
          <span className="cx-identity__k">Worker kind</span>
          <span className="cx-identity__v">{w.kind}</span>
        </div>
        <div>
          <span className="cx-identity__k">Runtime</span>
          <span className="cx-identity__v" title={w.runtimeSupport}>
            {w.runtime}
          </span>
        </div>
        <div>
          <span className="cx-identity__k">Model</span>
          <span className="cx-identity__v">
            <TruthValue truth={w.model} />
          </span>
        </div>
        <div>
          <span className="cx-identity__k">Provider</span>
          <span className="cx-identity__v">
            <TruthValue truth={w.provider} />
          </span>
        </div>
        <div>
          <span className="cx-identity__k">Account</span>
          <span className="cx-identity__v">
            <TruthValue truth={w.account} />
          </span>
        </div>
        <div>
          <span className="cx-identity__k">Capacity slots</span>
          <span className="cx-identity__v">
            <TruthValue truth={w.slots.used} />/{w.slots.max}
            {w.pool && (
              <span className="cx-dim">
                {" "}
                · pool {w.pool.name}
                {w.pool.limit ? ` ≤${w.pool.limit}` : ""}
              </span>
            )}
          </span>
        </div>
      </div>

      <div className="cx-slots" aria-hidden>
        {Array.from({ length: Math.min(w.slots.max, 24) }, (_, i) => (
          <i key={i} data-used={i < used || undefined} />
        ))}
      </div>

      <dl className="cx-kv">
        <dt>Registry status</dt>
        <dd>{w.status}</dd>
        <dt>Last health evidence</dt>
        <dd>
          {w.probe.outcome} · {formatAge(w.probe.ageMs)}
        </dd>
        <dt>Current work</dt>
        <dd>
          {current ? (
            <Link href={`/cockpit/missions/${current.missionId}`}>
              task <code>{current.taskId.slice(0, 8)}</code> · attempt #{current.attempt} ·{" "}
              {current.state}
            </Link>
          ) : (
            "idle"
          )}
          {w.assignments.length > 1 && (
            <span className="cx-dim"> +{w.assignments.length - 1} more</span>
          )}
        </dd>
        {current?.failureClass && (
          <>
            <dt>Last failure</dt>
            <dd>
              <code>{current.failureClass}</code> {current.lastError}
            </dd>
          </>
        )}
        <dt>Workspace lease · fencing</dt>
        <dd>
          {w.leases.kind !== "real" ? (
            <TruthValue truth={w.leases} />
          ) : w.leases.value.length === 0 ? (
            <span className="cx-dim">no workspace lease held</span>
          ) : (
            w.leases.value.map((l) => (
              <span key={l.slug} className="cx-chip" data-lease={l.state}>
                {l.slug} · {l.status} · lease {l.state} · fence {l.fencingToken}
              </span>
            ))
          )}
        </dd>
        <dt>Latency · throughput · cost</dt>
        <dd>
          <TruthValue truth={missing("not_available", "No per-worker telemetry.", "BR-04")} />
        </dd>
      </dl>

      {(w.capabilities.length > 0 || w.features.length > 0) && (
        <div className="cx-tags">
          {w.capabilities.map((c) => (
            <span key={c} className="cx-chip" data-tone="flow">
              {c}
            </span>
          ))}
          {w.features.map((f) => (
            <span key={f} className="cx-chip">
              {f}
            </span>
          ))}
        </div>
      )}

      {Object.keys(w.metadata).length > 0 && (
        <details>
          <summary className="cx-dim">Declared metadata (unverified)</summary>
          <dl className="cx-kv">
            {Object.entries(w.metadata).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {w.metadataHidden > 0 && (
        <p className="cx-dim">
          {w.metadataHidden} other metadata key(s) withheld (not on the display allowlist).
        </p>
      )}

      <div className="cx-actions" aria-label={`Controls for ${w.name}`}>
        {w.status === "active" ? (
          <CommandButton type="DISABLE_WORKER" target={target} label={w.name} />
        ) : (
          <CommandButton type="ENABLE_WORKER" target={target} label={w.name} />
        )}
        <NotCommandable label="Retry task" requirement="BR-23" />
      </div>
    </article>
  );
}

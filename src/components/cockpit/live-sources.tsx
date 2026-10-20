import { Activity } from "lucide-react";
import Link from "next/link";

import type { ServiceHealth, ServiceState } from "@/core/telemetry";
import {
  LIVE_MAX_AGE_MS,
  type LiveIncident,
  type LiveOverview,
  type OmniRouteSummary,
  type VpsFacts,
  type WorkersSummary,
} from "@/features/cockpit/live-overview";
import { SOURCE_STATE_LABEL, SOURCE_STATE_TONE, type Observed } from "@/features/cockpit/observed";
import type { Tone } from "@/features/cockpit/snapshot";
import type { MissingKind, Truth } from "@/features/cockpit/truth";

import { MetricTile, Panel, ToneBadge, formatAge, formatTime } from "./primitives";

/**
 * PANNEAUX DE LA VUE LIVE (mission COCKPIT-LIVE, D2). Composants serveur, sans état.
 *
 * Chaque mesure est rendue avec son état (`Observed.state`), sa source, son horodatage et
 * son seuil de fraîcheur. Vert = mesuré et frais ; orange = périmé ou dégradé ; gris =
 * inconnu, indisponible, refusé ou non instrumenté ; rouge = incident confirmé ; violet =
 * recommandation. Rien n'est animé qui ne corresponde à une activité observée.
 */

const SOURCE_LABEL: Record<keyof LiveOverview["sources"], string> = {
  core3: "CORE3 · missions & scheduler",
  workers: "Workers · durable registry",
  omniroute: "OmniRoute · gateway & spend",
  memory: "PostgreSQL · durable memory",
  vps: "VPS · host resources",
};

const SOURCE_HREF: Record<keyof LiveOverview["sources"], string> = {
  core3: "/cockpit/missions",
  workers: "/cockpit/workers",
  omniroute: "/cockpit/providers",
  memory: "/cockpit/system",
  vps: "/cockpit/system",
};

const SERVICE_TONE: Record<ServiceState, Tone> = {
  operational: "ok",
  degraded: "warn",
  down: "critical",
  not_instrumented: "unknown",
  not_connected: "unknown",
};

const pct = (v: number | null) => (v === null ? null : `${Math.round(v * 100)}%`);

/** Un code de sous-source manquante rend la vérité manquante du bon vocabulaire, jamais un chiffre. */
function missingFor(code: string | undefined, what: string): Truth<never> {
  const kind: MissingKind =
    code === "NOT_CONNECTED"
      ? "not_connected"
      : code === "FORBIDDEN_SCOPE" || code === "NOT_AVAILABLE"
        ? "not_available"
        : "unknown";
  return { kind, reason: `${what}: ${code ?? "UNAVAILABLE"}` };
}
const missingLabel = (code: string | undefined) =>
  code === "NOT_CONNECTED"
    ? "NOT CONNECTED"
    : code === "FORBIDDEN_SCOPE"
      ? "FORBIDDEN"
      : "UNAVAILABLE";
const n = (v: number) => v.toLocaleString("en-GB");

/** Libellé de prix : un montant uniquement quand chaque appel est chiffré en devise unique. */
function priceLabel(spend: NonNullable<OmniRouteSummary["spend"]>): string {
  switch (spend.priceStatus) {
    case "PRICED":
      return `PRICED ${spend.amount24h === null ? "" : spend.amount24h.toFixed(2)} ${spend.currency ?? ""}`.trim();
    case "FREE_TIER":
      return `FREE_TIER (verified) ${n(spend.freeTier24h)}/${n(spend.calls24h)}`;
    case "UNPRICED":
      return `UNPRICED ${n(spend.unpriced24h)}/${n(spend.calls24h)}`;
    case "MIXED_CURRENCY":
      return `MIXED CURRENCY (${spend.currencies})`;
    case "NO_TRAFFIC":
      return "NO_TRAFFIC";
  }
}

function ageOf(observedAt: string | null, collectedAt: string): number | null {
  if (!observedAt) return null;
  const a = Date.parse(observedAt);
  const c = Date.parse(collectedAt);
  return Number.isNaN(a) || Number.isNaN(c) ? null : c - a;
}

/** État + source + horodatage + seuil : la fraîcheur n'est jamais implicite. */
export function Freshness<T>({ observed, compact }: { observed: Observed<T>; compact?: boolean }) {
  const age = ageOf(observed.observedAt, observed.collectedAt);
  const threshold =
    observed.maxAgeMs === null
      ? "no freshness threshold"
      : `threshold ${observed.maxAgeMs / 1000}s`;
  return (
    <span className="cx-fresh" data-state={observed.state}>
      <ToneBadge
        tone={SOURCE_STATE_TONE[observed.state]}
        label={SOURCE_STATE_LABEL[observed.state]}
        size="sm"
      />
      {observed.errorCode && <code className="cx-fresh__code">{observed.errorCode}</code>}
      {!compact && (
        <span className="cx-dim cx-fresh__meta">
          {observed.observedAt
            ? `observed ${formatTime(observed.observedAt)} (${formatAge(age)})`
            : "no source timestamp"}
          {" · "}
          {threshold}
          {" · read "}
          {formatTime(observed.collectedAt)}
          {" · "}
          <span title={observed.source}>source: {observed.source}</span>
        </span>
      )}
    </span>
  );
}

function sourceFigures(key: keyof LiveOverview["sources"], o: LiveOverview["sources"]): string {
  switch (key) {
    case "core3": {
      const d = o.core3.data;
      if (!d) return "—";
      const sched = d.scheduler
        ? `scheduler ${Object.values(d.scheduler.activeByKind).reduce((a, b) => a + b, 0)} active job(s), ${d.scheduler.leased} leased, ${d.scheduler.dead24h} dead (24h)`
        : `scheduler ${missingLabel(d.schedulerErrorCode)} (${d.schedulerErrorCode ?? "?"})`;
      const missions = d.missions
        ? `${n(d.missions.total)} mission(s), ${n(d.tasks?.total ?? 0)} task(s)`
        : `missions ${missingLabel(d.missionsErrorCode)} (${d.missionsErrorCode ?? "?"})`;
      const attempts = d.attempts
        ? `${n(d.attempts.nonTerminal)} dispatch(es)`
        : `dispatches ${missingLabel(d.attemptsErrorCode)} (${d.attemptsErrorCode ?? "?"})`;
      return `${missions}, ${attempts} · ${sched}`;
    }
    case "workers": {
      const d = o.workers.data;
      if (!d) return "—";
      const assignments =
        d.activeAssignments === null
          ? "assignments UNAVAILABLE"
          : `${d.activeAssignments} executing`;
      return `${d.registered} registered, ${d.active} active, ${d.routable} routable · probes ok ${d.byProbeOutcome.ok ?? 0} / failed ${d.byProbeOutcome.failed ?? 0} / stale ${d.byProbeOutcome.stale ?? 0} / never ${d.byProbeOutcome.never ?? 0} · ${assignments}`;
    }
    case "omniroute": {
      const d = o.omniroute.data;
      if (!d) return "—";
      const health = d.health
        ? `gateway ${d.health.state}`
        : `gateway ${missingLabel(d.healthErrorCode)} (${d.healthErrorCode ?? "?"})`;
      const spend = d.spend
        ? `${n(d.spend.calls24h)} call(s) / ${n(d.spend.tokens24h)} tokens${d.spend.tokensUnknown24h > 0 ? ` (+${n(d.spend.tokensUnknown24h)} unmetered)` : ""} in 24h · ${priceLabel(d.spend)}`
        : `ledger ${missingLabel(d.spendErrorCode)} (${d.spendErrorCode ?? "?"})`;
      return `${health} · ${spend}`;
    }
    case "memory": {
      const d = o.memory.data;
      if (!d) return "—";
      return `${n(d.records)} record(s) (${n(d.active)} active), ${n(d.retrievals24h)} retrieval(s) 24h, ${n(d.entities)} entit(ies), ${n(d.relations)} relation(s) · PostgreSQL ${d.postgres?.state ?? "UNAVAILABLE"}`;
    }
    case "vps": {
      const d = o.vps.data;
      if (!d) return "—";
      return `${d.cores ?? "? "} vCPU · CPU ${pct(d.cpuUsage) ?? "UNAVAILABLE"} · load1 ${d.load1 ?? "UNAVAILABLE"} · RAM ${pct(d.memoryRatio) ?? "UNAVAILABLE"} · disk ${pct(d.diskRatio) ?? "UNAVAILABLE"} · VRAM ${d.vram} · host ${d.overall}`;
    }
  }
}

/**
 * Activité OBSERVÉE : un dispatch non terminal ou une lease de scheduler détenue.
 * `null` dès qu'un des trois compteurs est illisible : on n'affirme pas « rien ne tourne »
 * sans l'avoir mesuré.
 */
export function observedActivity(overview: LiveOverview): number | null {
  const assignments = overview.sources.workers.data?.activeAssignments ?? null;
  const leased = overview.sources.core3.data?.scheduler?.leased ?? null;
  const attempts = overview.sources.core3.data?.attempts?.nonTerminal ?? null;
  if (assignments === null || leased === null || attempts === null) return null;
  return Math.max(assignments, attempts) + leased;
}

export function IncidentList({ incidents }: { incidents: readonly LiveIncident[] }) {
  if (incidents.length === 0)
    return <p className="cx-empty">No incident confirmed by a measurement.</p>;
  return (
    <ul className="cx-why cx-incidents" aria-label="Confirmed incidents">
      {incidents.map((i) => (
        <li key={`${i.source}-${i.code}`}>
          <ToneBadge tone="critical" label={i.code} size="sm" />{" "}
          <Link href={SOURCE_HREF[i.source]}>{SOURCE_LABEL[i.source]}</Link>{" "}
          <span className="cx-dim">{i.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** Overview : les cinq sources, leur fraîcheur, l'activité observée et les incidents. */
export function LiveSourcesPanel({ overview }: { overview: LiveOverview }) {
  const activity = observedActivity(overview);
  const keys = Object.keys(overview.sources) as (keyof LiveOverview["sources"])[];
  return (
    <Panel
      title="Live sources"
      eyebrow={`Five sources · ${overview.scope} scope · read ${formatTime(overview.generatedAt)}`}
      id="live-sources"
    >
      <p className="cx-activity" data-observed={(activity ?? 0) > 0 || undefined}>
        <Activity aria-hidden size={14} className="cx-activity__icon" />
        {activity === null
          ? "Activity UNKNOWN: a dispatch, assignment or scheduler lease counter could not be read"
          : activity > 0
            ? `${activity} observed activity signal(s): non-terminal dispatch or held scheduler lease`
            : "No activity observed: no non-terminal dispatch, no held scheduler lease"}
      </p>
      <div className="cx-scroll">
        <table className="cx-table cx-livesrc">
          <thead>
            <tr>
              <th>Source</th>
              <th>State</th>
              <th>Measured now</th>
              <th>Observed</th>
              <th>Threshold</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const o = overview.sources[key] as Observed<unknown>;
              const age = ageOf(o.observedAt, o.collectedAt);
              return (
                <tr key={key} data-state={o.state}>
                  <td>
                    <Link href={SOURCE_HREF[key]}>{SOURCE_LABEL[key]}</Link>
                    <br />
                    <span className="cx-dim" title={o.source}>
                      {o.source}
                    </span>
                  </td>
                  <td>
                    <Freshness observed={o} compact />
                  </td>
                  <td>{sourceFigures(key, overview.sources)}</td>
                  <td>
                    {o.observedAt ? (
                      `${formatTime(o.observedAt)} · ${formatAge(age)}`
                    ) : (
                      <span className="cx-dim">no source timestamp</span>
                    )}
                  </td>
                  <td className="cx-dim">
                    {o.maxAgeMs === null ? "none" : `${o.maxAgeMs / 1000}s`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h4>Confirmed incidents</h4>
      <IncidentList incidents={overview.incidents} />
    </Panel>
  );
}

/** /system : ressources hôte mesurées dans /proc, VRAM sans GPU = NO_TELEMETRY. */
export function HostResourcesPanel({ vps }: { vps: Observed<VpsFacts> }) {
  const d = vps.data;
  /* Les tons ne jugent qu'une mesure fraîche ; périmée ou dégradée, la tuile reste neutre. */
  const judge = vps.state === "ok";
  const tile = (label: string, value: string | null, tone?: Tone) =>
    value === null ? (
      <MetricTile label={label} truth={{ kind: "unknown", reason: `${label} not measured.` }} />
    ) : (
      <MetricTile label={label} truth={{ kind: "real", value }} tone={judge ? tone : "flow"} />
    );
  const hostTone: Tone = d
    ? ({ ok: "ok", degraded: "warn", incident: "critical" } as const)[d.overall]
    : "unknown";
  const level = (v: number | null, warn: number, critical: number): Tone | undefined =>
    v === null ? undefined : v >= critical ? "critical" : v >= warn ? "warn" : "ok";
  return (
    <Panel
      title="Host resources"
      eyebrow="VPS running icos-web · /proc, /sys, statfs (read-only)"
      id="host"
    >
      <Freshness observed={vps} />
      {!d ? (
        <p className="cx-empty">
          Host telemetry {SOURCE_STATE_LABEL[vps.state]}: no value is shown in its place.
        </p>
      ) : (
        <div className="cx-metrics">
          <MetricTile
            label="Host health"
            truth={{ kind: "real", value: d.overall.toUpperCase() }}
            tone={judge ? hostTone : "flow"}
          />
          {tile("CPU usage", pct(d.cpuUsage), level(d.cpuUsage, 0.75, 0.9))}
          {tile(
            "Load (1 min)",
            d.load1 === null
              ? null
              : d.cores === null
                ? `${d.load1} (vCPU count unknown)`
                : `${d.load1} / ${d.cores} vCPU`,
            d.load1 === null || d.cores === null ? undefined : level(d.load1 / d.cores, 1, 2),
          )}
          {tile("RAM used", pct(d.memoryRatio), level(d.memoryRatio, 0.8, 0.92))}
          {tile("Disk used", pct(d.diskRatio), level(d.diskRatio, 0.8, 0.9))}
          <MetricTile
            label="VRAM"
            truth={{ kind: "unknown", reason: "No GPU and no VRAM telemetry on this host." }}
          />
          <MetricTile
            label="Sampled"
            truth={{ kind: "real", value: formatTime(d.sampledAt) }}
            tone="flow"
          />
        </div>
      )}
      {d && (
        <p className="cx-dim">
          VRAM is {d.vram}: no GPU is present, so nothing is shown rather than a zero. Thresholds:
          CPU 75/90%, load 1×/2× vCPU, RAM 80/92%, disk 80/90%; tones apply to a LIVE sample only.
        </p>
      )}
    </Panel>
  );
}

const LAYER = (layer: ServiceHealth["process"]) =>
  layer ? (
    <>
      <ToneBadge tone={SERVICE_TONE[layer.state]} label={layer.state.replace("_", " ")} size="sm" />{" "}
      <span className="cx-dim">
        {layer.detail}
        {layer.latencyMs !== undefined ? ` (${layer.latencyMs} ms)` : ""}
      </span>
    </>
  ) : (
    <span className="cx-dim">n/a</span>
  );

/** /system : services sondés en trois couches (processus, disponibilité, aptitude mission). */
export function ServicesPanel({ services }: { services: Observed<ServiceHealth[]> }) {
  return (
    <Panel
      title="Probed services"
      eyebrow="Existing mechanisms only · no inference · a service without a probe is never operational"
      id="services"
    >
      <Freshness observed={services} />
      {!services.data ? (
        <p className="cx-empty">Service probes {SOURCE_STATE_LABEL[services.state]}.</p>
      ) : (
        <div className="cx-scroll">
          <table className="cx-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>State</th>
                <th>Process</th>
                <th>Availability</th>
                <th>Mission capability</th>
                <th>Checked</th>
              </tr>
            </thead>
            <tbody>
              {services.data.map((s) => (
                <tr key={s.key} data-state={s.state}>
                  <td>
                    {s.label}
                    <br />
                    <span className="cx-dim" title={s.source}>
                      {s.source}
                    </span>
                  </td>
                  <td>
                    <ToneBadge
                      tone={SERVICE_TONE[s.state]}
                      label={s.state.replace("_", " ")}
                      size="sm"
                    />
                  </td>
                  <td>{LAYER(s.process)}</td>
                  <td>{LAYER(s.availability)}</td>
                  <td>{LAYER(s.mission)}</td>
                  <td className="cx-dim">
                    {s.checkedAt ? formatTime(s.checkedAt) : "not checked"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** /providers : santé native OmniRoute et ledger de dépense, coût inconnu jamais chiffré. */
export function OmniRoutePanel({ omniroute }: { omniroute: Observed<OmniRouteSummary> }) {
  const d = omniroute.data;
  const spend = d?.spend ?? null;
  const priceTone: Tone = !spend
    ? "unknown"
    : spend.priceStatus === "PRICED" || spend.priceStatus === "FREE_TIER"
      ? "ok"
      : "unknown";
  return (
    <Panel
      title="OmniRoute gateway"
      eyebrow="GET /api/monitoring/health (no key, no model call) · spend_ledger 24h"
      id="omniroute"
    >
      <Freshness observed={omniroute} />
      {!d ? (
        <p className="cx-empty">
          OmniRoute {SOURCE_STATE_LABEL[omniroute.state]}: nothing is shown in its place.
        </p>
      ) : (
        <>
          <div className="cx-metrics">
            <MetricTile
              label="Gateway"
              truth={
                d.health
                  ? { kind: "real", value: d.health.state.toUpperCase() }
                  : missingFor(d.healthErrorCode, "Gateway probe")
              }
              tone={d.health ? SERVICE_TONE[d.health.state] : undefined}
            />
            <MetricTile
              label="Nemotron (nvidia)"
              truth={
                d.nemotron
                  ? { kind: "real", value: d.nemotron.state.toUpperCase() }
                  : { kind: "unknown", reason: "Provider breaker not published." }
              }
              tone={d.nemotron ? SERVICE_TONE[d.nemotron.state] : undefined}
            />
            <MetricTile
              label="Calls 24h"
              truth={
                spend
                  ? { kind: "real", value: n(spend.calls24h) }
                  : missingFor(d.spendErrorCode, "Spend ledger")
              }
            />
            <MetricTile
              label="Tokens 24h"
              truth={
                spend
                  ? {
                      kind: "real",
                      value:
                        spend.tokensUnknown24h > 0
                          ? `${n(spend.tokens24h)} (+${n(spend.tokensUnknown24h)} unmetered)`
                          : n(spend.tokens24h),
                    }
                  : missingFor(d.spendErrorCode, "Spend ledger")
              }
            />
            <MetricTile
              label="Price status"
              truth={
                spend
                  ? { kind: "real", value: priceLabel(spend) }
                  : missingFor(d.spendErrorCode, "Spend ledger")
              }
              tone={priceTone}
            />
            <MetricTile
              label="Cost 24h"
              truth={
                spend && spend.priceStatus === "PRICED" && spend.amount24h !== null
                  ? { kind: "real", value: `${spend.amount24h.toFixed(2)} ${spend.currency ?? ""}` }
                  : spend && spend.priceStatus === "FREE_TIER"
                    ? { kind: "real", value: "FREE_TIER (verified)" }
                    : {
                        kind: "not_available",
                        reason:
                          "No amount is shown unless every call in the window is priced in one currency (decisions 0066/0078).",
                        requirement: "BR-05",
                      }
              }
            />
          </div>
          <dl className="cx-kv">
            <dt>Gateway detail</dt>
            <dd>{d.health?.detail ?? <span className="cx-dim">unavailable</span>}</dd>
            <dt>Nemotron detail</dt>
            <dd>{d.nemotron?.detail ?? <span className="cx-dim">unavailable</span>}</dd>
            <dt>Ledger tenant (writer constant)</dt>
            <dd>
              {spend ? (
                <code>{spend.ledgerTenantId}</code>
              ) : (
                <span className="cx-dim">unavailable</span>
              )}
            </dd>
            <dt>Last recorded call</dt>
            <dd>
              {spend?.lastObservedAt ? (
                formatTime(spend.lastObservedAt)
              ) : (
                <span className="cx-dim">none in the ledger window</span>
              )}
            </dd>
          </dl>
          <p className="cx-dim">
            A degraded gateway means at least one provider breaker is not closed; it is not an
            outage. The gateway timestamp is ICOS&apos;s probe time (cache 15 s), not a timestamp
            emitted by OmniRoute. Per-call latency is not measured by ICOS and stays NOT AVAILABLE.
          </p>
        </>
      )}
    </Panel>
  );
}

/** /workers : état réel du registre, preuves de sonde, exécutions en cours. */
export function WorkersSummaryPanel({ workers }: { workers: Observed<WorkersSummary> }) {
  const d = workers.data;
  return (
    <Panel
      title="Fleet evidence"
      eyebrow="workers.last_probe_at (probe evidence) · dispatch_attempts non-terminal"
      id="fleet"
    >
      <Freshness observed={workers} />
      {!d ? (
        <p className="cx-empty">
          Registry {SOURCE_STATE_LABEL[workers.state]}: no count is shown in its place.
        </p>
      ) : (
        <>
          <div className="cx-metrics">
            <MetricTile
              label="Registered"
              truth={{ kind: "real", value: d.registered }}
              tone="flow"
            />
            <MetricTile
              label="Active (status)"
              truth={{ kind: "real", value: d.active }}
              tone="flow"
            />
            <MetricTile
              label="Routable (proven)"
              truth={{ kind: "real", value: d.routable }}
              tone={d.registered === 0 ? "unknown" : d.routable > 0 ? "ok" : "warn"}
            />
            <MetricTile
              label="Executing now"
              truth={
                d.activeAssignments === null
                  ? missingFor(d.activeAssignmentsErrorCode, "Dispatch ledger")
                  : { kind: "real", value: d.activeAssignments }
              }
              tone={d.activeAssignments ? "flow" : "ok"}
            />
            <MetricTile
              label="Recent failed probes (active)"
              truth={{ kind: "real", value: d.recentFailed }}
              tone={d.recentFailed > 0 ? "critical" : "ok"}
            />
            <MetricTile
              label="Active without fresh evidence"
              truth={{ kind: "real", value: d.staleActive }}
              tone={d.staleActive > 0 ? "warn" : "ok"}
            />
            <MetricTile
              label="Probes failed / stale / never / unsupported (all)"
              truth={{
                kind: "real",
                value: `${d.byProbeOutcome.failed ?? 0} / ${d.byProbeOutcome.stale ?? 0} / ${d.byProbeOutcome.never ?? 0} / ${d.byProbeOutcome.unsupported ?? 0}`,
              }}
              tone="flow"
            />
          </div>
          <p className="cx-dim">
            A worker is counted alive only from a dated probe (`last_probe_at`) within the{" "}
            {LIVE_MAX_AGE_MS.workers / 1000}s horizon; registration, a session or a process are
            never evidence. The source timestamp is the most recent probe of the fleet (sweep
            liveness); a stale or never-probed active worker degrades the source. Health:{" "}
            {Object.entries(d.byHealth)
              .map(([k, v]) => `${k} ${v}`)
              .join(" · ") || "none"}
            .
          </p>
        </>
      )}
    </Panel>
  );
}

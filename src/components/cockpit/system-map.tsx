import type { CockpitSnapshot, HealthLevel, Tone } from "@/features/cockpit/snapshot";
import { MISSING_LABEL } from "@/features/cockpit/truth";

import { TONE_WORD } from "./primitives";

const W = 760;
const H = 500;
const CX = W / 2;
const CY = H / 2;
const RX = 292;
const RY = 196;
const NODE_W = 132;
const NODE_H = 48;

const HEALTH_TONE: Record<HealthLevel, Tone> = {
  healthy: "ok",
  degraded: "warn",
  critical: "critical",
  unknown: "unknown",
};

/** Flow duration shrinks with real activity; 0 activity = no animation at all. */
export function flowDuration(activity: number): number | null {
  if (activity <= 0) return null;
  return Math.max(0.9, 5 - Math.log2(activity + 1));
}

/**
 * Central ICOS map. Every stroke, colour and motion maps to a snapshot value:
 * a domain whose metric is missing is drawn dashed, grey and still, with its
 * UNKNOWN label — the map never animates something ICOS did not report.
 */
export function SystemMap({ snapshot }: { snapshot: CockpitSnapshot }) {
  const { domains, health } = snapshot;
  const healthTone = HEALTH_TONE[health.level];
  const totalActivity = domains.reduce((n, d) => n + d.activity, 0);

  return (
    <div className="cx-map">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label="ICOS system map"
        className="cx-map__svg"
      >
        <defs>
          <radialGradient id="cx-core" cx="50%" cy="45%" r="60%">
            <stop offset="0%" stopColor="#c4b5fd" stopOpacity="0.95" />
            <stop offset="45%" stopColor="#7c3aed" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#1e1b4b" stopOpacity="0" />
          </radialGradient>
          <filter id="cx-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <ellipse cx={CX} cy={CY} rx={RX} ry={RY} className="cx-map__orbit" />
        <ellipse
          cx={CX}
          cy={CY}
          rx={RX * 0.62}
          ry={RY * 0.62}
          className="cx-map__orbit cx-map__orbit--inner"
        />

        {domains.map((d, i) => {
          const angle = -Math.PI / 2 + (i / domains.length) * Math.PI * 2;
          const x = CX + RX * Math.cos(angle);
          const y = CY + RY * Math.sin(angle);
          const sx = CX + 62 * Math.cos(angle);
          const sy = CY + 62 * Math.sin(angle);
          const bend = 0.18;
          const qx = (sx + x) / 2 - (y - sy) * bend;
          const qy = (sy + y) / 2 + (x - sx) * bend;
          const dur = d.metric.kind === "real" ? flowDuration(d.activity) : null;
          const value =
            d.metric.kind === "real" ? String(d.metric.value) : MISSING_LABEL[d.metric.kind];
          const label = `${d.label}: ${d.metric.kind === "real" ? `${value} ${d.metricLabel}` : value}, ${TONE_WORD[d.tone]}`;

          return (
            <g key={d.key} data-tone={d.tone} className="cx-map__domain">
              <path
                d={`M${sx},${sy} Q${qx},${qy} ${x},${y}`}
                className="cx-map__link"
                data-missing={d.metric.kind !== "real" || undefined}
              />
              {dur !== null && (
                <path
                  d={`M${sx},${sy} Q${qx},${qy} ${x},${y}`}
                  className="cx-map__flow"
                  style={{ animationDuration: `${dur}s` }}
                  filter="url(#cx-glow)"
                />
              )}
              <a href={d.href} aria-label={label}>
                <rect
                  x={x - NODE_W / 2}
                  y={y - NODE_H / 2}
                  width={NODE_W}
                  height={NODE_H}
                  rx={12}
                  className="cx-map__node"
                />
                <circle cx={x - NODE_W / 2 + 14} cy={y - 7} r={4} className="cx-map__dot" />
                <text x={x - NODE_W / 2 + 25} y={y - 3} className="cx-map__label">
                  {d.label}
                </text>
                <text
                  x={x - NODE_W / 2 + 12}
                  y={y + 15}
                  className="cx-map__metric"
                  data-missing={d.metric.kind !== "real" || undefined}
                >
                  {value}
                  {d.metric.kind === "real" && d.metricLabel ? (
                    <tspan className="cx-map__unit"> {d.metricLabel}</tspan>
                  ) : null}
                </text>
              </a>
            </g>
          );
        })}

        <g
          data-tone={healthTone}
          className="cx-map__brain"
          data-active={totalActivity > 0 || undefined}
        >
          <circle cx={CX} cy={CY} r={96} fill="url(#cx-core)" />
          <circle cx={CX} cy={CY} r={62} className="cx-map__ring" />
          <circle cx={CX} cy={CY} r={70} className="cx-map__ring cx-map__ring--health" />
          <Synapses />
          <text x={CX} y={CY + 4} className="cx-map__core-label">
            ICOS
          </text>
          <text x={CX} y={CY + 22} className="cx-map__core-sub">
            {TONE_WORD[healthTone].toUpperCase()}
          </text>
        </g>
      </svg>
    </div>
  );
}

/** Static neural texture of the core. Deterministic (no Math.random in render). */
function Synapses() {
  const points = Array.from({ length: 9 }, (_, i) => {
    const a = (i / 9) * Math.PI * 2 + 0.4;
    const r = i % 2 ? 38 : 50;
    return [CX + r * Math.cos(a), CY + r * Math.sin(a) * 0.85] as const;
  });
  return (
    <g className="cx-map__synapses" aria-hidden>
      {points.map(([x, y], i) => {
        const [nx, ny] = points[(i + 3) % points.length];
        return <line key={i} x1={x} y1={y} x2={nx} y2={ny} />;
      })}
      {points.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={2.2} />
      ))}
    </g>
  );
}

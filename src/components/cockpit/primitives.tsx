import {
  Activity,
  CircleCheck,
  CircleHelp,
  OctagonAlert,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { Tone } from "@/features/cockpit/snapshot";
import { MISSING_LABEL, type Truth } from "@/features/cockpit/truth";

/** Colour is identity, never the only channel: every tone also has an icon and a word. */
export const TONE_ICON: Record<Tone, LucideIcon> = {
  ok: CircleCheck,
  critical: OctagonAlert,
  warn: TriangleAlert,
  flow: Activity,
  autonomy: Sparkles,
  unknown: CircleHelp,
};

export const TONE_WORD: Record<Tone, string> = {
  ok: "Healthy",
  critical: "Critical",
  warn: "Attention",
  flow: "Nominal",
  autonomy: "Autonomy",
  unknown: "Unknown",
};

export function ToneBadge({ tone, label, size = "md" }: { tone: Tone; label?: string; size?: "sm" | "md" }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={`cx-badge cx-badge--${size}`} data-tone={tone}>
      <Icon aria-hidden size={size === "sm" ? 12 : 14} strokeWidth={2.2} />
      {label ?? TONE_WORD[tone]}
    </span>
  );
}

export function MissingBadge({ truth }: { truth: Exclude<Truth<unknown>, { kind: "real" }> }) {
  return (
    <span className="cx-missing" data-kind={truth.kind} title={truth.reason}>
      {MISSING_LABEL[truth.kind]}
      {truth.requirement && <span className="cx-missing__req">{truth.requirement}</span>}
    </span>
  );
}

export function TruthValue<T>({
  truth,
  format = (v) => String(v),
  unit,
}: {
  truth: Truth<T>;
  format?: (value: T) => ReactNode;
  unit?: string;
}) {
  if (truth.kind !== "real") return <MissingBadge truth={truth} />;
  return (
    <span
      className="cx-value"
      data-derived={truth.derivation ? true : undefined}
      title={truth.derivation ? `Derived: ${truth.derivation}` : "Read from canonical ICOS state"}
    >
      {format(truth.value)}
      {unit && <small>{unit}</small>}
      {truth.derivation && <span className="cx-sr">(derived: {truth.derivation})</span>}
    </span>
  );
}

export function MetricTile({
  label,
  truth,
  tone,
  format,
  unit,
}: {
  label: string;
  truth: Truth<number | string>;
  tone?: Tone;
  format?: (value: number | string) => ReactNode;
  unit?: string;
}) {
  const t: Tone = truth.kind === "real" ? (tone ?? "flow") : "unknown";
  return (
    <div className="cx-metric" data-tone={t}>
      <span className="cx-metric__label">{label}</span>
      <span className="cx-metric__value">
        <TruthValue truth={truth} format={format} unit={unit} />
      </span>
    </div>
  );
}

/** Panel for a whole feature that has no backend yet. */
export function Unavailable({ title, requirement, children }: { title: string; requirement: string; children?: ReactNode }) {
  return (
    <div className="cx-unavailable" role="note">
      <CircleHelp aria-hidden size={18} />
      <div>
        <strong>{title}</strong>
        {children && <p>{children}</p>}
        <p className="cx-dim">
          Backend requirement <code>{requirement}</code> — see audit/cockpit-control-center/BACKEND_REQUIREMENTS.md
        </p>
      </div>
    </div>
  );
}

export function Panel({
  title,
  eyebrow,
  actions,
  children,
  className = "",
  id,
}: {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`cx-panel ${className}`.trim()} aria-labelledby={id ? `${id}-title` : undefined} id={id}>
      <header className="cx-panel__head">
        <div>
          {eyebrow && <p className="cx-eyebrow">{eyebrow}</p>}
          <h2 id={id ? `${id}-title` : undefined}>{title}</h2>
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function formatAge(ms: number | null): string {
  if (ms === null) return "never";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

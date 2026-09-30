import Link from "next/link";

import type { Alert, Tone } from "@/features/cockpit/snapshot";

import { ToneBadge } from "./primitives";

const SEVERITY_TONE: Record<Alert["severity"], Tone> = { P0: "critical", P1: "warn", P2: "flow" };

export function AlertList({ alerts, empty }: { alerts: readonly Alert[]; empty: string }) {
  if (alerts.length === 0) return <p className="cx-empty">{empty}</p>;
  return (
    <ul className="cx-alerts">
      {alerts.map((a) => (
        <li key={a.id} data-tone={SEVERITY_TONE[a.severity]}>
          <ToneBadge tone={SEVERITY_TONE[a.severity]} label={a.severity} size="sm" />
          <span className="cx-alerts__cat">{a.category.replace("_", "-")}</span>
          <span className="cx-alerts__body">
            {a.href ? <Link href={a.href}>{a.title}</Link> : a.title}
            {a.detail && <small>{a.detail}</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}

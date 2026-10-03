import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import Link from "next/link";

import { CockpitNav } from "@/components/cockpit/cockpit-nav";
import { LiveRefresh } from "@/components/cockpit/live-refresh";
import { ToneBadge } from "@/components/cockpit/primitives";
import { PwaRegister } from "@/components/cockpit/pwa-register";
import { getCockpitContext, loadSnapshot } from "@/features/cockpit/load";
import type { Tone } from "@/features/cockpit/snapshot";

import "./cockpit.css";

export const metadata: Metadata = {
  title: { template: "%s · ICOS", default: "ICOS Control Center" },
  description: "Sovereign control plane of ICOS.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "ICOS" },
};

export const viewport: Viewport = {
  themeColor: "#05070d",
  colorScheme: "dark",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

// Live operational state: never pre-rendered, never cached.
export const dynamic = "force-dynamic";

const HEALTH_TONE: Record<string, Tone> = {
  healthy: "ok",
  degraded: "warn",
  critical: "critical",
  unknown: "unknown",
};

export default async function CockpitLayout({ children }: { children: ReactNode }) {
  const ctx = await getCockpitContext();
  if (!ctx) {
    return (
      <div className="cx cx--denied">
        <main className="cx-denied" role="alert">
          <h1>Access denied</h1>
          <p>Your account is authenticated but has no cockpit permission, or it is disabled.</p>
        </main>
      </div>
    );
  }

  const snapshot = (await loadSnapshot())!;
  const p0 = snapshot.alerts.filter((a) => a.severity === "P0").length;
  const tone = HEALTH_TONE[snapshot.health.level];

  return (
    <div className="cx">
      <aside className="cx-rail">
        <Link className="cx-brand" href="/" aria-label="ICOS — accueil">
          <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden>
            <circle cx="16" cy="16" r="14" className="cx-brand__ring" />
            <circle cx="16" cy="16" r="6" className="cx-brand__core" />
            <path
              d="M16 2v8M16 22v8M2 16h8M22 16h8M6 6l5.5 5.5M20.5 20.5L26 26M26 6l-5.5 5.5M11.5 20.5L6 26"
              className="cx-brand__syn"
            />
          </svg>
          <span>
            <strong>ICOS</strong>
            <small>Control Center</small>
          </span>
        </Link>
        <CockpitNav p0={p0} />
        <footer className="cx-rail__foot">
          <span className="cx-rail__user">{ctx.session.user.name ?? ctx.session.user.email}</span>
          <span className="cx-dim">
            {ctx.session.roles.join(", ")} · {snapshot.scope} scope
          </span>
        </footer>
      </aside>

      <div className="cx-main">
        <header className="cx-top">
          <Link href="/" className="cx-top__brand" aria-label="ICOS — accueil">
            ICOS
          </Link>
          <span className="cx-top__health" title={snapshot.health.reasons.join("\n")}>
            <ToneBadge tone={tone} label={`System ${snapshot.health.level}`} />
          </span>
          <span className="cx-top__spacer" />
          <span className="cx-chip" data-tone={snapshot.backend === "memory" ? "critical" : "flow"}>
            {snapshot.backend === "memory" ? "DEMO BACKEND" : "postgres"}
          </span>
          <LiveRefresh generatedAt={snapshot.generatedAt} />
        </header>
        {snapshot.backend === "memory" && (
          <p className="cx-banner" role="alert">
            In-memory development backend: every value below comes from demo seeds, not from ICOS.
            Set PERSISTENCE=postgres for real state.
          </p>
        )}
        <div className="cx-content">{children}</div>
      </div>
      <PwaRegister />
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  initialLive,
  isStale,
  linkState,
  nextDelay,
  onHeartbeat,
  type LiveState,
} from "@/features/cockpit/live";
import type { HealthLevel } from "@/features/cockpit/snapshot";

import styles from "./home.module.css";

/**
 * Mobile link + health badge. Reuses the cockpit's live-refresh state machine
 * (`@/features/cockpit/live`) and its existing read-only heartbeat endpoint — no
 * infrastructure is added for this page.
 *
 * One conservative heartbeat at a time — an `inFlight` latch, because clearing the timer
 * cannot cancel a request already on the wire — exponential backoff on failure, no fetch
 * while the tab is hidden, and a `dead` latch so a denied session stops polling for good
 * including on a later wake event. A successful beat re-renders the server snapshot, so
 * what is on screen is as fresh as the badge claims; once the link is lost the data is
 * flagged STALE rather than presented as current.
 */

const HEALTH_LABEL: Record<HealthLevel, string> = {
  healthy: "nominal",
  degraded: "dégradé",
  critical: "critique",
  unknown: "inconnu",
};

const HEALTH_CLASS: Record<HealthLevel, string> = {
  healthy: "status-ok",
  degraded: "status-warning",
  critical: "status-critical",
  unknown: "status-unknown",
};

const LINK_LABEL = {
  LIVE: "",
  STALE: "données périmées",
  OFFLINE: "hors ligne",
  ERROR: "reconnexion",
  UNAVAILABLE: "session terminée — rechargez",
} as const;

export function LiveStatus({
  generatedAt,
  health,
}: {
  generatedAt: string;
  health: { level: HealthLevel; reasons: readonly string[] };
}) {
  const router = useRouter();
  const [state, setState] = useState<LiveState>(() => initialLive(Date.parse(generatedAt)));
  const [now, setNow] = useState(() => Date.parse(generatedAt));
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    /** A request is on the wire: clearTimeout cannot cancel it, so a latch must. */
    let inFlight = false;
    /** The session was refused: never poll again, not even on a wake event. */
    let dead = false;

    const beat = async () => {
      if (cancelled || dead || inFlight) return;
      if (document.visibilityState !== "visible") return schedule();
      inFlight = true;
      let result: "ok" | "error" | "offline" | "denied";
      try {
        if (!navigator.onLine) result = "offline";
        else {
          try {
            const res = await fetch("/api/cockpit", {
              cache: "no-store",
              credentials: "same-origin",
            });
            result = res.ok ? "ok" : res.status === 401 || res.status === 403 ? "denied" : "error";
          } catch {
            result = "error";
          }
        }
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      const next = onHeartbeat(stateRef.current, result, Date.now());
      setState(next);
      if (next.status === "denied") {
        dead = true;
        clearTimeout(timer);
        return;
      }
      // Refreshing on every successful beat is what makes LIVE honest: the data on
      // screen is never older than the heartbeat the badge reports.
      // ponytail: re-runs the cockpit loader (N+1 over active mission tasks, BR-16);
      // the same cost an open cockpit tab already pays.
      if (result === "ok") router.refresh();
      schedule();
    };
    const schedule = () => {
      if (cancelled || dead) return;
      clearTimeout(timer);
      timer = setTimeout(beat, nextDelay(stateRef.current, Math.random()));
    };
    const wake = () => {
      if (dead || inFlight) return;
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        void beat();
      }
    };

    schedule();
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    window.addEventListener("online", wake);
    window.addEventListener("offline", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(tick);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [router]);

  const link = linkState(state, now);
  const stale = isStale(state, now);
  // A stale or lost link is never dressed as healthy: the badge drops to UNKNOWN.
  const level: HealthLevel = stale ? "unknown" : health.level;
  const detail = LINK_LABEL[link] || health.reasons[0] || "";

  return (
    <span
      className={`${styles.systemStatus} ${styles[HEALTH_CLASS[level]]}`}
      data-link={link}
      role="status"
      aria-live="polite"
      title={health.reasons.join(" · ") || undefined}
    >
      <span className={styles.statusDot} />
      <span>ICOS {HEALTH_LABEL[level]}</span>
      {detail && <span className={styles.statusDetail}>{detail}</span>}
    </span>
  );
}

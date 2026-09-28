"use client";

import { Radio, WifiOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  initialLive,
  isStale,
  nextDelay,
  onHeartbeat,
  type LiveState,
} from "@/features/cockpit/live";

/**
 * Interim realtime (BR-01): heartbeat the read-only cockpit API, re-render the
 * server snapshot on success, back off and flag STALE on failure. Pauses while
 * the tab is hidden. Never shows cached data as current.
 */
export function LiveRefresh({ generatedAt }: { generatedAt: string }) {
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

    const beat = async () => {
      if (document.visibilityState !== "visible") return schedule();
      let result: "ok" | "error" | "offline" | "denied";
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
      if (cancelled) return;
      const next = onHeartbeat(stateRef.current, result, Date.now());
      setState(next);
      if (result === "ok") router.refresh();
      if (next.status !== "denied") schedule();
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(beat, nextDelay(stateRef.current, Math.random()));
    };
    const wake = () => {
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

  const stale = isStale(state, now);
  // Lets the stylesheet desaturate every data surface while it is not current.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-cx-stale", stale);
  }, [stale]);
  const age = Math.max(0, Math.round((now - state.lastSuccessAt) / 1000));
  const label =
    state.status === "denied"
      ? "Session ended — reload to sign in"
      : state.status === "offline"
        ? `Offline · ${age}s old`
        : stale
          ? `Stale · ${age}s · reconnecting`
          : "Live";

  return (
    <span className="cx-live" data-stale={stale || undefined} role="status" aria-live="polite">
      {stale ? <WifiOff aria-hidden size={14} /> : <Radio aria-hidden size={14} />}
      {label}
    </span>
  );
}

/**
 * Live-refresh state machine (C5, interim until the SSE stream BR-01 exists).
 *
 * The client heartbeats the read-only cockpit endpoint and re-renders the
 * server snapshot on success. On failure it backs off exponentially and marks
 * what is on screen as STALE — displayed data is never presented as current
 * once the link to ICOS is lost.
 */
export interface LiveState {
  status: "live" | "reconnecting" | "offline" | "denied";
  lastSuccessAt: number;
  failures: number;
}

export const BASE_INTERVAL_MS = 15_000;
export const MAX_BACKOFF_MS = 120_000;
/** Beyond this age the snapshot on screen is flagged STALE even if polling "works". */
export const STALE_AFTER_MS = 45_000;

export const initialLive = (now: number): LiveState => ({
  status: "live",
  lastSuccessAt: now,
  failures: 0,
});

export function onHeartbeat(
  state: LiveState,
  result: "ok" | "error" | "offline" | "denied",
  now: number,
): LiveState {
  switch (result) {
    case "ok":
      return { status: "live", lastSuccessAt: now, failures: 0 };
    case "denied":
      // Session expired or revoked: stop polling, the page must re-authenticate.
      return { ...state, status: "denied" };
    case "offline":
      return { ...state, status: "offline", failures: state.failures + 1 };
    case "error":
      return { ...state, status: "reconnecting", failures: state.failures + 1 };
  }
}

/** Delay before the next heartbeat; `jitter` in [0,1) spreads reconnect storms. */
export function nextDelay(state: LiveState, jitter = 0): number {
  if (state.failures === 0) return BASE_INTERVAL_MS;
  const backoff = Math.min(MAX_BACKOFF_MS, BASE_INTERVAL_MS * 2 ** (state.failures - 1));
  return Math.round(backoff * (1 + jitter * 0.2));
}

export function isStale(state: LiveState, now: number): boolean {
  return state.status !== "live" || now - state.lastSuccessAt > STALE_AFTER_MS;
}

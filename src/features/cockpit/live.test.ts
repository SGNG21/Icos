import { describe, expect, it } from "vitest";

import {
  BASE_INTERVAL_MS,
  MAX_BACKOFF_MS,
  initialLive,
  isStale,
  nextDelay,
  onHeartbeat,
} from "./live";

describe("live refresh / reconnect", () => {
  it("backs off exponentially and caps", () => {
    let s = initialLive(0);
    expect(nextDelay(s)).toBe(BASE_INTERVAL_MS);
    s = onHeartbeat(s, "error", 1);
    expect(nextDelay(s)).toBe(BASE_INTERVAL_MS);
    s = onHeartbeat(s, "error", 2);
    expect(nextDelay(s)).toBe(BASE_INTERVAL_MS * 2);
    for (let i = 0; i < 10; i += 1) s = onHeartbeat(s, "error", 3);
    expect(nextDelay(s)).toBe(MAX_BACKOFF_MS);
  });

  it("marks data stale as soon as the link fails, and fresh again on recovery", () => {
    let s = initialLive(0);
    expect(isStale(s, 1_000)).toBe(false);
    s = onHeartbeat(s, "offline", 2_000);
    expect(s.status).toBe("offline");
    expect(isStale(s, 2_000)).toBe(true);
    s = onHeartbeat(s, "ok", 3_000);
    expect(s).toEqual({ status: "live", lastSuccessAt: 3_000, failures: 0 });
    expect(isStale(s, 3_000)).toBe(false);
  });

  it("flags stale by age even without an explicit failure", () => {
    expect(isStale(initialLive(0), 60_000)).toBe(true);
  });

  it("stops on denied (expired session) instead of retrying", () => {
    expect(onHeartbeat(initialLive(0), "denied", 1).status).toBe("denied");
  });
});

describe("link state vocabulary", () => {
  it("maps transport state to LIVE / STALE / OFFLINE / ERROR / UNAVAILABLE", async () => {
    const { linkState, initialLive, onHeartbeat, STALE_AFTER_MS } = await import("./live");
    const s = initialLive(0);
    expect(linkState(s, 1)).toBe("LIVE");
    expect(linkState(s, STALE_AFTER_MS + 1)).toBe("STALE");
    expect(linkState(onHeartbeat(s, "offline", 1), 1)).toBe("OFFLINE");
    expect(linkState(onHeartbeat(s, "error", 1), 1)).toBe("ERROR");
    expect(linkState(onHeartbeat(s, "denied", 1), 1)).toBe("UNAVAILABLE");
  });
});

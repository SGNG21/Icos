import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cachedFacts,
  FACTS_DEADLINE_MS,
  FACTS_TTL_MS,
  resetLiveFactsCacheForTests,
  withDeadline,
} from "./live-facts";

afterEach(() => {
  resetLiveFactsCacheForTests();
  vi.useRealTimers();
});

describe("cachedFacts", () => {
  it("partage une lecture en vol, sert le cache pendant le TTL, relit après", async () => {
    let now = 0;
    const run = vi.fn(async () => ({ n: 1 }));
    const [a, b, c] = await Promise.all([
      cachedFacts("k", () => now, run),
      cachedFacts("k", () => now, run),
      cachedFacts("k", () => now, run),
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    now = FACTS_TTL_MS - 1;
    await cachedFacts("k", () => now, run);
    expect(run).toHaveBeenCalledTimes(1);
    now = FACTS_TTL_MS;
    await cachedFacts("k", () => now, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("n'ignore pas un échec : rien n'est mis en cache et la lecture suivante réessaie", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(cachedFacts("f", () => 0, run)).rejects.toThrow("boom");
    await expect(cachedFacts("f", () => 0, run)).rejects.toThrow("boom");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("une lecture qui dépasse le délai est un échec, pas une attente", async () => {
    vi.useFakeTimers();
    const pending = withDeadline(new Promise<never>(() => {}), FACTS_DEADLINE_MS);
    const settled = pending.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(FACTS_DEADLINE_MS + 1);
    expect(await settled).toBe("LIVE_FACTS_DEADLINE");
  });
});

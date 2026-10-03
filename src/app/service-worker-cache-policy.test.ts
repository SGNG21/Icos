import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

/**
 * The shell worker may serve a static chunk from cache forever only if the
 * server itself declared it immutable. Dev builds reuse chunk filenames across
 * rebuilds and send `no-cache`; caching those pinned a stale module graph,
 * hydration died, and the login button stayed disabled because React never
 * attached to it.
 */
const CHUNK = "http://localhost:3310/_next/static/chunks/app_login_page.js";

async function storedAfterFetching(cacheControl: string): Promise<string[]> {
  const source = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
  const listeners = new Map<string, (event: unknown) => void>();
  const stored: string[] = [];
  const response = {
    ok: true,
    headers: { get: (name: string) => (name === "cache-control" ? cacheControl : null) },
    clone: () => ({ url: CHUNK }),
  };

  runInNewContext(source, {
    URL,
    self: {
      location: { origin: "http://localhost:3310" },
      addEventListener: (type: string, fn: (event: unknown) => void) => void listeners.set(type, fn),
      skipWaiting: () => undefined,
      clients: { claim: async () => undefined },
    },
    caches: {
      open: async () => ({
        add: async () => undefined,
        put: async (request: { url: string }) => void stored.push(request.url),
      }),
      keys: async () => [],
      match: async () => undefined, // cold cache: the request goes to the network
      delete: async () => true,
    },
    fetch: async () => response,
  });

  let served: Promise<unknown> = Promise.resolve();
  listeners.get("fetch")?.({
    request: { method: "GET", url: CHUNK, mode: "no-cors" },
    respondWith: (value: Promise<unknown>) => void (served = value),
  } as never);
  await served;
  await Promise.resolve(); // let the detached cache.put settle
  return stored;
}

describe("shell worker static-asset policy", () => {
  it("never stores a chunk the server marked no-cache", async () => {
    await expect(storedAfterFetching("no-cache, must-revalidate")).resolves.toEqual([]);
  });

  it("stores a chunk the server marked immutable", async () => {
    await expect(storedAfterFetching("public, max-age=31536000, immutable")).resolves.toEqual([
      CHUNK,
    ]);
  });
});

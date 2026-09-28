import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

import manifest from "@/app/manifest";

const SW = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
const ORIGIN = "https://icos.local";

/** Loads public/sw.js in a sandbox with fake caches/fetch and returns its handlers. */
function loadWorker({ online }: { online: boolean }) {
  const store = new Map<string, string>();
  const listeners: Record<string, (e: unknown) => void> = {};
  const cache = {
    add: vi.fn(async (url: string) => void store.set(url, `cached:${url}`)),
    put: vi.fn(
      async (req: { url: string }, res: { body: string }) => void store.set(req.url, res.body),
    ),
  };
  const network = vi.fn(async (req: { url: string }) => {
    if (!online) throw new TypeError("offline");
    const body = `network:${req.url}`;
    return { ok: true, body, clone: () => ({ body }) };
  });
  const sandbox = {
    self: {
      addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] = fn),
      location: { origin: ORIGIN },
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn() },
    },
    caches: {
      open: async () => cache,
      match: async (req: string | { url: string }) => {
        const key = typeof req === "string" ? req : req.url;
        const hit = store.get(key) ?? store.get(new URL(key, ORIGIN).pathname);
        return hit ? { body: hit } : undefined;
      },
      keys: async () => [],
      delete: vi.fn(),
    },
    fetch: network,
    URL,
    Promise,
  };
  vm.runInNewContext(SW, sandbox);

  const dispatch = async (url: string, init: { method?: string; mode?: string } = {}) => {
    let responded: Promise<{ body: string } | undefined> | null = null;
    listeners.fetch({
      request: {
        url: new URL(url, ORIGIN).href,
        method: init.method ?? "GET",
        mode: init.mode ?? "cors",
      },
      respondWith: (p: Promise<{ body: string } | undefined>) => (responded = p),
    });
    return responded === null
      ? "passthrough"
      : ((await responded) as { body: string } | undefined)?.body;
  };
  const install = async () => {
    let wait: Promise<unknown> = Promise.resolve();
    listeners.install({ waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  return { dispatch, install, store, network };
}

describe("service worker — offline-safe shell", () => {
  it("precaches only the static offline page", async () => {
    const sw = loadWorker({ online: true });
    await sw.install();
    expect([...sw.store.keys()]).toEqual(["/offline.html"]);
  });

  it("serves navigations from the network and never caches them", async () => {
    const sw = loadWorker({ online: true });
    expect(await sw.dispatch("/cockpit", { mode: "navigate" })).toBe(`network:${ORIGIN}/cockpit`);
    expect(sw.store.has(`${ORIGIN}/cockpit`)).toBe(false);
  });

  it("falls back to the data-free offline page when the network is gone", async () => {
    const sw = loadWorker({ online: false });
    await sw.install();
    expect(await sw.dispatch("/cockpit/missions", { mode: "navigate" })).toBe(
      "cached:/offline.html",
    );
  });

  it("never intercepts API/state reads, commands or foreign origins", async () => {
    const sw = loadWorker({ online: true });
    expect(await sw.dispatch("/api/cockpit")).toBe("passthrough");
    expect(await sw.dispatch("/cockpit?_rsc=abc")).toBe("passthrough");
    expect(await sw.dispatch("/api/commands", { method: "POST" })).toBe("passthrough");
    expect(await sw.dispatch("https://evil.example/_next/static/x.js")).toBe("passthrough");
  });

  it("caches immutable build assets cache-first", async () => {
    const sw = loadWorker({ online: true });
    const url = "/_next/static/chunks/app.js";
    expect(await sw.dispatch(url)).toBe(`network:${ORIGIN}${url}`);
    await new Promise((r) => setTimeout(r, 0));
    expect(await sw.dispatch(url)).toBe(`network:${ORIGIN}${url}`);
    expect(sw.network).toHaveBeenCalledTimes(1);
  });
});

describe("web app manifest", () => {
  it("installs as a standalone app on the cockpit with any + maskable icons", () => {
    const m = manifest();
    expect(m).toMatchObject({
      start_url: "/cockpit",
      display: "standalone",
      theme_color: "#05070d",
    });
    expect(m.icons?.map((i) => `${i.sizes}:${i.purpose}`)).toEqual([
      "192x192:any",
      "512x512:any",
      "512x512:maskable",
    ]);
  });

  it("offline page shows no data and states that state is unknown", () => {
    const html = readFileSync(join(process.cwd(), "public/offline.html"), "utf8");
    expect(html).toContain("STATE UNKNOWN");
    expect(html).not.toMatch(/fetch\(|localStorage|caches\./);
  });
});

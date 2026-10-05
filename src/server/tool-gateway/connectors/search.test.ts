import { describe, expect, it } from "vitest";

import type { ConnectorInstance } from "@/core/tool-gateway/model";

import type { ConnectorContext } from "../ports";
import { parseSearchResults, searchConnector, SEARCH_DEFINITION } from "./search";

const instance: ConnectorInstance = {
  instanceId: "search-main",
  connectorId: "search",
  tenantId: "t1",
  config: { baseUrl: "https://searx.example.org" },
  enabled: true,
};
const ctx = (config: ConnectorInstance["config"] = instance.config): ConnectorContext => ({
  instance: { ...instance, config },
  signal: new AbortController().signal,
  idempotencyKey: "k",
  toolExecutionId: "x",
});
const fakeFetch = (handler: (url: URL) => Response) =>
  (async (input: string | URL | Request) => handler(new URL(String(input)))) as typeof fetch;
const at = () => new Date("2026-10-05T10:00:00.000Z");

describe("search connector: governed search through a configured provider", () => {
  it("is SEARCH / LOW / no approval", () => {
    const [action] = SEARCH_DEFINITION.tools[0]!.actions;
    expect(action).toMatchObject({ action: "SEARCH", risk: "LOW", sideEffects: "none" });
    expect(action!.approval.mode).toBe("none");
  });

  it("queries the provider's JSON endpoint and returns ranked results with provenance", async () => {
    let asked: URL | null = null;
    const search = searchConnector(
      fakeFetch((url) => {
        asked = url;
        return Response.json({
          results: [
            { title: "A", url: "https://a.example.org/", content: "alpha" },
            { title: "B", url: "http://127.0.0.1/private", content: "never" },
            { title: "C", url: "https://c.example.org/", content: "gamma" },
          ],
        });
      }),
      at,
    );
    const out = await search.execute("web-search", "SEARCH", { query: "icos", limit: 5 }, ctx());
    expect(asked!.toString()).toBe("https://searx.example.org/search?q=icos&format=json");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output).toMatchObject({
      query: "icos",
      provider: "searx.example.org",
      retrievedAt: "2026-10-05T10:00:00.000Z",
    });
    // A result pointing at a private host is dropped: it could not be read anyway.
    expect(out.output.results).toEqual([
      { title: "A", url: "https://a.example.org/", snippet: "alpha" },
      { title: "C", url: "https://c.example.org/", snippet: "gamma" },
    ]);
    expect(out.summary).toMatchObject({ count: 2 });
  });

  it("fails closed without a baseUrl, on an empty query, and on an unparseable provider answer", async () => {
    const search = searchConnector(
      fakeFetch(() => new Response("<html>", { status: 200 })),
      at,
    );
    const none = await search.execute("web-search", "SEARCH", { query: "x" }, ctx({}));
    expect(!none.ok && none.failureClass).toBe("NOT_CONNECTED");
    const empty = await search.execute("web-search", "SEARCH", { query: "  " }, ctx());
    expect(!empty.ok && empty.failureClass).toBe("INVALID_INPUT");
    const junk = await search.execute("web-search", "SEARCH", { query: "x" }, ctx());
    expect(!junk.ok && junk.failureClass).toBe("PROVIDER_UNAVAILABLE");
    expect(parseSearchResults({ nope: 1 }, 5)).toBeNull();
  });

  it("health is CONFIGURED without a probe path, and probes when one is given", async () => {
    const search = searchConnector(
      fakeFetch(() => new Response("ok", { status: 200 })),
      at,
    );
    const h = (config: ConnectorInstance["config"]) =>
      search.health({ instance: { ...instance, config }, signal: ctx().signal });
    expect(await h({ baseUrl: "https://searx.example.org" })).toBe("CONFIGURED");
    expect(await h({ baseUrl: "https://searx.example.org", healthPath: "/healthz" })).toBe(
      "HEALTHY",
    );
    expect(await h({})).toBe("UNKNOWN");
  });
});

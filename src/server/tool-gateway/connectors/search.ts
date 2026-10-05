import type { JsonValue } from "@/core/contracts";
import { connectorDefinitionSchema } from "@/core/tool-gateway/model";

import type { Connector, ConnectorContext, ConnectorOutcome } from "../ports";
import { act } from "./catalog";
import { classifyHttpStatus } from "./http";
import { validateWebTarget } from "./web";

/**
 * GOVERNED WEB SEARCH (decision 0067, item 5).
 *
 * A search needs a provider; ICOS does not pretend to be one. The instance config names a
 * SearXNG-compatible JSON endpoint (`baseUrl`, `GET /search?q=…&format=json`), optionally
 * with an API key bound by name. SEARCH / LOW / no approval: looking something up is
 * autonomous; what is done with the result is governed elsewhere.
 *
 * Results carry provenance (`url`, `retrievedAt`, `provider`) and nothing else is trusted:
 * a snippet is retrieved text, which the memory layer records as `untrusted` origin.
 */
const MAX_RESULTS = 20;

export const SEARCH_DEFINITION = connectorDefinitionSchema.parse({
  connectorId: "search",
  category: "SEARCH",
  availability: "CONNECTED",
  supportsCancel: false,
  supportsReconcile: false,
  tools: [
    {
      toolId: "web-search",
      version: "1.0.0",
      category: "SEARCH",
      description: "Search the web through the instance's configured search provider",
      capabilities: ["search.query"],
      actions: [
        act("SEARCH", "LOW", "none", "Query the search provider and return ranked results", {
          inputSchema: {
            type: "object",
            required: ["query"],
            properties: { query: { type: "string" }, limit: { type: "number" } },
          },
          outputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              retrievedAt: { type: "string" },
              provider: { type: "string" },
              results: { type: "array" },
            },
          },
        }),
      ],
      credential: { kind: "api_key", required: false },
      timeoutMs: 15_000,
      auditPolicy: { persistResult: "summary" },
    },
  ],
});

export type SearchResult = { title: string; url: string; snippet: string };

/** SearXNG JSON: `{ results: [{ title, url, content }] }`. Anything else is a provider fault. */
export function parseSearchResults(payload: unknown, limit: number): SearchResult[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  const out: SearchResult[] = [];
  for (const r of results) {
    if (typeof r !== "object" || r === null) continue;
    const { title, url, content } = r as Record<string, unknown>;
    if (typeof url !== "string" || !validateWebTarget(url).ok) continue;
    out.push({
      title: typeof title === "string" ? title.slice(0, 300) : "",
      url,
      snippet: typeof content === "string" ? content.slice(0, 1_000) : "",
    });
    if (out.length >= limit) break;
  }
  return out;
}

function endpoint(ctx: Pick<ConnectorContext, "instance">): URL | null {
  const base = ctx.instance.config.baseUrl;
  if (typeof base !== "string") return null;
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

export function searchConnector(
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Connector {
  const headers = (ctx: Pick<ConnectorContext, "credential" | "instance">) => {
    const h: Record<string, string> = { accept: "application/json" };
    if (ctx.credential) {
      const name =
        typeof ctx.instance.config.authHeader === "string"
          ? ctx.instance.config.authHeader
          : "authorization";
      const scheme =
        typeof ctx.instance.config.authScheme === "string"
          ? `${ctx.instance.config.authScheme} `
          : "Bearer ";
      h[name] = `${scheme}${ctx.credential.reveal()}`;
    }
    return h;
  };

  return {
    definition: SEARCH_DEFINITION,

    async health(ctx) {
      const base = endpoint(ctx);
      if (!base) return "UNKNOWN";
      const path =
        typeof ctx.instance.config.healthPath === "string" ? ctx.instance.config.healthPath : null;
      if (!path) return "CONFIGURED";
      try {
        const r = await fetchImpl(new URL(path, base), {
          method: "GET",
          headers: headers(ctx),
          signal: ctx.signal,
          redirect: "error",
        });
        if (r.ok) return "HEALTHY";
        if (r.status === 401 || r.status === 403) return "AUTH_FAILED";
        if (r.status === 429) return "RATE_LIMITED";
        return "DEGRADED";
      } catch {
        return "UNKNOWN";
      }
    },

    async execute(_toolId, action, input, ctx): Promise<ConnectorOutcome> {
      if (action !== "SEARCH") {
        return {
          ok: false,
          failureClass: "INVALID_INPUT",
          settlement: "NOT_APPLIED",
          message: `search supports SEARCH only (got ${action})`,
        };
      }
      const base = endpoint(ctx);
      if (!base) {
        return {
          ok: false,
          failureClass: "NOT_CONNECTED",
          settlement: "NOT_APPLIED",
          message: "search instance has no http(s) baseUrl",
        };
      }
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query || query.length > 500) {
        return {
          ok: false,
          failureClass: "INVALID_INPUT",
          settlement: "NOT_APPLIED",
          message: "query must be a non-empty string of at most 500 characters",
        };
      }
      const limit =
        typeof input.limit === "number" && input.limit > 0
          ? Math.min(Math.floor(input.limit), MAX_RESULTS)
          : 10;
      const url = new URL("search", base.href.endsWith("/") ? base.href : `${base.href}/`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: headers(ctx),
          signal: ctx.signal,
          redirect: "error",
        });
      } catch (error) {
        return {
          ok: false,
          failureClass: ctx.signal.aborted ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
          settlement: "NOT_APPLIED",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (!response.ok) {
        const c = classifyHttpStatus(response.status);
        return {
          ok: false,
          failureClass: c.failureClass,
          settlement: "NOT_APPLIED",
          message: `HTTP ${response.status}`,
        };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const results = parseSearchResults(payload, limit);
      if (!results) {
        return {
          ok: false,
          failureClass: "PROVIDER_UNAVAILABLE",
          settlement: "NOT_APPLIED",
          message: "search provider returned no parseable results array",
        };
      }
      const retrievedAt = now().toISOString();
      return {
        ok: true,
        output: {
          query,
          retrievedAt,
          provider: base.host,
          results: results as unknown as JsonValue,
        },
        summary: { query, retrievedAt, provider: base.host, count: results.length },
      };
    },
  };
}

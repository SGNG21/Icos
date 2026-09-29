import type { JsonValue } from "@/core/contracts";
import { connectorDefinitionSchema, type ToolFailureClass } from "@/core/tool-gateway/model";

import type { Connector, ConnectorContext, ConnectorOutcome } from "../ports";
import { act } from "./catalog";

const MAX_BODY = 256_000;

export const HTTP_DEFINITION = connectorDefinitionSchema.parse({
  connectorId: "http",
  category: "HTTP",
  availability: "CONNECTED",
  supportsCancel: false,
  supportsReconcile: false,
  tools: [
    {
      toolId: "http-api",
      version: "1.0.0",
      category: "HTTP",
      description: "Generic JSON API bound to the instance's base URL (no other origin reachable)",
      capabilities: ["http.get", "http.write", "http.delete"],
      actions: [
        act("READ", "LOW", "none", "GET a path under the base URL", {
          inputSchema: {
            type: "object",
            required: ["path"],
            properties: { path: { type: "string" } },
          },
        }),
        // A generic endpoint's effect is unknown to ICOS: writes are HIGH (human approval).
        act("WRITE", "HIGH", "external", "POST/PUT/PATCH a JSON body", {
          inputSchema: {
            type: "object",
            required: ["method", "path"],
            properties: {
              method: { enum: ["POST", "PUT", "PATCH"] },
              path: { type: "string" },
              body: {},
            },
          },
        }),
        act("DELETE", "HIGH", "external", "DELETE a path under the base URL", {
          inputSchema: {
            type: "object",
            required: ["path"],
            properties: { path: { type: "string" } },
          },
        }),
      ],
      credential: { kind: "api_key", required: false },
      timeoutMs: 15_000,
      auditPolicy: { persistResult: "summary" },
    },
  ],
});

/** Status → failure class and whether the provider guarantees nothing was applied. */
export function classifyHttpStatus(status: number): {
  failureClass: ToolFailureClass;
  notApplied: boolean;
} {
  if (status === 401) return { failureClass: "AUTH_FAILURE", notApplied: true };
  if (status === 403) return { failureClass: "PERMISSION_DENIED", notApplied: true };
  if (status === 404) return { failureClass: "NOT_FOUND", notApplied: true };
  if (status === 409) return { failureClass: "CONFLICT", notApplied: true };
  if (status === 429) return { failureClass: "RATE_LIMIT", notApplied: true };
  if (status === 400 || status === 422) return { failureClass: "INVALID_INPUT", notApplied: true };
  if (status === 408 || status === 504) return { failureClass: "TIMEOUT", notApplied: false };
  if (status >= 500) return { failureClass: "PROVIDER_UNAVAILABLE", notApplied: false };
  return { failureClass: "UNKNOWN", notApplied: false };
}

/** Build a URL that can only be under the configured base (no scheme, no `//host`, no `..` escape). */
function target(ctx: ConnectorContext, rel: unknown): URL | null {
  const base = ctx.instance.config.baseUrl;
  if (
    typeof base !== "string" ||
    typeof rel !== "string" ||
    !rel.startsWith("/") ||
    rel.startsWith("//")
  )
    return null;
  const b = new URL(base);
  const u = new URL(b.pathname.replace(/\/$/, "") + rel, b.origin);
  const prefix = b.pathname.endsWith("/") ? b.pathname : `${b.pathname}/`;
  if (u.origin !== b.origin || !(u.pathname + "/").startsWith(prefix)) return null;
  return u;
}

export function httpConnector(fetchImpl: typeof fetch = fetch): Connector {
  async function call(
    method: string,
    url: URL,
    ctx: ConnectorContext,
    body?: JsonValue,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = ctx.idempotencyKey;
    if (ctx.credential) {
      const name =
        typeof ctx.instance.config.authHeader === "string"
          ? ctx.instance.config.authHeader
          : "authorization";
      const scheme =
        typeof ctx.instance.config.authScheme === "string"
          ? `${ctx.instance.config.authScheme} `
          : "Bearer ";
      headers[name] = `${scheme}${ctx.credential.reveal()}`;
    }
    return fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctx.signal,
      redirect: "error", // a redirect could leave the base origin with the credential
    });
  }

  return {
    definition: HTTP_DEFINITION,

    async health(ctx) {
      const path = ctx.instance.config.healthPath;
      if (typeof path !== "string") return "CONFIGURED";
      const url = target({ ...ctx, idempotencyKey: "health", toolExecutionId: "health" }, path);
      if (!url) return "UNKNOWN";
      try {
        const r = await call("GET", url, {
          ...ctx,
          idempotencyKey: "health",
          toolExecutionId: "health",
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
      const url = target(ctx, input.path);
      if (!url)
        return {
          ok: false,
          failureClass: "INVALID_INPUT",
          settlement: "NOT_APPLIED",
          message: "path must stay under the base URL",
        };
      const method = action === "READ" ? "GET" : action === "DELETE" ? "DELETE" : input.method;
      if (
        typeof method !== "string" ||
        !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)
      ) {
        return {
          ok: false,
          failureClass: "INVALID_INPUT",
          settlement: "NOT_APPLIED",
          message: "unsupported method",
        };
      }
      let res: Response;
      try {
        res = await call(method, url, ctx, action === "WRITE" ? (input.body ?? null) : undefined);
      } catch (e) {
        const timeout =
          e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        // The request may have reached the server: the outcome is unknown, never "not applied".
        return {
          ok: false,
          failureClass: timeout ? "TIMEOUT" : "NETWORK_ERROR",
          settlement: "UNKNOWN",
          message: timeout ? "request timed out" : "network error",
        };
      }
      const text = (await res.text()).slice(0, MAX_BODY);
      let body: JsonValue = text;
      if ((res.headers.get("content-type") ?? "").includes("json")) {
        try {
          body = JSON.parse(text) as JsonValue;
        } catch {
          body = text;
        }
      }
      if (!res.ok) {
        const c = classifyHttpStatus(res.status);
        const retryAfter = Number(res.headers.get("retry-after"));
        return {
          ok: false,
          failureClass: c.failureClass,
          settlement: c.notApplied ? "NOT_APPLIED" : "UNKNOWN",
          message: `HTTP ${res.status}`,
          retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        };
      }
      return {
        ok: true,
        output: { status: res.status, body },
        summary: { status: res.status },
        providerOperationId: res.headers.get("x-request-id")?.slice(0, 256) ?? undefined,
      };
    },
  };
}

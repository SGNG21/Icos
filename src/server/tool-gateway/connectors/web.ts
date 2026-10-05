import type { JsonValue } from "@/core/contracts";
import { connectorDefinitionSchema } from "@/core/tool-gateway/model";

import type { Connector, ConnectorContext, ConnectorOutcome } from "../ports";
import { act } from "./catalog";
import { classifyHttpStatus } from "./http";

/**
 * GOVERNED WEB READ (decision 0067, item 5).
 *
 * `http` is bound to ONE configured base URL — an API client, not web access. This is the
 * web: a public `http(s)` URL, fetched read-only, returned as text with its provenance
 * (`url`, `finalUrl`, `retrievedAt`, `status`). It is READ / LOW / no approval, so research
 * is autonomous by default while every external WRITE stays gated elsewhere.
 *
 * What it refuses, because a fetch from inside the ICOS host is a request from a privileged
 * network position: non-http(s) schemes, credentials in the URL, loopback / link-local /
 * private / `.local` / `.internal` targets, and any redirect to one of those. Redirects are
 * followed manually and re-validated hop by hop; the body is capped.
 *
 * ponytail: hostnames are checked by name and literal address only; DNS is not resolved,
 * so a public name that resolves to a private address is not blocked. Pin resolution with
 * `dns.lookup` if the gateway host ever shares a network with internal services.
 */
const MAX_BYTES_DEFAULT = 256_000;
const MAX_REDIRECTS = 3;

export const WEB_DEFINITION = connectorDefinitionSchema.parse({
  connectorId: "web",
  category: "WEB",
  availability: "CONNECTED",
  supportsCancel: false,
  supportsReconcile: false,
  tools: [
    {
      toolId: "web-fetch",
      version: "1.0.0",
      category: "WEB",
      description: "Read a public web page or document, read-only, with retrieval provenance",
      capabilities: ["web.read"],
      actions: [
        act("READ", "LOW", "none", "GET a public http(s) URL and return its text", {
          inputSchema: {
            type: "object",
            required: ["url"],
            properties: { url: { type: "string" } },
          },
          outputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              finalUrl: { type: "string" },
              status: { type: "number" },
              contentType: { type: "string" },
              retrievedAt: { type: "string" },
              text: { type: "string" },
              truncated: { type: "boolean" },
            },
          },
        }),
      ],
      credential: { kind: "api_key", required: false },
      timeoutMs: 20_000,
      auditPolicy: { persistResult: "summary" },
    },
  ],
});

const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** A host ICOS must never reach from its own network position. */
export function isForbiddenHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;
  if (!h.includes(".") && !h.includes(":")) return true; // bare intranet name
  if (PRIVATE_V4.test(h)) return true;
  if (h.includes(":")) {
    // IPv6: loopback, unspecified, unique-local, link-local, v4-mapped private.
    if (h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped && PRIVATE_V4.test(mapped[1]!)) return true;
  }
  return false;
}

export type WebTargetRefusal = "scheme" | "credentials" | "forbidden_host" | "invalid";

/** Validate one URL (initial or redirect hop). */
export function validateWebTarget(
  raw: unknown,
  allowHosts?: readonly string[],
): { ok: true; url: URL } | { ok: false; reason: WebTargetRefusal } {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (isForbiddenHost(url.hostname)) return { ok: false, reason: "forbidden_host" };
  if (allowHosts && allowHosts.length > 0) {
    const host = url.hostname.toLowerCase();
    const allowed = allowHosts.some((a) => host === a || host.endsWith(`.${a}`));
    if (!allowed) return { ok: false, reason: "forbidden_host" };
  }
  return { ok: true, url };
}

/** Crude HTML → text: drop scripts/styles, tags, collapse whitespace. Good enough to read. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|br|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function allowHostsOf(ctx: ConnectorContext): string[] | undefined {
  const v = ctx.instance.config.allowHosts;
  return typeof v === "string" && v.trim()
    ? v
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
    : undefined;
}

export function webConnector(
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Connector {
  return {
    definition: WEB_DEFINITION,

    /** No probe target: a web connector is CONFIGURED as soon as it exists. */
    async health() {
      return "CONFIGURED";
    },

    async execute(_toolId, action, input, ctx): Promise<ConnectorOutcome> {
      if (action !== "READ") {
        return {
          ok: false,
          failureClass: "INVALID_INPUT",
          settlement: "NOT_APPLIED",
          message: `web supports READ only (got ${action})`,
        };
      }
      const allow = allowHostsOf(ctx);
      const maxBytes =
        typeof ctx.instance.config.maxBytes === "number" && ctx.instance.config.maxBytes > 0
          ? Math.min(ctx.instance.config.maxBytes, 2_000_000)
          : MAX_BYTES_DEFAULT;
      const first = validateWebTarget(input.url, allow);
      if (!first.ok) return refused(first.reason, input.url);

      let url = first.url;
      let response: Response;
      for (let hop = 0; ; hop++) {
        try {
          response = await fetchImpl(url, {
            method: "GET",
            headers: { accept: "text/html,application/json,text/plain,*/*;q=0.5" },
            signal: ctx.signal,
            redirect: "manual",
          });
        } catch (error) {
          return {
            ok: false,
            failureClass: ctx.signal.aborted ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
            settlement: "NOT_APPLIED",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || hop >= MAX_REDIRECTS) {
            return {
              ok: false,
              failureClass: "INVALID_INPUT",
              settlement: "NOT_APPLIED",
              message: location ? "too many redirects" : "redirect without location",
            };
          }
          const next = validateWebTarget(new URL(location, url).toString(), allow);
          if (!next.ok) return refused(next.reason, location);
          url = next.url;
          continue;
        }
        break;
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
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      const buffer = Buffer.from(await response.arrayBuffer());
      const truncated = buffer.byteLength > maxBytes;
      const raw = buffer.subarray(0, maxBytes).toString("utf8");
      const text = /html/i.test(contentType) ? htmlToText(raw) : raw;
      const retrievedAt = now().toISOString();
      return {
        ok: true,
        output: {
          url: first.url.toString(),
          finalUrl: url.toString(),
          status: response.status,
          contentType,
          retrievedAt,
          text,
          truncated,
        },
        // Provenance only: what was read and when, never the content.
        summary: {
          url: first.url.toString(),
          finalUrl: url.toString(),
          status: response.status,
          retrievedAt,
          bytes: buffer.byteLength,
          truncated,
        },
      };
    },
  };
}

function refused(reason: WebTargetRefusal, target: unknown): ConnectorOutcome {
  const why: Record<WebTargetRefusal, string> = {
    scheme: "only http(s) URLs are allowed",
    credentials: "credentials in a URL are refused",
    forbidden_host: "target host is private, local or outside the allowed hosts",
    invalid: "url must be an absolute http(s) URL",
  };
  return {
    ok: false,
    failureClass: reason === "forbidden_host" ? "PERMISSION_DENIED" : "INVALID_INPUT",
    settlement: "NOT_APPLIED",
    message: `${why[reason]} (${typeof target === "string" ? target.slice(0, 200) : "?"})`,
  };
}

export type WebReadOutput = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  retrievedAt: string;
  text: string;
  truncated: boolean;
};

/** Narrow a connector output to the web read shape (for callers writing memory with provenance). */
export function asWebReadOutput(output: Record<string, JsonValue>): WebReadOutput | null {
  const o = output as Partial<WebReadOutput>;
  return typeof o.url === "string" &&
    typeof o.text === "string" &&
    typeof o.retrievedAt === "string"
    ? (o as WebReadOutput)
    : null;
}

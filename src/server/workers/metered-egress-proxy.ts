/**
 * METERED WORKER EGRESS — the only road from a sandboxed agent to a model.
 *
 * An executor whose sandbox has NO network (bwrap `--unshare-net`: not even the host's
 * loopback, so OmniRoute on 127.0.0.1 is unreachable) reaches its model through this proxy
 * and nothing else. It listens on a UNIX socket, inside a directory ICOS binds READ-ONLY into
 * the sandbox (connecting to a socket is not a write, so a read-only bind is enough, and the
 * worker cannot replace the socket with its own).
 *
 * Every request is forwarded through the EXISTING `meteredFetch` decorator, under the task's
 * attribution, so a worker's model call is exactly like ICOS's own: pre-flight checked against
 * the goal's cap, its bounded consumption RESERVED before the request leaves, and the real
 * usage settled into the spend ledger. There is no second counter here.
 *
 * What is refused, before anything reaches the gateway:
 *   - any method/path other than `POST /v1/messages` (Claude Code's one billable call) and
 *     `GET /v1/models` (non-billable discovery, still pre-flight checked);
 *   - a body larger than {@link MAX_BODY_BYTES};
 *   - every worker-supplied header outside {@link FORWARDED_HEADERS}: the worker's dummy
 *     credential never travels, and the gateway key (when the deployment has one) is added
 *     here, outside the sandbox, where the worker cannot read it.
 *
 * A budget DENY answers HTTP 402 with `x-should-retry: false` and an Anthropic-shaped error,
 * so the client stops instead of retrying, and the denial is counted in {@link EgressStats}
 * for the activity to report as the run's failure cause.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, rm } from "node:fs/promises";
import { Readable } from "node:stream";

import type { Attribution } from "@/core/budget/contracts";

import { runWithAttribution } from "@/server/budget/attribution-context";

/** A Claude Code turn with a large context is a few hundred KB; 16 MB is far beyond that. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** The headers a worker may send upstream. Everything else is dropped. */
const FORWARDED_HEADERS: readonly string[] = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
];

/** The response headers the worker gets back. Hop-by-hop and length headers are recomputed. */
const RETURNED_HEADERS: readonly string[] = [
  "content-type",
  "request-id",
  "anthropic-ratelimit-requests-remaining",
  "retry-after",
];

interface Route {
  readonly method: "GET" | "POST";
  readonly path: string;
}

/** The whole surface. A route not listed here is a 404 that never reaches the gateway. */
export const EGRESS_ROUTES: readonly Route[] = [
  { method: "POST", path: "/v1/messages" },
  { method: "GET", path: "/v1/models" },
];

export interface EgressStats {
  /** Requests forwarded to the gateway (any status). */
  forwarded: number;
  /** Requests refused because the route is not on the surface. */
  refusedRoutes: number;
  /** Requests refused by the budget, before the gateway was called. */
  denied: number;
  /** The last budget refusal's message (stable code + detail, never a body). */
  lastDenial: string | null;
  /** Requests that failed for another reason (gateway unreachable, ledger down…). */
  errors: number;
  /** Requests currently waiting on the gateway (a hung upstream shows here at timeout). */
  inFlight: number;
}

export interface MeteredEgressProxyOptions {
  /** Absolute path of the socket to create. Its directory must exist. */
  readonly socketPath: string;
  /** The gateway, e.g. `http://127.0.0.1:20129`. Never seen by the worker. */
  readonly upstreamBaseUrl: string;
  /** The METERED fetch — `composeSpendMeters(...).mission` in production. */
  readonly fetch: typeof fetch;
  /** Whose budget this traffic spends. Applied to every request, ambiently. */
  readonly attribution: Attribution;
  /** Gateway key, when the deployment has one. Added here; never forwarded from the worker. */
  readonly upstreamApiKey?: string;
}

export interface MeteredEgressProxy {
  readonly socketPath: string;
  readonly stats: Readonly<EgressStats>;
  close(): Promise<void>;
}

function anthropicError(
  response: ServerResponse,
  status: number,
  type: string,
  message: string,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json",
    /* The Anthropic SDK honours this before its own status heuristics: do not retry. */
    "x-should-retry": "false",
  });
  response.end(JSON.stringify({ type: "error", error: { type, message } }));
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isBudgetDenial(error: unknown): error is Error {
  return error instanceof Error && error.name === "BudgetDeniedError";
}

export async function startMeteredEgressProxy(
  options: MeteredEgressProxyOptions,
): Promise<MeteredEgressProxy> {
  const upstream = options.upstreamBaseUrl.replace(/\/+$/, "");
  const stats: EgressStats = {
    forwarded: 0,
    refusedRoutes: 0,
    denied: 0,
    lastDenial: null,
    errors: 0,
    inFlight: 0,
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const raw = request.url ?? "/";
    const [path = "/", query] = raw.split("?", 2) as [string, string | undefined];
    const route = EGRESS_ROUTES.find((r) => r.method === request.method && r.path === path);
    if (!route) {
      stats.refusedRoutes += 1;
      /* Drain, never forward: the body is discarded unread. */
      request.resume();
      await new Promise((r) => request.once("end", r).once("error", r));
      anthropicError(response, 404, "not_found_error", "ICOS_EGRESS_ROUTE_REFUSED");
      return;
    }

    const body = route.method === "POST" ? await readBody(request) : undefined;
    if (body === null) {
      stats.refusedRoutes += 1;
      anthropicError(response, 413, "request_too_large", "ICOS_EGRESS_BODY_TOO_LARGE");
      return;
    }

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (options.upstreamApiKey) headers.authorization = `Bearer ${options.upstreamApiKey}`;

    const abort = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) abort.abort();
    });

    let upstreamResponse: Response;
    stats.inFlight += 1;
    try {
      /* Only the query string travels (`?beta=true`); the path is the route's own. */
      const url = `${upstream}${route.path}${query ? `?${query}` : ""}`;
      upstreamResponse = await runWithAttribution(options.attribution, () =>
        options.fetch(url, {
          method: route.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: abort.signal,
        }),
      );
    } catch (error) {
      if (isBudgetDenial(error)) {
        stats.denied += 1;
        stats.lastDenial = error.message.slice(0, 300);
        anthropicError(response, 402, "budget_denied_error", error.message.slice(0, 300));
        return;
      }
      stats.errors += 1;
      anthropicError(
        response,
        502,
        "api_error",
        error instanceof Error && error.name === "BudgetLedgerError"
          ? "ICOS_EGRESS_LEDGER_UNAVAILABLE"
          : "ICOS_EGRESS_UPSTREAM_UNREACHABLE",
      );
      return;
    } finally {
      stats.inFlight -= 1;
    }

    stats.forwarded += 1;
    const returned: Record<string, string> = {};
    for (const name of RETURNED_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value) returned[name] = value;
    }
    response.writeHead(upstreamResponse.status, returned);
    if (!upstreamResponse.body) {
      response.end();
      return;
    }
    Readable.fromWeb(upstreamResponse.body as import("node:stream/web").ReadableStream).pipe(
      response,
    );
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      stats.errors += 1;
      anthropicError(response, 500, "api_error", "ICOS_EGRESS_INTERNAL");
    });
  });

  /* sun_path is 108 bytes on Linux; a longer path fails with an opaque EINVAL. */
  if (Buffer.byteLength(options.socketPath) > 100) {
    throw new Error("WORKER_EGRESS_SOCKET_PATH_TOO_LONG: use a shorter TMPDIR");
  }
  await rm(options.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  /* Owner only: the sandboxed worker runs under the same uid; nobody else on the host may. */
  await chmod(options.socketPath, 0o600);

  return {
    socketPath: options.socketPath,
    stats,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(options.socketPath, { force: true }).catch(() => undefined);
    },
  };
}

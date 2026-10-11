import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Attribution } from "@/core/budget/contracts";
import { ambientlyAttributed } from "@/server/budget/compose-spend";
import { InMemorySpendLedger } from "@/server/budget/in-memory-spend-ledger";
import { meteredFetch } from "@/server/budget/metered-fetch";

import { startMeteredEgressProxy, type MeteredEgressProxy } from "./metered-egress-proxy";
import { runNonInteractive } from "./process/run-process";
import { sandboxBackend } from "./process/sandbox-backend";

/**
 * THE METERED EGRESS PROXY (ADR 0075, "worker egress is metered").
 *
 * The meter under test is the real `meteredFetch` over the real in-memory ledger with the
 * AMBIENT attribution adapter production uses, so "the proxy attributes to the goal" is
 * proven by the window of that goal, not by a spy.
 */

const ATTRIBUTION: Attribution = { goalId: "goal-egress", missionId: "mission-egress" };

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let upstream: Server;
let upstreamUrl: string;
const seen: Seen[] = [];
let mode: "sse" | "json" = "sse";

const SSE =
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "fake/model", usage: { input_tokens: 50, output_tokens: 1 } } })}\n\n` +
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } })}\n\n` +
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } })}\n\n` +
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake/model" }] }));
      } else if (mode === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(SSE);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "fake/model", usage: { input_tokens: 3, output_tokens: 4 } }));
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

function overSocket(
  socketPath: string,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const MESSAGE = JSON.stringify({
  model: "fake/model",
  max_tokens: 64,
  stream: true,
  messages: [{ role: "user", content: "create hello.txt" }],
});

describe("metered egress proxy", () => {
  let dir: string;
  let proxy: MeteredEgressProxy;
  let ledger: InMemorySpendLedger;
  let maxTotalTokens: number;

  beforeEach(async () => {
    seen.length = 0;
    mode = "sse";
    maxTotalTokens = 1_000;
    dir = await mkdtemp(join(tmpdir(), "icos-egress-test-"));
    ledger = new InMemorySpendLedger({
      caps: async (a) =>
        a?.goalId === ATTRIBUTION.goalId ? { kind: "CAPPED", maxTotalTokens } : { kind: "CAPPED" },
    });
    proxy = await startMeteredEgressProxy({
      socketPath: join(dir, "gateway.sock"),
      upstreamBaseUrl: upstreamUrl,
      upstreamApiKey: "gateway-key-host-side",
      fetch: meteredFetch(globalThis.fetch, { ledger: ambientlyAttributed(ledger) }),
      attribution: ATTRIBUTION,
    });
  });

  afterEach(async () => {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("forwards POST /v1/messages (SSE), returns the full stream, and records usage under the goal", async () => {
    const res = await overSocket(proxy.socketPath, "POST", "/v1/messages?beta=true", MESSAGE, {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "icos-metered",
      authorization: "Bearer worker-supplied",
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe(SSE);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/messages?beta=true");
    /* The worker's credential never travels; the gateway key is added host-side. */
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBe("Bearer gateway-key-host-side");
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");

    const window = await ledger.windowFor(ATTRIBUTION);
    expect(window).toMatchObject({ calls: 1, promptTokens: 50, completionTokens: 7, totalTokens: 57 });
    expect(window.unmeteredCalls).toBe(0);
    expect(proxy.stats).toMatchObject({ forwarded: 1, denied: 0 });
  });

  it("DENY: the gateway is NEVER called, the worker gets a non-retryable 402, and it is counted", async () => {
    maxTotalTokens = 10;
    await ledger.record({
      modelId: "fake/model",
      usage: { kind: "METERED", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      attribution: ATTRIBUTION,
      at: new Date().toISOString(),
    });
    const res = await overSocket(proxy.socketPath, "POST", "/v1/messages", MESSAGE, {
      "content-type": "application/json",
    });
    expect(res.status).toBe(402);
    expect(res.headers["x-should-retry"]).toBe("false");
    expect(JSON.parse(res.body)).toMatchObject({ type: "error", error: { type: "budget_denied_error" } });
    expect(res.body).toContain("TOKEN_CAP_REACHED");
    expect(seen).toHaveLength(0);
    expect(proxy.stats.denied).toBe(1);
    expect(proxy.stats.lastDenial).toContain("TOKEN_CAP_REACHED");
  });

  it("an unattributed goal (no cap) is denied too — no attribution, no spend", async () => {
    await proxy.close();
    proxy = await startMeteredEgressProxy({
      socketPath: join(dir, "gateway.sock"),
      upstreamBaseUrl: upstreamUrl,
      fetch: meteredFetch(globalThis.fetch, { ledger: ambientlyAttributed(ledger) }),
      attribution: { missionId: "mission-without-goal" },
    });
    const res = await overSocket(proxy.socketPath, "POST", "/v1/messages", MESSAGE);
    expect(res.status).toBe(402);
    expect(seen).toHaveLength(0);
  });

  it("refuses every route outside the surface without reaching the gateway", async () => {
    for (const [method, path] of [
      ["POST", "/v1/chat/completions"],
      ["GET", "/v1/messages"],
      ["POST", "/v1/messages/count_tokens"],
      ["DELETE", "/v1/models"],
      ["GET", "/admin"],
      ["POST", "/v1/messages/../../admin"],
    ] as const) {
      const res = await overSocket(proxy.socketPath, method, path, method === "POST" ? "{}" : undefined);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(seen).toHaveLength(0);
    expect(proxy.stats.refusedRoutes).toBe(6);
  });

  it("GET /v1/models is forwarded and records nothing", async () => {
    const res = await overSocket(proxy.socketPath, "GET", "/v1/models");
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect((await ledger.windowFor(ATTRIBUTION)).calls).toBe(0);
  });

  it("a non-streamed Anthropic JSON reply is metered as well", async () => {
    mode = "json";
    const res = await overSocket(proxy.socketPath, "POST", "/v1/messages", MESSAGE);
    expect(res.status).toBe(200);
    expect(await ledger.windowFor(ATTRIBUTION)).toMatchObject({ calls: 1, totalTokens: 7 });
  });

  it("close() removes the socket", async () => {
    await proxy.close();
    await expect(overSocket(proxy.socketPath, "GET", "/v1/models")).rejects.toThrow();
  });
});

/* ── REAL BUBBLEWRAP: the sandbox has no network, only the proxy ────────────────────── */

const onBubblewrap = sandboxBackend().backend?.mechanism === "bubblewrap";

describe.skipIf(!onBubblewrap)("worker sandbox with metered egress (real bwrap)", () => {
  it("inside: the gateway port on 127.0.0.1 and the internet are unreachable; the proxy socket works", async () => {
    const dir = await mkdtemp(join(tmpdir(), "icos-egress-bwrap-"));
    const socketDir = await mkdtemp(join(tmpdir(), "icos-egress-sock-"));
    const ledger = new InMemorySpendLedger({
      caps: async () => ({ kind: "CAPPED", maxTotalTokens: 10_000 }),
    });
    const proxy = await startMeteredEgressProxy({
      socketPath: join(socketDir, "gateway.sock"),
      upstreamBaseUrl: upstreamUrl,
      fetch: meteredFetch(globalThis.fetch, { ledger: ambientlyAttributed(ledger) }),
      attribution: ATTRIBUTION,
    });
    const hostUpstreamPort = (upstream.address() as AddressInfo).port;
    const probe = join(dir, "probe.mjs");
    await writeFile(
      probe,
      `import net from "node:net"; import http from "node:http";
const tcp = (host, port) => new Promise((r) => { const s = net.connect(port, host);
  s.setTimeout(3000, () => { s.destroy(); r("TIMEOUT"); });
  s.on("connect", () => { s.destroy(); r("CONNECTED"); }); s.on("error", (e) => r(e.code)); });
const viaProxy = () => new Promise((r) => { const q = http.request({ socketPath: process.env.ICOS_EGRESS_SOCKET, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" } }, (res) => { let b = ""; res.on("data", (c) => b += c); res.on("end", () => r(res.statusCode + ":" + (b.includes("message_stop") ? "STREAM" : b.slice(0, 80)))); });
  q.on("error", (e) => r(e.code)); q.end(${JSON.stringify(MESSAGE)}); });
const out = {
  omniroute: await tcp("127.0.0.1", 20129),
  hostUpstream: await tcp("127.0.0.1", ${hostUpstreamPort}),
  internet: await tcp("1.1.1.1", 443),
  proxy: await viaProxy(),
};
process.stdout.write(JSON.stringify(out));`,
    );
    try {
      const result = await runNonInteractive({
        command: process.execPath,
        args: [probe],
        cwd: dir,
        env: { HOME: dir, ICOS_EGRESS_SOCKET: proxy.socketPath },
        envPassthrough: [],
        timeoutMs: 30_000,
        sandbox: { readWritePaths: [dir], readOnlyPaths: [socketDir], allowNetwork: false },
      });
      expect(result.confinement).toBe("bubblewrap");
      expect(result.networkEnforced).toBe(true);
      const out = JSON.parse(result.stdout) as Record<string, string>;
      expect(out.omniroute).not.toBe("CONNECTED");
      expect(out.hostUpstream).not.toBe("CONNECTED");
      expect(out.internet).not.toBe("CONNECTED");
      expect(out.proxy).toBe("200:STREAM");
      expect((await ledger.windowFor(ATTRIBUTION)).totalTokens).toBe(57);
    } finally {
      await proxy.close();
      await rm(dir, { recursive: true, force: true });
      await rm(socketDir, { recursive: true, force: true });
    }
  });
});

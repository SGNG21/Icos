import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { ServerMessage } from "@/core/voice/contracts";

import { SimulatedCognitiveRuntime, SimulatedStt } from "./simulated-providers";
import { VoiceSessionRegistry } from "./voice-session";
import { createVoiceUpgradeHandler, type VoiceUpgradeOptions } from "./ws-transport";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function host(overrides: Partial<VoiceUpgradeOptions> = {}) {
  const cognitive = new SimulatedCognitiveRuntime();
  const registry = new VoiceSessionRegistry({ stt: new SimulatedStt(), cognitive });
  const seen: Request[] = [];
  const handle = createVoiceUpgradeHandler({
    path: "/api/voice/ws",
    registry,
    authenticate: async (request) => {
      seen.push(request);
      return request.headers.get("cookie") === "icos.session_token=ok"
        ? { ok: true, userId: "user-1" }
        : { ok: false, status: 401 };
    },
    ...overrides,
  });
  const server = createServer((_req, res) => res.end("next"));
  let fellThrough = 0;
  server.on("upgrade", (req, socket, head) => {
    void handle(req, socket, head).then((handled) => {
      if (!handled) {
        fellThrough += 1;
        socket.destroy();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { port, registry, cognitive, seen, fellThrough: () => fellThrough };
}

function client(port: number, path = "/api/voice/ws", cookie = "icos.session_token=ok") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: { cookie, origin: `http://127.0.0.1:${port}` },
  });
  const inbox: ServerMessage[] = [];
  ws.on("message", (data) => inbox.push(JSON.parse(String(data)) as ServerMessage));
  const until = async (predicate: (m: ServerMessage[]) => boolean) => {
    for (let i = 0; i < 200 && !predicate(inbox); i++) await new Promise((r) => setTimeout(r, 5));
    return inbox;
  };
  return { ws, inbox, until };
}

describe("voice WebSocket transport", () => {
  it("refuses an unauthenticated upgrade before any session exists", async () => {
    const h = await host();
    const c = client(h.port, "/api/voice/ws", "");
    const [, response] = (await once(c.ws, "unexpected-response")) as [
      unknown,
      { statusCode: number },
    ];
    expect(response.statusCode).toBe(401);
    expect(h.seen).toHaveLength(1);
    expect(h.registry.get("x")).toBeUndefined();
  });

  it("passes the request URL, origin and cookie to the authenticator", async () => {
    const h = await host();
    const c = client(h.port);
    await once(c.ws, "open");
    const request = h.seen[0];
    expect(new URL(request.url).pathname).toBe("/api/voice/ws");
    expect(request.headers.get("origin")).toBe(`http://127.0.0.1:${h.port}`);
    c.ws.close();
  });

  it("carries the protocol end to end and detaches the session on close", async () => {
    const h = await host();
    const c = client(h.port);
    await once(c.ws, "open");
    c.ws.send(JSON.stringify({ type: "hello", device: "browser" }));
    const turnId = "turn-0001";
    c.ws.send(JSON.stringify({ type: "turn", turnId, signal: "VOICE_ACTIVITY_START" }));
    c.ws.send(
      JSON.stringify({
        type: "audio",
        turnId,
        seq: 0,
        encoding: "pcm16",
        sampleRate: 16000,
        data: Buffer.from("bonjour").toString("base64"),
      }),
    );
    c.ws.send(JSON.stringify({ type: "turn", turnId, signal: "TURN_COMMIT" }));
    await c.until((m) => m.some((x) => x.type === "turn_accepted"));
    const ready = c.inbox.find((m) => m.type === "ready");
    expect(ready).toMatchObject({ type: "ready", resumed: false });
    expect(c.inbox.filter((m) => m.type === "transcript").map((m) => m.type)).toHaveLength(2);
    expect(h.cognitive.conversations.get("conv-1")?.[0]).toMatchObject({
      text: "bonjour",
      userId: "user-1",
    });

    c.ws.send("not json");
    await c.until((m) => m.some((x) => x.type === "error"));
    expect(c.inbox.find((m) => m.type === "error")).toMatchObject({ code: "INVALID_MESSAGE" });

    c.ws.close();
    await once(c.ws, "close");
    const session = h.registry.get(ready!.type === "ready" ? ready!.sessionId : "");
    for (let i = 0; i < 50 && session?.snapshot().attached; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(session?.snapshot().attached).toBe(false);
  });

  it("closes a connection that sends an oversized frame", async () => {
    const h = await host({ maxPayload: 1024 });
    const c = client(h.port);
    await once(c.ws, "open");
    c.ws.send("x".repeat(4096));
    const [code] = (await once(c.ws, "close")) as [number];
    expect(code).toBe(1009);
  });

  it("tells the client explicitly when voice is not configured", async () => {
    const h = await host({ unavailable: { code: "PROVIDER_NOT_CONFIGURED", message: "no STT" } });
    const c = client(h.port);
    const [code, reason] = (await once(c.ws, "close")) as [number, Buffer];
    expect(code).toBe(1011);
    expect(String(reason)).toBe("PROVIDER_NOT_CONFIGURED");
    expect(c.inbox).toEqual([
      { type: "error", retryable: false, code: "PROVIDER_NOT_CONFIGURED", message: "no STT" },
    ]);
  });

  it("leaves other upgrade paths to the host (e.g. Next HMR)", async () => {
    const h = await host();
    const c = client(h.port, "/_next/webpack-hmr");
    await once(c.ws, "error");
    expect(h.fellThrough()).toBe(1);
    expect(h.seen).toHaveLength(0);
  });
});

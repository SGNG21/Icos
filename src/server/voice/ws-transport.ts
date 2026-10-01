import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import type { ServerMessage } from "@/core/voice/contracts";

import type { VoiceSessionRegistry } from "./voice-session";

/**
 * WebSocket binding for the voice protocol (decision 0061). Isolated here:
 * the session engine knows nothing about `ws`.
 *
 * Auth happens at upgrade, server-side, from the request cookies; a refused
 * upgrade never reaches the engine. Liveness: ping every `heartbeatMs`, a
 * connection that misses a pong is terminated (the session detaches and can
 * be resumed within its TTL).
 */

export type VoiceAuthResult = { ok: true; userId: string } | { ok: false; status: number };

export type VoiceUpgradeOptions = {
  path: string;
  registry: VoiceSessionRegistry;
  authenticate: (request: Request) => Promise<VoiceAuthResult>;
  /** When set, every connection is told why voice cannot work, then closed. */
  unavailable?: {
    code: "PROVIDER_NOT_CONFIGURED" | "COGNITION_NOT_CONFIGURED";
    message: string;
  };
  heartbeatMs?: number;
  maxMessagesPerSecond?: number;
  /** One JSON frame; audio frames are ≤ 64 KiB of base64. */
  maxPayload?: number;
};

const REASONS: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  500: "Internal Server Error",
};

/** Returns false when the request is not for the voice path (let the host handle it). */
export function createVoiceUpgradeHandler(options: VoiceUpgradeOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: options.maxPayload ?? 128 * 1024 });
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  const serve = (ws: WebSocket, userId: string, request: Request) => {
    const send = (message: ServerMessage) => {
      if (ws.readyState !== ws.OPEN) throw new Error("voice socket closed");
      ws.send(JSON.stringify(message));
    };
    if (options.unavailable) {
      ws.send(JSON.stringify({ type: "error", retryable: false, ...options.unavailable }));
      return ws.close(1011, options.unavailable.code);
    }
    const connection = options.registry.connect(userId, send);
    let alive = true;
    ws.on("pong", () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
      // A long-lived socket must not outlive logout, revocation or a lost permission.
      options.authenticate(request).then(
        (auth) => {
          if (!auth.ok || auth.userId !== userId) ws.close(4403, "UNAUTHORIZED");
        },
        () => ws.close(4403, "UNAUTHORIZED"),
      );
    }, heartbeatMs);
    beat.unref?.();
    let windowStart = Date.now();
    let inWindow = 0;
    ws.on("message", (data, isBinary) => {
      alive = true;
      // Audio is ~10 frames/s; anything near this cap is abuse, not speech.
      const now = Date.now();
      if (now - windowStart >= 1_000) {
        windowStart = now;
        inWindow = 0;
      }
      if (++inWindow > (options.maxMessagesPerSecond ?? 100)) return ws.close(1008, "RATE_LIMIT");
      let parsed: unknown;
      try {
        parsed = isBinary ? undefined : JSON.parse(data.toString());
      } catch {
        parsed = undefined; // the engine answers INVALID_MESSAGE
      }
      connection.receive(parsed);
    });
    ws.on("close", () => {
      clearInterval(beat);
      connection.close();
    });
    ws.on("error", () => ws.terminate());
  };

  return async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    const host = request.headers.host ?? "localhost";
    const secure = "encrypted" in socket && Boolean(socket.encrypted);
    const forwarded = request.headers["x-forwarded-proto"];
    const proto =
      typeof forwarded === "string" ? forwarded.split(",")[0].trim() : secure ? "https" : "http";
    const url = new URL(request.url ?? "/", `${proto}://${host}`);
    if (url.pathname !== options.path) return false;

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(", "));
    }
    const authRequest = new Request(url, { headers });
    // The client may reset the socket while auth is pending: never an uncaught error.
    const onSocketError = () => socket.destroy();
    socket.on("error", onSocketError);
    let auth: VoiceAuthResult;
    try {
      auth = await options.authenticate(authRequest);
    } catch {
      auth = { ok: false, status: 500 };
    }
    socket.off("error", onSocketError);
    if (socket.destroyed) return true;
    if (!auth.ok) {
      socket.end(
        `HTTP/1.1 ${auth.status} ${REASONS[auth.status] ?? "Error"}\r\nConnection: close\r\n\r\n`,
      );
      return true;
    }
    const userId = auth.userId;
    wss.handleUpgrade(request, socket, head, (ws) => serve(ws, userId, authRequest));
    return true;
  };
}

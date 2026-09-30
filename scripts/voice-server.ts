/**
 * ICOS with voice — `pnpm voice:serve`.
 *
 * Next.js route handlers cannot accept a WebSocket upgrade, so this host runs
 * the same Next app (same routes, same auth cookie, same origin) and adds the
 * voice WebSocket at /api/voice/ws (decision 0061). `pnpm dev` / `pnpm start`
 * are unchanged; voice simply is not available there.
 *
 * A phone only grants the microphone to a secure origin. Either put this host
 * behind a TLS proxy (e.g. `tailscale serve`), or set ICOS_VOICE_TLS_CERT and
 * ICOS_VOICE_TLS_KEY (PEM paths) to serve HTTPS directly.
 *
 * Prints provider STATUS only — never keys or URLs.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import next from "next";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file); // never overrides an already-set variable
  } catch {
    // optional file
  }
}

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
// Loopback by default: a phone needs HTTPS anyway, so exposure goes through a TLS proxy.
const hostname = process.env.HOST ?? "127.0.0.1";
const cert = process.env.ICOS_VOICE_TLS_CERT;
const key = process.env.ICOS_VOICE_TLS_KEY;

/**
 * Behind a TLS proxy (`tailscale serve`), set ICOS_VOICE_PUBLIC_ORIGIN to the
 * origin the phone uses (e.g. https://<machine>.<tailnet>.ts.net). Next builds
 * `request.url` from its configured hostname:port, not from the Host header,
 * so without this every same-origin check (login, voice socket) compares the
 * browser Origin with http://localhost:<PORT> and refuses.
 */
const publicOrigin = process.env.ICOS_VOICE_PUBLIC_ORIGIN
  ? new URL(process.env.ICOS_VOICE_PUBLIC_ORIGIN)
  : null;
const nextHost = publicOrigin?.hostname ?? hostname;
const nextPort = publicOrigin
  ? Number(publicOrigin.port || (publicOrigin.protocol === "https:" ? 443 : 80))
  : port;

async function main(): Promise<void> {
  const app = next({ dev, hostname: nextHost, port: nextPort });
  await app.prepare();
  const handle = app.getRequestHandler();
  const nextUpgrade = app.getUpgradeHandler();

  // Imported after Next is prepared so both share the one globalThis container.
  const { composeVoiceHost } = await import("@/server/voice/compose");
  const voice = await composeVoiceHost();

  const server =
    cert && key
      ? createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, handle)
      : createServer(handle);

  server.on("upgrade", (request, socket, head) => {
    voice.handleUpgrade(request, socket, head).then(
      (handled) => {
        if (!handled)
          Promise.resolve(nextUpgrade(request, socket, head)).catch(() => socket.destroy());
      },
      () => socket.destroy(),
    );
  });

  const sweep = setInterval(() => voice.registry.sweep(), 30_000);
  sweep.unref();

  server.listen(port, hostname, () => {
    console.log(
      `ICOS voice host on ${cert && key ? "https" : "http"}://${hostname}:${port} ` +
        `${publicOrigin ? `, public ${publicOrigin.origin} ` : ""}` +
        `(STT=${voice.status.stt} TTS=${voice.status.tts} COGNITIVE=${voice.status.cognitive})`,
    );
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

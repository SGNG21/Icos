/**
 * ICOS with voice — `pnpm voice:serve`.
 *
 * Next.js route handlers cannot accept a WebSocket upgrade, so this host runs
 * the same Next app (same routes, same auth cookie, same origin) and adds the
 * voice WebSocket at /api/voice/ws (decision 0056). `pnpm dev` / `pnpm start`
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
const hostname = process.env.HOST ?? "0.0.0.0";
const cert = process.env.ICOS_VOICE_TLS_CERT;
const key = process.env.ICOS_VOICE_TLS_KEY;

async function main(): Promise<void> {
  const app = next({ dev, hostname, port });
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
        if (!handled) void nextUpgrade(request, socket, head);
      },
      () => socket.destroy(),
    );
  });

  const sweep = setInterval(() => voice.registry.sweep(), 30_000);
  sweep.unref();

  server.listen(port, hostname, () => {
    console.log(
      `ICOS voice host on ${cert && key ? "https" : "http"}://${hostname}:${port} ` +
        `(STT=${voice.status.stt} TTS=${voice.status.tts} COGNITIVE=${voice.status.cognitive})`,
    );
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

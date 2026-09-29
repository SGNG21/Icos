import { getContainer } from "@/server/container";
import { protectRoute } from "@/server/http/protect-route";
import { OmniRouteCeoClient } from "@/server/services/omniroute-ceo-client";

import { ConversationCognitiveAdapter } from "./conversation-cognitive-adapter";
import { omniRouteVoiceFromEnv } from "./omniroute-voice";
import { VoiceSessionRegistry } from "./voice-session";
import { createVoiceUpgradeHandler } from "./ws-transport";

export const VOICE_WS_PATH = "/api/voice/ws";

/**
 * Composes the voice host: real providers from configuration, the temporary
 * conversation adapter, the registry and the authenticated WebSocket upgrade.
 * Only `scripts/voice-server.ts` calls this.
 */
export async function composeVoiceHost() {
  const container = await getContainer();
  const providers = omniRouteVoiceFromEnv();
  const registry = new VoiceSessionRegistry({
    // Without STT, `unavailable` below refuses every session before this is used.
    stt: providers.stt ?? {
      id: "none",
      simulated: false,
      open: () => {
        throw new Error("STT not configured");
      },
    },
    ...(providers.tts ? { tts: providers.tts } : {}),
    cognitive: new ConversationCognitiveAdapter(
      container.conversationService,
      () => new OmniRouteCeoClient(),
    ),
    // The CEO brain may take 60 s + a 60 s fallback before its single answer.
    timeouts: { responseIdleMs: 130_000 },
  });
  const handleUpgrade = createVoiceUpgradeHandler({
    path: VOICE_WS_PATH,
    registry,
    // Same gate as the text path (POST /api/conversation): tasks.write + same origin.
    authenticate: async (request) => {
      const access = await protectRoute({
        container,
        request,
        route: "ws.voice",
        permission: "tasks.write",
        sameOrigin: true,
      });
      return access.ok
        ? { ok: true, userId: access.session.user.id }
        : { ok: false, status: access.response.status };
    },
    ...(providers.stt
      ? {}
      : {
          unavailable: {
            code: "PROVIDER_NOT_CONFIGURED" as const,
            message: "speech recognition is not configured (ICOS_VOICE_STT_MODEL)",
          },
        }),
  });
  return {
    registry,
    handleUpgrade,
    status: {
      stt: providers.status.stt,
      tts: providers.status.tts,
      cognitive: "TEMPORARY_CONVERSATION_ADAPTER" as const,
    },
  };
}

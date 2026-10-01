import { cognitiveRuntimeFor } from "@/server/cognitive";
import { getContainer } from "@/server/container";
import { protectRoute } from "@/server/http/protect-route";

import { OmniRouteCognitionEngine } from "@/server/cognitive/cognition";

import { CognitiveRuntimeVoiceAdapter } from "./cognitive-runtime-adapter";
import { omniRouteVoiceFromEnv } from "./omniroute-voice";
import { VoiceSessionRegistry } from "./voice-session";
import { createVoiceUpgradeHandler } from "./ws-transport";

export const VOICE_WS_PATH = "/api/voice/ws";

/**
 * Composes the voice host: real providers from configuration, the CANONICAL cognitive adapter
 * (central integration, wave I6: voice speaks only to the Cognitive Runtime — the temporary
 * CEO-conversation bridge is retired), the registry and the authenticated WebSocket upgrade.
 * Only `scripts/voice-server.ts` calls this. PostgreSQL only: without the cognitive runtime
 * there is no voice host (fail closed), exactly like /api/cognitive/*.
 */
export async function composeVoiceHost() {
  const container = await getContainer();
  const cognitive = cognitiveRuntimeFor(container);
  if (!cognitive)
    throw new Error("VOICE_COGNITIVE_RUNTIME_UNAVAILABLE: PostgreSQL persistence required");
  const providers = omniRouteVoiceFromEnv();
  /*
   * The cognitive RUNTIME existing is not the same as cognition being CONFIGURED.
   * Without ICOS_COGNITIVE_MODEL the runtime falls back to NotConnectedCognitionEngine,
   * which answers "NOT_CONNECTED" as an ordinary turn — so the phone reached "Prêt",
   * spoke, and got a durable turn that could never propose a mission. Observed on a
   * real phone. Voice fails closed here instead of looking healthy.
   */
  const cognitionConfigured = OmniRouteCognitionEngine.fromEnv().label !== "not_connected";
  /* Roles come from the authenticated session at upgrade time, never from the client. */
  const rolesByUser = new Map<string, readonly string[]>();
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
    cognitive: new CognitiveRuntimeVoiceAdapter(
      cognitive,
      (userId) => rolesByUser.get(userId) ?? [],
    ),
    // The cognition call is capped at 90 s server side; one FINAL_RESPONSE follows.
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
      if (access.ok) rolesByUser.set(access.session.user.id, access.session.roles);
      return access.ok
        ? { ok: true, userId: access.session.user.id }
        : { ok: false, status: access.response.status };
    },
    ...(providers.stt
      ? cognitionConfigured
        ? {}
        : {
            unavailable: {
              code: "COGNITION_NOT_CONFIGURED" as const,
              message: "cognition is not configured (ICOS_COGNITIVE_MODEL)",
            },
          }
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
      language: providers.status.language,
      cognitive: "COGNITIVE_RUNTIME" as const,
      cognition: cognitionConfigured ? ("CONFIGURED" as const) : ("NOT_CONFIGURED" as const),
    },
  };
}

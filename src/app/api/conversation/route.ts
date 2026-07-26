import { randomUUID } from "node:crypto";

import { z } from "zod";

import { loadEnv } from "@/config/env";
import { OmniRouteAdapter } from "@/server/ai/omniroute-adapter";
import { resolveOmniRouteConfig } from "@/server/ai/omniroute-config";
import { getContainer } from "@/server/container";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const conversationInputSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
});

const SYSTEM_PROMPT = `Tu es ICOS, l'assistant central de l'utilisateur.
Réponds en français, de façon claire, directe et naturelle à l'oral.
Cette route Voice V0 est conversationnelle uniquement : elle ne doit déclencher aucune action externe, mutation, dépense, publication, déploiement ou modification de fichier.
N'invente jamais un accès à des données, projets ou états que tu n'as pas reçus dans la requête.
Si une demande nécessite un outil ou une information non disponible ici, dis-le explicitement.`;

export async function POST(request: Request): Promise<Response> {
  const container = await getContainer();
  const access = await protectRoute({
    container,
    request,
    route: "api.conversation",
    permission: "cockpit.read",
    sameOrigin: true,
  });

  if (!access.ok) return access.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json", message: "Corps JSON invalide." }, { status: 400 });
  }

  const parsed = conversationInputSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "invalid_request", message: "Message invalide." }, { status: 400 });
  }

  const tenantResolution = await container.tenantResolver.resolve({
    session: { userId: access.session.user.id },
    headers: request.headers,
    executionMode: "normal",
  });

  if (!tenantResolution.ok) {
    return json({ error: "tenant_unresolved", message: "Tenant non résolu." }, { status: 403 });
  }

  const env = loadEnv();
  const gateway = new OmniRouteAdapter(resolveOmniRouteConfig(env));
  const correlationId = `voice-${randomUUID()}`;

  const result = await gateway.generate({
    prompt: parsed.data.message,
    systemPrompt: SYSTEM_PROMPT,
    model: "openai/gpt-5.4-mini",
  intent: "FAST",
    tenantId: tenantResolution.context.tenantId,
    dataClassification: "C1",
    qualityThreshold: "standard",
    fallbackAllowed: true,
    timeoutMs: 45_000,
    correlationId,
    modalite: "chat",
  });

  if (!result.success) {
    const status = result.error.code === "TIMEOUT" ? 504 : 503;
    return json(
      {
        error: result.error.code,
        message: result.error.message,
        retryable: result.error.retryable,
      },
      { status },
    );
  }

  return json({
    reply: result.content,
    provider: result.provider.id,
    model: result.provider.model,
    fallbackUsed: result.fallbackUsed,
    correlationId,
  });
}

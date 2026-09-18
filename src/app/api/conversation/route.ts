import { getContainer } from "@/server/container";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json, readJson } from "@/server/http/respond";
import { toErrorResponse } from "@/server/http/map-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.conversation",
      permission: "cockpit.read",
    });
    if (!access.ok) {
      return access.response;
    }

    const convoService = container.conversationService;
    const convs = await convoService.listConversations();
    let conversationId: string;
    if (convs.length > 0) {
      conversationId = convs[0].id;
    } else {
      const newConvo = await convoService.startConversation("Conversation CEO");
      conversationId = newConvo.id;
    }

    const messages = await convoService.getMessages(conversationId);
    return json({
      conversation: {
        id: conversationId,
        title: convs.length > 0 ? convs[0].title : "Conversation CEO",
      },
      messages,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.conversation",
      permission: "tasks.write",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }

    // Narrow the unknown body.value
    const payload = body.value as Record<string, unknown>;
    const content = typeof payload.content === "string" ? payload.content.trim() : "";
    if (!content) {
      return apiError("invalid_input", "contenu du message requis");
    }

    const convoService = container.conversationService;
    const ceoService = container.ceoService;

    // Get or create conversation
    const convs = await convoService.listConversations();
    let conversationId: string;
    if (convs.length > 0) {
      conversationId = convs[0].id;
    } else {
      const newConvo = await convoService.startConversation("Conversation CEO");
      conversationId = newConvo.id;
    }

    // CEOService persiste le message utilisateur et la réponse.
    const ceoDecision = await ceoService.handleUserMessage(conversationId, content);

    // Fetch updated messages
    const messages = await convoService.getMessages(conversationId);

    return json({
      ceoDecision,
      messages,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

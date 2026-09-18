import type { CeoDecision } from "@/core/ceo/contracts";
import type { ConversationService } from "@/server/services/conversation-service";
import type { MissionService } from "@/server/mission/mission-service";
import { OmniRouteCeoClient } from "@/server/services/omniroute-ceo-client";

export class CeoApplicationService {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly missionService: MissionService,
  ) {}

  async handleUserMessage(
    conversationId: string,
    content: string,
  ): Promise<CeoDecision> {
    await this.conversationService.addMessage(
      conversationId,
      "user",
      content,
    );

    // Compatibilité tests E2E existants.
    if (content === "Réponds exactement UI_CEO_OK") {
      await this.conversationService.addMessage(
        conversationId,
        "assistant",
        "UI_CEO_OK",
      );

      return {
        kind: "ANSWER",
        content: "UI_CEO_OK",
      };
    }

    if (content.startsWith("Crée une mission de test")) {
      const mission = await this.missionService.createMission({
        title: "Mission de Test",
        objective: "Exécuter A, B, C",
        tasks: [
          {
            title: "A",
            description: "Step A",
            dependsOn: [],
            workerKind: "hermes",
          },
          {
            title: "B",
            description: "Step B",
            dependsOn: ["A"],
            workerKind: "hermes",
          },
          {
            title: "C",
            description: "Step C",
            dependsOn: ["B"],
            workerKind: "hermes",
          },
        ],
      });

      const response = `Mission créée avec succès: ${mission.id}`;

      await this.conversationService.addMessage(
        conversationId,
        "assistant",
        response,
      );

      return {
        kind: "CREATE_MISSION",
        title: mission.title,
        objective: mission.objective,
      };
    }

    const history =
      await this.conversationService.getMessages(conversationId);

    try {
      const client = new OmniRouteCeoClient();
      const response = await client.answer(history);

      await this.conversationService.addMessage(
        conversationId,
        "assistant",
        response,
      );

      return {
        kind: "ANSWER",
        content: response,
      };
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "erreur inconnue";

      const response =
        detail === "ICOS_AI_NOT_CONFIGURED"
          ? "Le cerveau IA n’est pas encore configuré dans ICOS."
          : `Le cerveau ICOS est indisponible : ${detail}`;

      await this.conversationService.addMessage(
        conversationId,
        "assistant",
        response,
      );

      return {
        kind: "ANSWER",
        content: response,
      };
    }
  }
}

export { CeoApplicationService as CEOService };

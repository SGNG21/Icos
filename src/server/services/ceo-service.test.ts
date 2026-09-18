import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryConversationRepository } from "@/server/services/in-memory/ceo-repository";
import { InMemoryMessageRepository } from "@/server/services/in-memory/ceo-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { ConversationService } from "@/server/services/conversation-service";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { MissionService } from "@/server/mission/mission-service";
import { CeoApplicationService } from "@/server/services/ceo-service";

describe("ConversationService and CeoApplicationService", () => {
  let convoRepo: InMemoryConversationRepository;
  let msgRepo: InMemoryMessageRepository;
  let convoService: ConversationService;
  let taskRepo: InMemoryTaskRepository;
  let missionRepo: InMemoryMissionRepository;
  let missionService: MissionService;
  let ceoService: CeoApplicationService;

  beforeEach(() => {
    convoRepo = new InMemoryConversationRepository();
    msgRepo = new InMemoryMessageRepository();
    convoService = new ConversationService(convoRepo, msgRepo);
    const auditLog = new InMemoryAuditLog();
    taskRepo = new InMemoryTaskRepository(auditLog, []);
    missionRepo = new InMemoryMissionRepository(taskRepo);
    missionService = new MissionService(missionRepo);
    ceoService = new CeoApplicationService(convoService, missionService);
  });

  it("should handle the E2E flow: exact response then contextual question", async () => {
    const conversation = await convoService.startConversation("E2E Test");

    // Step 1: User says exact phrase
    const decision1 = await ceoService.handleUserMessage(
      conversation.id,
      "Réponds exactement UI_CEO_OK",
    );
    expect(decision1.kind).toBe("ANSWER");
    if (decision1.kind === "ANSWER") expect(decision1.content).toBe("UI_CEO_OK");

    const messages1 = await convoService.getMessages(conversation.id);
    expect(messages1).toHaveLength(2);
    expect(messages1[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: "Réponds exactement UI_CEO_OK",
      }),
    );
    expect(messages1[1].role).toBe("assistant");
    expect(messages1[1].content).toBe("UI_CEO_OK");

    // Step 2: User asks what they just wrote
    const decision2 = await ceoService.handleUserMessage(
      conversation.id,
      "Quel mot viens-tu d'écrire ?",
    );
    expect(decision2.kind).toBe("ANSWER");
    if (decision2.kind === "ANSWER") expect(decision2.content).toBe("J'ai écrit : UI_CEO_OK");

    const messages2 = await convoService.getMessages(conversation.id);
    expect(messages2).toHaveLength(4);
    expect(messages2[2]).toEqual(
      expect.objectContaining({
        role: "user",
        content: "Quel mot viens-tu d'écrire ?",
      }),
    );
    expect(messages2[3].role).toBe("assistant");
    expect(messages2[3].content).toBe("J'ai écrit : UI_CEO_OK");
  });

  it("should still create a mission when requested", async () => {
    const conversation = await convoService.startConversation("Mission Test");

    const decision = await ceoService.handleUserMessage(
      conversation.id,
      "Crée une mission de test",
    );
    expect(decision.kind).toBe("CREATE_MISSION");
    if (decision.kind === "CREATE_MISSION") {
      expect(decision.title).toBe("Mission de Test");
      expect(decision.objective).toBe("Exécuter A, B, C");
    }

    const messages = await convoService.getMessages(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: "Crée une mission de test",
      }),
    );
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toContain("Mission créée avec succès");
  });

  it("should persist conversation data across service instances (simulating reload)", async () => {
    const conversation = await convoService.startConversation("Persistence Test");
    const userMsgContent = "Test persistence";
    await ceoService.handleUserMessage(conversation.id, userMsgContent);

    // Simulate reload by creating new service instances with the same repositories
    const convoService2 = new ConversationService(convoRepo, msgRepo);
    const missionService2 = new MissionService(missionRepo);
    const ceoService2 = new CeoApplicationService(convoService2, missionService2);

    const messages = await convoService2.getMessages(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe(userMsgContent);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Je réfléchis..."); // Default response for unknown message
  });
});

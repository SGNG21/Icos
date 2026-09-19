import { describe, expect, it, beforeEach, vi } from "vitest";
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
    ceoService = new CeoApplicationService(convoService, missionService, () => ({
      answer: async () => "Réponse du cerveau",
    }));
  });

  it("answers the exact phrase locally, then sends a contextual question to the AI brain with the full history", async () => {
    const answer = vi.fn(async () => "J'ai écrit : UI_CEO_OK");
    ceoService = new CeoApplicationService(convoService, missionService, () => ({ answer }));
    const conversation = await convoService.startConversation("E2E Test");

    // Step 1: exact phrase is handled deterministically, without the brain.
    const decision1 = await ceoService.handleUserMessage(
      conversation.id,
      "Réponds exactement UI_CEO_OK",
    );
    expect(decision1).toEqual({ kind: "ANSWER", content: "UI_CEO_OK" });
    expect(answer).not.toHaveBeenCalled();
    const messages1 = await convoService.getMessages(conversation.id);
    expect(messages1.map((m) => [m.role, m.content])).toEqual([
      ["user", "Réponds exactement UI_CEO_OK"],
      ["assistant", "UI_CEO_OK"],
    ]);

    // Step 2: a contextual question is answered by the brain, which sees the history.
    const decision2 = await ceoService.handleUserMessage(
      conversation.id,
      "Quel mot viens-tu d'écrire ?",
    );
    expect(decision2).toEqual({ kind: "ANSWER", content: "J'ai écrit : UI_CEO_OK" });
    expect(answer).toHaveBeenCalledTimes(1);
    const history = (answer.mock.calls[0] as unknown as [{ role: string; content: string }[]])[0];
    expect(history.map((m) => m.content)).toEqual([
      "Réponds exactement UI_CEO_OK",
      "UI_CEO_OK",
      "Quel mot viens-tu d'écrire ?",
    ]);
    const messages2 = await convoService.getMessages(conversation.id);
    expect(messages2).toHaveLength(4);
    expect(messages2[3]).toEqual(
      expect.objectContaining({ role: "assistant", content: "J'ai écrit : UI_CEO_OK" }),
    );
  });

  it("tells the user, and persists it, when the AI brain is not configured or unavailable", async () => {
    const conversation = await convoService.startConversation("Brain state");
    const notConfigured = new CeoApplicationService(convoService, missionService, () => ({
      answer: async () => {
        throw new Error("ICOS_AI_NOT_CONFIGURED");
      },
    }));
    const down = new CeoApplicationService(convoService, missionService, () => ({
      answer: async () => {
        throw new Error("timeout");
      },
    }));

    expect(await notConfigured.handleUserMessage(conversation.id, "Bonjour")).toEqual({
      kind: "ANSWER",
      content: "Le cerveau IA n’est pas encore configuré dans ICOS.",
    });
    expect(await down.handleUserMessage(conversation.id, "Bonjour ?")).toEqual({
      kind: "ANSWER",
      content: "Le cerveau ICOS est indisponible : timeout",
    });
    const messages = await convoService.getMessages(conversation.id);
    expect(messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual([
      "Le cerveau IA n’est pas encore configuré dans ICOS.",
      "Le cerveau ICOS est indisponible : timeout",
    ]);
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

    const messages = await convoService2.getMessages(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe(userMsgContent);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Réponse du cerveau");
  });
});

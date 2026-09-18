import type { ConversationRepository, MessageRepository } from "@/server/repositories/ceo-ports";
import type { Conversation, Message } from "@/core/ceo/contracts";

export class ConversationService {
  constructor(
    private readonly conversationRepository: ConversationRepository,
    private readonly messageRepository: MessageRepository,
  ) {}

  async listConversations(): Promise<Conversation[]> {
    return this.conversationRepository.list();
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversationRepository.findById(id);
  }

  async startConversation(title?: string): Promise<Conversation> {
    return this.conversationRepository.create(title);
  }

  async addMessage(
    conversationId: string,
    role: "user" | "assistant" | "system",
    content: string,
  ): Promise<Message> {
    const conversation = await this.conversationRepository.findById(conversationId);
    if (!conversation) throw new Error("Conversation not found");

    const message = await this.messageRepository.create({ conversationId, role, content });
    await this.conversationRepository.update(conversationId, { updatedAt: new Date() });

    return message;
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    return this.messageRepository.listByConversationId(conversationId);
  }
}

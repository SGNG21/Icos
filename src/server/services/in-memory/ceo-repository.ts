import type { ConversationRepository, MessageRepository } from "@/server/repositories/ceo-ports";
import type { Conversation, Message } from "@/core/ceo/contracts";

export class InMemoryConversationRepository implements ConversationRepository {
  private conversations: Map<string, Conversation> = new Map();

  async findById(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async list(): Promise<Conversation[]> {
    return Array.from(this.conversations.values());
  }

  async create(title?: string): Promise<Conversation> {
    const id = Math.random().toString(36).substring(2, 15); // simple id
    const now = new Date();
    const conversation: Conversation = { id, title, createdAt: now, updatedAt: now };
    this.conversations.set(id, conversation);
    return conversation;
  }

  async update(
    id: string,
    updates: Partial<Pick<Conversation, "title" | "updatedAt">>,
  ): Promise<Conversation> {
    const conv = this.conversations.get(id);
    if (!conv) throw new Error("Conversation not found");
    const updated = { ...conv, ...updates };
    this.conversations.set(id, updated);
    return updated;
  }
}

export class InMemoryMessageRepository implements MessageRepository {
  private messages: Map<string, Message> = new Map();
  private conversationIndex: Map<string, string[]> = new Map(); // conversationId -> messageIds

  async listByConversationId(conversationId: string): Promise<Message[]> {
    const ids = this.conversationIndex.get(conversationId) ?? [];
    return ids.map((id) => this.messages.get(id)!).filter((m): m is Message => m !== undefined);
  }

  async create(message: Omit<Message, "id" | "createdAt">): Promise<Message> {
    const id = Math.random().toString(36).substring(2, 15);
    const createdAt = new Date();
    const msg: Message = { id, ...message, createdAt };
    this.messages.set(id, msg);
    // Update conversation index
    const convoIds = this.conversationIndex.get(message.conversationId) ?? [];
    convoIds.push(id);
    this.conversationIndex.set(message.conversationId, convoIds);
    return msg;
  }
}

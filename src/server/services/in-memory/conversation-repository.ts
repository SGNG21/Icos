import { randomUUID } from "node:crypto";
import type { ConversationRepository } from "@/server/repositories/ceo-ports";
import type { Conversation } from "@/core/ceo/contracts";

/**
 * In-memory implementation of the ConversationRepository.
 * Used for testing and non-persistent environments.
 */
export class InMemoryConversationRepository implements ConversationRepository {
  private conversations: Map<string, Conversation> = new Map();

  async create(title?: string): Promise<Conversation> {
    const conversationId = randomUUID();
    const now = new Date();
    const conversation: Conversation = {
      id: conversationId,
      title: title ?? "",
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversationId, conversation);
    return conversation;
  }

  async findById(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async update(
    id: string,
    updates: Partial<Pick<Conversation, "title" | "updatedAt">>,
  ): Promise<Conversation> {
    const conversation = await this.findById(id);
    if (!conversation) {
      throw new Error(`Conversation not found: ${id}`);
    }
    const updated = { ...conversation, ...updates, updatedAt: new Date() };
    this.conversations.set(id, updated);
    return updated;
  }

  async list(): Promise<Conversation[]> {
    return Array.from(this.conversations.values());
  }
}

import { randomUUID } from "node:crypto";
import type { MessageRepository } from "@/server/repositories/ceo-ports";
import type { Message } from "@/core/ceo/contracts";

/**
 * In-memory implementation of the MessageRepository.
 * Used for testing and non-persistent environments.
 */
export class InMemoryMessageRepository implements MessageRepository {
  private messages: Map<string, Message> = new Map();

  async create(message: Omit<Message, "id" | "createdAt">): Promise<Message> {
    const messageId = randomUUID();
    const now = new Date();
    const msg: Message = {
      id: messageId,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      createdAt: now,
    };
    this.messages.set(messageId, msg);
    return msg;
  }

  async listByConversationId(conversationId: string): Promise<Message[]> {
    const result: Message[] = [];
    for (const [id, msg] of this.messages) {
      if (msg.conversationId === conversationId) {
        result.push(msg);
      }
    }
    return result;
  }
}

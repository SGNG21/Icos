import type { Conversation, Message } from "@/core/ceo/contracts";

export interface ConversationRepository {
  findById(id: string): Promise<Conversation | null>;
  list(): Promise<Conversation[]>;
  create(title?: string): Promise<Conversation>;
  update(
    id: string,
    updates: Partial<Pick<Conversation, "title" | "updatedAt">>,
  ): Promise<Conversation>;
}

export interface MessageRepository {
  listByConversationId(conversationId: string): Promise<Message[]>;
  create(message: Omit<Message, "id" | "createdAt">): Promise<Message>;
}

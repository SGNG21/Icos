import { eq, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "@/server/database/client";
import { conversations, messages } from "@/server/database/schema";
import type { ConversationRepository, MessageRepository } from "@/server/repositories/ceo-ports";
import type { Conversation, Message } from "@/core/ceo/contracts";

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<Conversation | null> {
    const rows = await this.db.select().from(conversations).where(eq(conversations.id, id));
    if (rows.length === 0) return null;
    const c = rows[0];
    return {
      id: c.id,
      title: c.title ?? undefined,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  async list(): Promise<Conversation[]> {
    const rows = await this.db.select().from(conversations).orderBy(desc(conversations.updatedAt));
    return rows.map((c) => ({
      id: c.id,
      title: c.title ?? undefined,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }

  async create(title?: string): Promise<Conversation> {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(conversations).values({ id, title, createdAt: now, updatedAt: now });
    return { id, title, createdAt: now, updatedAt: now };
  }

  async update(
    id: string,
    updates: Partial<Pick<Conversation, "title" | "updatedAt">>,
  ): Promise<Conversation> {
    await this.db.update(conversations).set(updates).where(eq(conversations.id, id));
    return (await this.findById(id))!;
  }
}

export class PostgresMessageRepository implements MessageRepository {
  constructor(private readonly db: Database) {}

  async listByConversationId(conversationId: string): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt);

    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      role: r.role as "user" | "assistant" | "system",
      content: r.content,
      createdAt: r.createdAt,
    }));
  }

  async create(message: Omit<Message, "id" | "createdAt">): Promise<Message> {
    const id = randomUUID();
    const createdAt = new Date();
    await this.db.insert(messages).values({ id, ...message, createdAt });
    return { id, ...message, createdAt };
  }
}

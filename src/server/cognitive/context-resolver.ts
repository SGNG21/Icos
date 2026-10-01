import type { Conversation, Sensitivity } from "@/core/cognitive/contracts";
import {
  resolveReference,
  type ContextResolution,
  type ResolvedScope,
} from "@/core/cognitive/client-resolution";

import type { ConversationOwner, PostgresConversationStore } from "./conversation-store";
import type { PostgresCognitiveMemoryStore } from "./memory-store";

/**
 * I/O around the pure resolver (decision 0062): load the durable directory and the durable
 * pointers, then let `resolveReference` decide. It owns no state of its own — the pointer
 * lives on the conversation row and the directory in `memory_entities` — so a restart loses
 * nothing and there is no second context authority.
 */
export class ContextResolver {
  constructor(
    private readonly memory: Pick<PostgresCognitiveMemoryStore, "clientDirectory">,
    private readonly conversations: Pick<PostgresConversationStore, "recentScope">,
  ) {}

  async resolve(input: {
    owner: ConversationOwner;
    conversation: Conversation;
    text: string;
    maxSensitivity: Sensitivity;
  }): Promise<ContextResolution> {
    const { conversation } = input;
    const directory = await this.memory.clientDirectory(
      conversation.tenantId,
      input.maxSensitivity,
    );
    const current: ResolvedScope = {
      clientId: conversation.clientId,
      projectId: conversation.projectId,
    };
    const previous: ResolvedScope = {
      clientId: conversation.previousClientId,
      projectId: conversation.previousProjectId,
    };
    // Tier 5 is only consulted when the conversation itself has no pointer; avoid the query
    // otherwise.
    const recent =
      current.clientId === null
        ? await this.conversations.recentScope(input.owner, conversation.id)
        : undefined;
    return resolveReference({
      text: input.text,
      directory,
      current,
      previous,
      recent,
      maxSensitivity: input.maxSensitivity,
    });
  }
}

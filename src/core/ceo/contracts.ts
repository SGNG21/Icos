import { z } from "zod";

export const ConversationRoleSchema = z.enum(["user", "assistant", "system"]);

export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: ConversationRoleSchema,
  content: z.string(),
  createdAt: z.date(),
});

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string().optional().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Message = z.infer<typeof MessageSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;

export const CeoDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ANSWER"), content: z.string() }),
  z.object({ kind: z.literal("ASK_CLARIFICATION"), question: z.string() }),
  z.object({
    kind: z.literal("CREATE_MISSION"),
    title: z.string(),
    objective: z.string(),
  }),
  z.object({ kind: z.literal("REPORT_STATUS"), summary: z.string() }),
  z.object({ kind: z.literal("REQUEST_APPROVAL"), actionDescription: z.string() }),
]);

export type CeoDecision = z.infer<typeof CeoDecisionSchema>;

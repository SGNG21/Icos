import { z } from "zod";

/**
 * Cognitive Runtime + Memory V1 (decision 0057). Pure contracts: no I/O.
 *
 * Models are replaceable compute; these shapes are the durable authority persisted in
 * PostgreSQL. Nothing here carries a model/session id as identity.
 */

const key = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/, "clé invalide (minuscules, chiffres, . _ : -)");
const text = (max: number) => z.string().trim().min(1).max(max);

// ── Scope ────────────────────────────────────────────────────────────────────
/** Who reads/writes, and within which client/project boundary. Tenant is mandatory. */
export interface CognitiveScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly clientId: string | null;
  readonly projectId: string | null;
}

// ── Conversation ─────────────────────────────────────────────────────────────
export const createConversationSchema = z
  .object({
    title: text(200).optional(),
    clientId: key.optional(),
    projectId: key.optional(),
  })
  .strict();
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const PARTICIPANT_KINDS = ["human", "icos", "agent"] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

export interface Participant {
  readonly kind: ParticipantKind;
  readonly subjectId: string;
  readonly role: "owner" | "assistant" | "observer";
  readonly joinedAt: string;
}

export interface Conversation {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly title: string | null;
  readonly clientId: string | null;
  readonly projectId: string | null;
  readonly status: "active" | "archived";
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Turn ─────────────────────────────────────────────────────────────────────
export const TURN_STATUSES = [
  "received",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];
export const TERMINAL_TURN_STATUSES: readonly TurnStatus[] = ["completed", "failed", "cancelled"];

export const TURN_OUTCOMES = [
  "ANSWER_ONLY",
  "ACTION_REQUEST",
  "MISSION_REQUEST",
  "APPROVAL_REQUEST",
  "CLARIFICATION",
  "NO_ACTION",
] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

/** Turn content is structured so voice/attachments can be added as new part kinds later. */
export const turnContentSchema = z
  .object({
    parts: z.array(z.object({ kind: z.literal("text"), text: text(20_000) }).strict()).min(1),
  })
  .strict();
export type TurnContent = z.infer<typeof turnContentSchema>;

export const submitTurnSchema = z
  .object({
    text: text(20_000),
    /** Client-generated; a replay with the same key returns the original turn. */
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();
export type SubmitTurnInput = z.infer<typeof submitTurnSchema>;

export interface Turn {
  readonly id: string;
  readonly conversationId: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly authorKind: ParticipantKind;
  readonly authorId: string;
  readonly content: TurnContent;
  readonly status: TurnStatus;
  readonly outcome: TurnOutcome | null;
  readonly replyToTurnId: string | null;
  readonly idempotencyKey: string | null;
  readonly contextSnapshotId: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

// ── Intent / cognition output (model-proposed, validated before use) ───────
export const goalProposalSchema = z
  .object({
    title: text(200),
    objective: text(4_000),
    successCriteria: z.array(text(500)).max(20).default([]),
    constraints: z.array(text(500)).max(20).default([]),
    riskLevel: z.enum(["read_only", "reversible", "sensitive"]).default("reversible"),
  })
  .strict();
export type GoalProposal = z.infer<typeof goalProposalSchema>;

export const actionProposalSchema = z
  .object({
    kind: key,
    description: text(2_000),
    riskLevel: z.enum(["read_only", "reversible", "sensitive"]).default("sensitive"),
  })
  .strict();
export type ActionProposal = z.infer<typeof actionProposalSchema>;

export const MEMORY_TYPES = [
  "working",
  "episodic",
  "semantic",
  "entity",
  "decision",
  "procedural",
  "project",
  "self",
] as const;
export type CognitiveMemoryType = (typeof MEMORY_TYPES)[number];
export const memoryTypeSchema = z.enum(MEMORY_TYPES);

/** A memory the model suggests. The runtime, not the model, assigns epistemic status. */
export const modelMemorySuggestionSchema = z
  .object({
    type: memoryTypeSchema,
    subjectKey: key,
    content: text(2_000),
    entityKey: key.optional(),
  })
  .strict();

export const cognitionResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ANSWER_ONLY"), text: text(20_000) }).strict(),
  z.object({ kind: z.literal("CLARIFICATION"), question: text(4_000) }).strict(),
  z.object({ kind: z.literal("NO_ACTION"), text: text(4_000).optional() }).strict(),
  z
    .object({ kind: z.literal("ACTION_REQUEST"), text: text(4_000), action: actionProposalSchema })
    .strict(),
  z
    .object({ kind: z.literal("MISSION_REQUEST"), text: text(4_000), goal: goalProposalSchema })
    .strict(),
]);
export const cognitionOutputSchema = z
  .object({
    result: cognitionResultSchema,
    memorySuggestions: z.array(modelMemorySuggestionSchema).max(10).default([]),
    intent: z.string().trim().max(200).optional(),
  })
  .strict();
export type CognitionResult = z.infer<typeof cognitionResultSchema>;
export type CognitionOutput = z.infer<typeof cognitionOutputSchema>;

// ── Turn references (actions / missions / approvals) ─────────────────────────
export const REF_KINDS = ["goal_proposal", "action_request"] as const;
export type RefKind = (typeof REF_KINDS)[number];
/**
 * Proposal lifecycle (decision 0057):
 *   PROPOSED → APPROVAL_REQUIRED → APPROVED → LAUNCHING → LAUNCHED | FAILED ; or REJECTED.
 * LAUNCHED = the mission is durably accepted by CORE3 under a fixed missionId. It says
 * nothing about whether the mission will succeed. Actions without a backend end in
 * NOT_CONNECTED after approval.
 */
export const REF_STATUSES = [
  "proposed",
  "approval_required",
  "approved",
  "launching",
  "launched",
  "rejected",
  "failed",
  "not_connected",
] as const;
export type RefStatus = (typeof REF_STATUSES)[number];

export interface TurnReference {
  readonly id: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly kind: RefKind;
  readonly status: RefStatus;
  readonly payload: GoalProposal | ActionProposal;
  /** Why the policy put the proposal in its initial state. */
  readonly policyReason: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  /** Canonical launch identity: goal intake id, CORE3 mission id, scheduler job id. */
  readonly goalId: string | null;
  readonly missionId: string | null;
  readonly launchJobId: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
}

export const proposalDecisionSchema = z
  .object({ decision: z.enum(["approve", "reject"]) })
  .strict();

// ── Memory ───────────────────────────────────────────────────────────────────
/** Who stands behind a memory. Ordered by authority (see EPISTEMIC_RANK). */
export const EPISTEMICS = [
  "USER_ASSERTED",
  "SYSTEM_OBSERVED",
  "TOOL_CONFIRMED",
  "MODEL_INFERRED",
  "DERIVED",
] as const;
export type Epistemic = (typeof EPISTEMICS)[number];

/** What a memory claims to be, independent of who asserted it. */
export const STATEMENT_KINDS = [
  "fact",
  "inference",
  "instruction",
  "suggestion",
  "observation",
] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

export const MEMORY_STATUSES = [
  "active",
  "candidate",
  "superseded",
  "rejected",
  "retracted",
  "deleted",
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const SENSITIVITIES = ["normal", "sensitive", "restricted"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const RETENTIONS = ["session", "standard", "long_term"] as const;
export type Retention = (typeof RETENTIONS)[number];

/** Where the content came from: `untrusted` = retrieved/tool/web text (prompt-injection surface). */
export type OriginTrust = "trusted" | "untrusted";

export interface MemoryProvenance {
  readonly sourceType: "turn" | "api" | "mission" | "tool" | "system";
  readonly sourceId: string;
  readonly conversationId: string | null;
  readonly turnId: string | null;
  /** Compute label only (never authority): which engine produced a MODEL_INFERRED candidate. */
  readonly engine: string | null;
}

export interface MemoryRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly type: CognitiveMemoryType;
  readonly subjectKey: string;
  readonly entityId: string | null;
  readonly content: string;
  readonly epistemic: Epistemic;
  readonly statementKind: StatementKind;
  readonly status: MemoryStatus;
  readonly confidence: number;
  readonly originTrust: OriginTrust;
  readonly provenance: MemoryProvenance;
  readonly clientId: string | null;
  readonly projectId: string | null;
  readonly ownerUserId: string | null;
  readonly conversationId: string | null;
  readonly missionId: string | null;
  readonly tags: readonly string[];
  readonly sensitivity: Sensitivity;
  readonly retention: Retention;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly expiresAt: string | null;
  readonly supersedesId: string | null;
  readonly contradictsId: string | null;
  readonly recordedBy: string;
  /** Human who reviewed a candidate (required before a MODEL_INFERRED/untrusted row is active). */
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const memoryReviewSchema = z.object({ decision: z.enum(["accept", "reject"]) }).strict();

/** Input to governed writeback. Scope/epistemic come from the calling channel, never the model. */
export interface MemoryCandidate {
  readonly type: CognitiveMemoryType;
  readonly subjectKey: string;
  readonly content: string;
  readonly epistemic: Epistemic;
  readonly statementKind: StatementKind;
  readonly confidence: number;
  readonly originTrust: OriginTrust;
  readonly provenance: MemoryProvenance;
  readonly entityKey?: string;
  readonly personal?: boolean;
  readonly missionId?: string | null;
  readonly tags?: readonly string[];
  readonly sensitivity?: Sensitivity;
  readonly retention?: Retention;
}

/** Body of POST /api/cognitive/memory: an explicit human "remember this". */
export const rememberSchema = z
  .object({
    type: memoryTypeSchema.exclude(["working", "episodic"]),
    subjectKey: key,
    content: text(2_000),
    statementKind: z.enum(["fact", "instruction"]).default("fact"),
    clientId: key.optional(),
    projectId: key.optional(),
    entityKey: key.optional(),
    personal: z.boolean().default(false),
    sensitivity: z.enum(SENSITIVITIES).default("normal"),
    tags: z.array(key).max(10).default([]),
  })
  .strict();

export type WritebackOutcome =
  | { readonly kind: "accepted"; readonly record: MemoryRecord }
  | { readonly kind: "candidate"; readonly record: MemoryRecord }
  | { readonly kind: "superseded"; readonly record: MemoryRecord; readonly previousId: string }
  | {
      readonly kind: "conflict_pending";
      readonly record: MemoryRecord;
      readonly conflictsWith: string;
    }
  | { readonly kind: "duplicate"; readonly existingId: string }
  | { readonly kind: "rejected"; readonly reason: string };

// ── Entity graph ─────────────────────────────────────────────────────────────
export const ENTITY_KINDS = [
  "person",
  "company",
  "client",
  "project",
  "asset",
  "service",
  "objective",
  "mission",
  "decision",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const RELATION_TYPES = [
  "OWNS",
  "WORKS_ON",
  "CLIENT_OF",
  "DEPENDS_ON",
  "HAS_GOAL",
  "HAS_BLOCKER",
  "RELATED_TO",
  "SUPERSEDES",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface Entity {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: EntityKind;
  readonly key: string;
  readonly name: string;
  /** Isolation boundary: an entity belonging to a client is only visible in that client's scope. */
  readonly clientId: string | null;
  readonly projectId: string | null;
  readonly aliases: readonly string[];
  readonly sensitivity: Sensitivity;
  readonly createdAt: string;
}

export interface Relation {
  readonly id: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly type: RelationType;
  readonly epistemic: Epistemic;
  readonly confidence: number;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

// ── Context snapshot ─────────────────────────────────────────────────────────
export const CONTEXT_ITEM_KINDS = [
  "goal",
  "entity",
  "turn",
  "memory",
  "procedure",
  "business_fact",
] as const;
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number];

export interface ContextItem {
  readonly ref: string;
  readonly kind: ContextItemKind;
  readonly stage: string;
  readonly text: string;
  readonly score: number;
  readonly tokens: number;
  readonly epistemic: Epistemic | null;
  readonly trust: OriginTrust;
  readonly reason: string;
}

export interface ContextExclusion {
  readonly ref: string;
  readonly reason:
    | "irrelevant"
    | "budget"
    | "sensitivity"
    | "tenant_scope"
    | "client_scope"
    | "project_scope"
    | "user_scope"
    | "inactive"
    | "expired";
}

export interface ContextSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly policyVersion: string;
  readonly scope: CognitiveScope;
  readonly items: readonly ContextItem[];
  readonly excluded: readonly ContextExclusion[];
  readonly tokenBudget: number;
  readonly tokensUsed: number;
  /** sha256 of the canonical (ref, score, text) list: equal inputs → equal hash. */
  readonly contentHash: string;
  readonly createdAt: string;
}

// ── Events ───────────────────────────────────────────────────────────────────
export const CONVERSATION_EVENT_TYPES = [
  "conversation.created",
  "turn.received",
  "turn.processing",
  "context.assembled",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "proposal.created",
  "proposal.decided",
  "proposal.launching",
  "proposal.launched",
  "proposal.failed",
  "memory.reviewed",
  "memory.written",
] as const;
export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];

export interface ConversationEvent {
  readonly conversationId: string;
  readonly seq: number;
  readonly type: ConversationEventType;
  readonly turnId: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

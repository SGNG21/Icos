import { z } from "zod";

import { riskLevelSchema } from "@/core/contracts/common";

/**
 * Proactive Supervisor (decision 0060) — the vocabulary of observation → event →
 * situation → proposal. Framework-free: no Next.js, Drizzle or PostgreSQL here.
 *
 * An event type is a generic, open string (`INVOICE_OVERDUE`, `SITE_HEALTH_FAILURE`…).
 * Business meaning lives in RELEVANCE RULES (data), never in the type itself, so a new
 * source never requires a new code path.
 */

const scopeText = z.string().trim().min(1).max(200);

export const SENSITIVITIES = ["public", "internal", "confidential", "restricted"] as const;
export const sensitivitySchema = z.enum(SENSITIVITIES);
export type Sensitivity = z.infer<typeof sensitivitySchema>;

export const EVENT_ORIGINS = ["push", "poll", "internal", "scheduled"] as const;

/**
 * One normalized observation. `.strict()` on purpose: an event can carry NO authority
 * field (no level, no approval, no "autonomous" flag). What a source puts in `summary`
 * is opaque data — the policy never reads it.
 */
export const supervisorEventInputSchema = z
  .object({
    tenantId: scopeText,
    source: scopeText, // EventSource, e.g. "billing", "uptime", "icos.dispatch"
    origin: z.enum(EVENT_ORIGINS),
    type: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "event type must be UPPER_SNAKE"),
    subject: scopeText, // what the event is about, e.g. "invoice:INV-7", "site:acme.fr/contact"
    occurredAt: z.coerce.date(),
    payloadRef: z.string().max(500).optional(), // pointer to the raw payload, never the payload
    summary: z
      .record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()]))
      .default({}),
    dedupKey: scopeText, // identical observation ⇒ identical key (per tenant + source)
    correlationId: z.string().max(200).optional(),
    projectScope: scopeText.optional(),
    clientScope: scopeText.optional(),
    sensitivity: sensitivitySchema.default("internal"),
    confidence: z.number().min(0).max(1).default(1),
  })
  .strict();

export type SupervisorEventInput = z.input<typeof supervisorEventInputSchema>;
export type SupervisorEvent = z.output<typeof supervisorEventInputSchema>;

/** Ordered: each level includes the authority of those before it. HUMAN_REQUIRED is apart. */
export const INITIATIVE_LEVELS = [
  "OBSERVE",
  "NOTIFY",
  "PROPOSE",
  "EXECUTE_LOW_RISK",
  "EXECUTE_BOUNDED",
  "HUMAN_REQUIRED",
] as const;
export type InitiativeLevel = (typeof INITIATIVE_LEVELS)[number];

export const DISPOSITIONS = [
  "IGNORE",
  "RECORD_ONLY",
  "NOTIFY",
  "PROPOSE_ACTION",
  "CREATE_BOUNDED_GOAL",
  "ESCALATE_HUMAN",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const ATTENTION_CLASSES = ["INFO", "ACTIONABLE", "URGENT", "CRITICAL"] as const;
export type AttentionClass = (typeof ATTENTION_CLASSES)[number];

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** `resolved` and `dismissed` are terminal: a terminal situation is NEVER reopened. */
export const SITUATION_STATES = ["open", "resolved", "dismissed"] as const;
export type SituationState = (typeof SITUATION_STATES)[number];
export const isTerminalSituation = (state: SituationState): boolean => state !== "open";

export type RiskLevel = z.infer<typeof riskLevelSchema>;

/** What a relevance rule proposes to do about a situation. */
export interface RuleAction {
  readonly name: string; // e.g. "payment_reminder", "restore_form_health"
  /** `goal`: multi-step work via CORE3; `tool_action`: one governed call via Tool Gateway. */
  readonly route: "goal" | "tool_action";
  readonly risk: RiskLevel;
  /** Capabilities requested from the Digital Workforce — never an agent or a model. */
  readonly capabilities: readonly string[];
  readonly desiredOutcome: string;
}

/** Durable, reviewable data: how an event type becomes (or does not become) a situation. */
export interface RelevanceRule {
  readonly eventType: string;
  readonly domain: string;
  readonly kind: "problem" | "opportunity" | "information";
  readonly severity: Severity;
  /** Another runtime owns remediation (e.g. compute routing): the supervisor never acts. */
  readonly owner?: string;
  readonly action?: RuleAction;
  /** Severity rises one step once the situation has aggregated this many events. */
  readonly escalateAfterEvents?: number;
  /** After a situation is terminal, same-fingerprint events are only recorded for this long. */
  readonly reopenCooldownMs?: number;
  /** An open situation quiet for this long is closed as stale; the next event opens a new one. */
  readonly staleAfterMs?: number;
}

export interface InitiativeRule {
  readonly domain: string;
  readonly action?: string;
  readonly clientScope?: string;
  readonly projectScope?: string;
  readonly level: InitiativeLevel;
  /** Bound for EXECUTE_* levels. Default {@link DEFAULT_MAX_EXECUTIONS_PER_HOUR}. */
  readonly maxExecutionsPerHour?: number;
}

export interface InitiativePolicy {
  readonly version: string;
  readonly rules: readonly InitiativeRule[];
  /** Domains where no rule can grant more than HUMAN_REQUIRED. */
  readonly humanRequiredDomains: readonly string[];
  /** Flood bound: new situations per (tenant, domain) per hour; beyond, events are recorded only. */
  readonly maxNewSituationsPerHour: number;
}

export const DEFAULT_MAX_EXECUTIONS_PER_HOUR = 3;

/**
 * The only thing the supervisor hands to CORE3. `.strict()`: a proposal requests
 * CAPABILITIES; it cannot name an agent, a worker or a model (Digital Workforce and
 * OmniRoute own those choices).
 */
export const goalProposalSchema = z
  .object({
    id: z.string().min(1),
    tenantId: scopeText,
    situationId: z.string().min(1),
    sourceEventId: z.string().min(1),
    reason: z.string().min(1).max(1000),
    desiredOutcome: z.string().min(1).max(1000),
    constraints: z.array(z.string().max(500)),
    urgency: z.enum(SEVERITIES),
    risk: riskLevelSchema,
    initiativeLevel: z.enum(INITIATIVE_LEVELS),
    disposition: z.enum(["PROPOSE_ACTION", "CREATE_BOUNDED_GOAL", "ESCALATE_HUMAN"]),
    route: z.enum(["goal", "tool_action"]),
    action: z.string().min(1),
    requestedCapabilities: z.array(z.string().min(1)),
    projectScope: scopeText.optional(),
    clientScope: scopeText.optional(),
    evidence: z.object({
      eventIds: z.array(z.string()),
      policyVersion: z.string(),
      reasons: z.array(z.string()),
    }),
  })
  .strict();
export type GoalProposal = z.infer<typeof goalProposalSchema>;

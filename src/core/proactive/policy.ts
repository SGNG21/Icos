import { createHash } from "node:crypto";

import {
  DEFAULT_MAX_EXECUTIONS_PER_HOUR,
  SEVERITIES,
  type AttentionClass,
  type Disposition,
  type InitiativeLevel,
  type InitiativePolicy,
  type RelevanceRule,
  type RiskLevel,
  type Severity,
  type SupervisorEvent,
} from "./contracts";

/**
 * Proactive Supervisor — the pure decision (decision 0060). No I/O: the service loads
 * the context, this decides, the store applies. A model may one day suggest a
 * classification; what EXECUTES is bounded here, by durable rules and policy only.
 */

const LEVEL_RANK: Record<Exclude<InitiativeLevel, "HUMAN_REQUIRED">, number> = {
  OBSERVE: 0,
  NOTIFY: 1,
  PROPOSE: 2,
  EXECUTE_LOW_RISK: 3,
  EXECUTE_BOUNDED: 4,
};
const RISK_RANK: Record<RiskLevel, number> = { read_only: 0, reversible: 1, sensitive: 2 };
/** Highest action risk each execution level may run without a human. */
const EXECUTION_RISK_CEILING = {
  EXECUTE_LOW_RISK: "read_only",
  EXECUTE_BOUNDED: "reversible",
} as const;

/** Confidence under which an observation may inform, never act. */
export const MIN_ACTIONABLE_CONFIDENCE = 0.5;
export const DEFAULT_REOPEN_COOLDOWN_MS = 60 * 60_000;
/** An open situation silent for a day is stale: a new occurrence is a new incident. */
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60_000;

/**
 * Resolves the initiative level for one (domain, action, client, project).
 *
 * Most specific rule wins; on a tie the MORE RESTRICTIVE level wins. Any matching
 * HUMAN_REQUIRED rule wins outright. No match is
 * `UNKNOWN`, which callers must treat as "no authority" (fail closed). A domain listed
 * in `humanRequiredDomains` is clamped to HUMAN_REQUIRED whatever a rule says, so no
 * rule — and no event — can self-authorize there.
 */
export function resolveInitiative(
  policy: InitiativePolicy,
  query: { domain: string; action?: string; clientScope?: string; projectScope?: string },
): { level: InitiativeLevel | "UNKNOWN"; maxExecutionsPerHour: number } {
  if (policy.humanRequiredDomains.includes(query.domain)) {
    return { level: "HUMAN_REQUIRED", maxExecutionsPerHour: 0 };
  }
  const matching = policy.rules.filter(
    (r) =>
      r.domain === query.domain &&
      (r.action === undefined || r.action === query.action) &&
      (r.clientScope === undefined || r.clientScope === query.clientScope) &&
      (r.projectScope === undefined || r.projectScope === query.projectScope),
  );
  if (matching.length === 0) return { level: "UNKNOWN", maxExecutionsPerHour: 0 };
  // A HUMAN_REQUIRED rule clamps everything under its scope: specificity cannot undo it.
  if (matching.some((r) => r.level === "HUMAN_REQUIRED")) {
    return { level: "HUMAN_REQUIRED", maxExecutionsPerHour: 0 };
  }

  const specificity = (r: (typeof matching)[number]) =>
    Number(r.action !== undefined) +
    Number(r.clientScope !== undefined) +
    Number(r.projectScope !== undefined);
  const top = Math.max(...matching.map(specificity));
  const restrictiveness = (level: InitiativeLevel) =>
    level === "HUMAN_REQUIRED" ? -1 : LEVEL_RANK[level];
  const winner = matching
    .filter((r) => specificity(r) === top)
    .sort((a, b) => restrictiveness(a.level) - restrictiveness(b.level))[0];
  return {
    level: winner.level,
    maxExecutionsPerHour: winner.maxExecutionsPerHour ?? DEFAULT_MAX_EXECUTIONS_PER_HOUR,
  };
}

/**
 * Same observation of the same thing ⇒ same fingerprint ⇒ one situation.
 *
 * Every scope that policy resolves on (client, project) is IN the fingerprint, so an
 * event can only aggregate into a situation whose authority is exactly its own. The
 * event type is always in it too, so one situation has one rule. A `correlationId`
 * only replaces the SUBJECT (grouping one incident seen on several subjects), and is
 * namespaced by source so one source cannot merge into another's incidents.
 * JSON encoding keeps fields unambiguous ("-" is not "no scope").
 */
export function situationFingerprint(event: SupervisorEvent, rule: RelevanceRule): string {
  const about = event.correlationId
    ? ["corr", event.source, event.correlationId]
    : ["subject", event.subject];
  return createHash("sha256")
    .update(
      JSON.stringify([
        event.clientScope ?? null,
        event.projectScope ?? null,
        rule.domain,
        event.type,
        ...about,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

/** Severity after aggregation: one step up once `escalateAfterEvents` is reached. */
export function aggregatedSeverity(rule: RelevanceRule, eventCount: number): Severity {
  const base = SEVERITIES.indexOf(rule.severity);
  const escalated =
    rule.escalateAfterEvents !== undefined && eventCount >= rule.escalateAfterEvents;
  return SEVERITIES[Math.min(base + (escalated ? 1 : 0), SEVERITIES.length - 1)];
}

const SEVERITY_ATTENTION: Record<Severity, AttentionClass> = {
  low: "INFO",
  medium: "ACTIONABLE",
  high: "URGENT",
  critical: "CRITICAL",
};
export const ATTENTION_RANK: Record<AttentionClass, number> = {
  INFO: 0,
  ACTIONABLE: 1,
  URGENT: 2,
  CRITICAL: 3,
};

/** Who is interrupted, and how. Nothing below the line is pushed; voice only for CRITICAL. */
export function attentionFor(disposition: Disposition, severity: Severity): AttentionClass | null {
  if (disposition === "IGNORE" || disposition === "RECORD_ONLY") return null;
  const bySeverity = SEVERITY_ATTENTION[severity];
  if (disposition === "PROPOSE_ACTION" || disposition === "ESCALATE_HUMAN") {
    // A human decision is pending: never quieter than ACTIONABLE.
    return ATTENTION_RANK[bySeverity] < ATTENTION_RANK.ACTIONABLE ? "ACTIONABLE" : bySeverity;
  }
  return bySeverity;
}

export function attentionChannels(
  attention: AttentionClass,
): Array<"cockpit" | "notification" | "voice"> {
  if (attention === "INFO") return ["cockpit"];
  if (attention === "CRITICAL") return ["cockpit", "notification", "voice"];
  return ["cockpit", "notification"];
}

export interface AssessInput {
  event: SupervisorEvent;
  rule: RelevanceRule | undefined;
  policy: InitiativePolicy;
  /** The subject (e.g. a mission) is already in a terminal state. */
  subjectTerminal: boolean;
  /** An OPEN situation with the same fingerprint, if any. */
  openSituation: { eventCount: number } | null;
  /** The latest TERMINAL situation with that fingerprint, if any. */
  lastTerminal: { closedAt: Date } | null;
  /** New situations opened in this rule's domain in the last hour. */
  newSituationsLastHour: number;
  executionsLastHour: number;
  now: Date;
}

export interface Assessment {
  disposition: Disposition;
  situation: "none" | "open" | "aggregate";
  level: InitiativeLevel | "UNKNOWN";
  severity: Severity;
  attention: AttentionClass | null;
  reasons: string[];
}

/**
 * event → relevance → novelty → actionability → policy → disposition.
 *
 * Returns the INTENDED disposition. Whether anything new actually happens (a first
 * proposal, a higher attention class) is decided by durable uniqueness in the store,
 * so 100 identical alerts converge on one situation, one proposal, one interruption.
 */
export function assess(input: AssessInput): Assessment {
  const { event, rule, policy } = input;
  const reasons: string[] = [];
  const done = (
    disposition: Disposition,
    situation: Assessment["situation"],
    level: Assessment["level"],
    severity: Severity,
  ): Assessment => ({
    disposition,
    situation,
    level,
    severity,
    attention: attentionFor(disposition, severity),
    reasons,
  });

  // Relevance: no rule ⇒ not our concern. No situation, no notification, no proposal.
  if (!rule) {
    reasons.push("NO_RELEVANCE_RULE");
    return done("IGNORE", "none", "UNKNOWN", "low");
  }
  if (input.subjectTerminal) {
    reasons.push("SUBJECT_TERMINAL");
    return done("RECORD_ONLY", "none", "UNKNOWN", rule.severity);
  }

  // Policy first: flood exemptions depend on it.
  const { level, maxExecutionsPerHour } = resolveInitiative(policy, {
    domain: rule.domain,
    action: rule.action?.name,
    clientScope: event.clientScope,
    projectScope: event.projectScope,
  });

  // Novelty.
  const eventCount = (input.openSituation?.eventCount ?? 0) + 1;
  const severity = aggregatedSeverity(rule, eventCount);
  const situation: Assessment["situation"] = input.openSituation ? "aggregate" : "open";
  if (!input.openSituation) {
    const cooldown = rule.reopenCooldownMs ?? DEFAULT_REOPEN_COOLDOWN_MS;
    if (
      input.lastTerminal &&
      input.now.getTime() - input.lastTerminal.closedAt.getTime() < cooldown
    ) {
      reasons.push("TERMINAL_COOLDOWN");
      return done("RECORD_ONLY", "none", "UNKNOWN", severity);
    }
    // Per-domain cap: routine noise in one domain cannot starve another. A
    // human-required domain or a critical severity is never flood-suppressed.
    const exempt = level === "HUMAN_REQUIRED" || severity === "critical";
    if (!exempt && input.newSituationsLastHour >= policy.maxNewSituationsPerHour) {
      reasons.push("FLOOD_LIMIT");
      return done("RECORD_ONLY", "none", "UNKNOWN", severity);
    }
  }

  if (level === "UNKNOWN") {
    reasons.push("POLICY_UNKNOWN");
    return done("RECORD_ONLY", situation, level, severity);
  }
  if (level === "HUMAN_REQUIRED") {
    reasons.push("HUMAN_REQUIRED_DOMAIN");
    const escalation = done("ESCALATE_HUMAN", situation, level, severity);
    if (event.confidence < MIN_ACTIONABLE_CONFIDENCE) {
      // Still escalated, but an uncertain signal does not page anyone.
      reasons.push("LOW_CONFIDENCE");
      escalation.attention = "ACTIONABLE";
    }
    return escalation;
  }

  // Actionability caps: another runtime owns it, or the observation is too uncertain.
  let effective = LEVEL_RANK[level];
  if (rule.owner) {
    reasons.push(`OWNED_BY:${rule.owner}`);
    effective = Math.min(effective, LEVEL_RANK.NOTIFY);
  }
  if (event.confidence < MIN_ACTIONABLE_CONFIDENCE) {
    reasons.push("LOW_CONFIDENCE");
    effective = Math.min(effective, LEVEL_RANK.NOTIFY);
  }
  if (!rule.action && effective > LEVEL_RANK.NOTIFY) {
    reasons.push("NO_ACTION_DEFINED");
    effective = LEVEL_RANK.NOTIFY;
  }

  if (effective === LEVEL_RANK.OBSERVE) return done("RECORD_ONLY", situation, level, severity);
  if (effective === LEVEL_RANK.NOTIFY) return done("NOTIFY", situation, level, severity);
  if (effective === LEVEL_RANK.PROPOSE) return done("PROPOSE_ACTION", situation, level, severity);

  // Execution levels: bounded by risk ceiling and an hourly budget.
  const action = rule.action!;
  if (action.risk === "sensitive") {
    reasons.push("SENSITIVE_ACTION");
    return done("ESCALATE_HUMAN", situation, level, severity);
  }
  const ceiling =
    level === "EXECUTE_LOW_RISK"
      ? EXECUTION_RISK_CEILING.EXECUTE_LOW_RISK
      : EXECUTION_RISK_CEILING.EXECUTE_BOUNDED;
  if (RISK_RANK[action.risk] > RISK_RANK[ceiling]) {
    reasons.push("RISK_EXCEEDS_LEVEL");
    return done("PROPOSE_ACTION", situation, level, severity);
  }
  if (input.executionsLastHour >= maxExecutionsPerHour) {
    reasons.push("EXECUTION_BUDGET_EXHAUSTED");
    return done("PROPOSE_ACTION", situation, level, severity);
  }
  return done("CREATE_BOUNDED_GOAL", situation, level, severity);
}

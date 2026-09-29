import type { InitiativePolicy, RelevanceRule } from "./contracts";

/**
 * Default relevance rules and initiative policy (decision 0055). DATA, not code paths:
 * a deployment reviews and replaces these; the engine never special-cases a type.
 *
 * Defaults are deliberately conservative. Nothing here executes on its own: the
 * highest default level is PROPOSE, security is HUMAN_REQUIRED, and runtime owners
 * (compute routing, runtime recovery, tool gateway) keep remediation of their domain.
 */
export const DEFAULT_RELEVANCE_RULES: readonly RelevanceRule[] = Object.freeze([
  {
    eventType: "INVOICE_OVERDUE",
    domain: "finance",
    kind: "problem",
    severity: "medium",
    action: {
      name: "payment_reminder",
      route: "tool_action",
      risk: "reversible",
      capabilities: ["finance.collections"],
      desiredOutcome: "Overdue invoice is paid or a payment date is agreed",
    },
  },
  {
    eventType: "SITE_HEALTH_FAILURE",
    domain: "web.operations",
    kind: "problem",
    severity: "high",
    escalateAfterEvents: 5,
    action: {
      name: "restore_site_health",
      route: "goal",
      risk: "reversible",
      capabilities: ["web.development", "web.testing"],
      desiredOutcome: "The failing site check passes again, with a regression test",
    },
  },
  // Transient by nature: INFO for the cockpit, a real interruption only if it persists.
  {
    eventType: "PROVIDER_RATE_LIMIT",
    domain: "compute",
    kind: "problem",
    severity: "low",
    owner: "compute-routing",
    escalateAfterEvents: 20,
  },
  {
    eventType: "WORKER_CRASH",
    domain: "compute",
    kind: "problem",
    severity: "medium",
    owner: "compute-routing",
    escalateAfterEvents: 5,
  },
  {
    eventType: "MISSION_BLOCKED",
    domain: "runtime",
    kind: "problem",
    severity: "high",
    owner: "runtime-recovery",
  },
  {
    eventType: "TOOL_FAILURE",
    domain: "tools",
    kind: "problem",
    severity: "medium",
    owner: "tool-gateway",
    escalateAfterEvents: 10,
  },
  {
    eventType: "NEW_LEAD",
    domain: "sales",
    kind: "opportunity",
    severity: "medium",
    action: {
      name: "qualify_lead",
      route: "goal",
      risk: "reversible",
      capabilities: ["sales.qualification"],
      desiredOutcome: "The lead is qualified and a next step is scheduled",
    },
  },
  {
    eventType: "CRM_REPLY",
    domain: "sales",
    kind: "opportunity",
    severity: "medium",
    action: {
      name: "follow_up_reply",
      route: "goal",
      risk: "reversible",
      capabilities: ["sales.follow_up"],
      desiredOutcome: "The reply is answered and the opportunity advanced",
    },
  },
  { eventType: "DEADLINE_APPROACHING", domain: "projects", kind: "problem", severity: "medium" },
  {
    eventType: "SEO_CHANGE",
    domain: "marketing.seo",
    kind: "information",
    severity: "low",
    action: {
      name: "analyse_seo_change",
      route: "goal",
      risk: "read_only",
      capabilities: ["seo.analysis"],
      desiredOutcome: "The ranking change is explained with a recommendation",
    },
  },
  { eventType: "EMAIL_RECEIVED", domain: "communications", kind: "information", severity: "low" },
  {
    eventType: "SECURITY_ALERT",
    domain: "security",
    kind: "problem",
    severity: "critical",
    action: {
      name: "investigate_security_alert",
      route: "goal",
      risk: "sensitive",
      capabilities: ["security.investigation"],
      desiredOutcome: "The alert is triaged and contained by an accountable human",
    },
  },
] satisfies RelevanceRule[]);

export const DEFAULT_INITIATIVE_POLICY: InitiativePolicy = Object.freeze({
  version: "initiative-policy/2026-09-29.1",
  rules: Object.freeze([
    { domain: "finance", level: "PROPOSE" },
    { domain: "web.operations", level: "PROPOSE" },
    { domain: "compute", level: "NOTIFY" },
    { domain: "runtime", level: "NOTIFY" },
    { domain: "tools", level: "NOTIFY" },
    { domain: "sales", level: "PROPOSE" },
    { domain: "projects", level: "NOTIFY" },
    { domain: "marketing.seo", level: "PROPOSE" },
    { domain: "communications", level: "OBSERVE" },
  ]),
  humanRequiredDomains: Object.freeze(["security"]),
  maxNewSituationsPerHour: 50,
}) as InitiativePolicy;

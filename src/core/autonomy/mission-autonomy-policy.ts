/**
 * May a goal start without a human saying go? (ADR 0067, priority 3)
 *
 * `mission.launch` was unconditionally APPROVAL_REQUIRED, with the honest evidence "risk
 * asserted by the model, therefore unverified". That was the right refusal for the wrong
 * reason: the problem was never that autonomy is unsafe, it was that the only available
 * risk signal came from the thing asking for permission.
 *
 * So this classifies from what the goal may TOUCH, never from what it says about itself.
 *
 * THE MODEL CANNOT WIDEN THIS. A capability is auto-allowed only by appearing in a fixed
 * allowlist below. A goal that names a capability nobody declared, or names none at all,
 * is not auto-allowed — absence is not evidence of harmlessness. `riskLevel` is read ONLY
 * to escalate, never to relax: a goal may volunteer that it is dangerous, and may not
 * volunteer that it is safe.
 */

/** What the runtime may do with a goal before a human has answered. */
export const MISSION_POLICY_CLASSES = [
  /** Verifiably read-only or confined to an isolated workspace: start it. */
  "AUTO_ALLOWED",
  /** Real effects outside ICOS, bounded by deployment policy rather than by this table. */
  "POLICY_GATED",
  /** Destructive, irreversible or unclassifiable: a human decides. */
  "APPROVAL_REQUIRED",
] as const;
export type MissionPolicyClass = (typeof MISSION_POLICY_CLASSES)[number];

/**
 * Capabilities whose worst outcome is a wasted run: reading, thinking, and writing inside
 * a worktree that is thrown away. Everything here is checked against the CAPABILITY the
 * goal declares, which the intake normalises — not against prose.
 */
export const AUTO_ALLOWED_CAPABILITIES: ReadonlySet<string> = new Set([
  "research",
  "planning",
  "architecture_design",
  "synthesis",
  "independent_review",
  "seo_audit",
  "sales_strategy",
  /*
   * Writing code is auto-allowed ONLY because a writer is confined to its own worktree and
   * its branch reaches the repository through review and the integration gate. The
   * confinement is what makes it safe; if that ever stops being true this belongs below.
   */
  "code_write",
]);

/** Capabilities that always reach a human, whatever else the goal says. */
export const APPROVAL_REQUIRED_CAPABILITIES: ReadonlySet<string> = new Set([
  "deploy",
  "merge",
  "payment",
  "purchase",
  "customer_communication",
  "account_change",
  "data_delete",
  "production_change",
]);

export type MissionAutonomyInput = {
  /** Capabilities the goal declares it needs. Normalised by intake, not free prose. */
  readonly capabilities: readonly string[];
  /**
   * The goal's own risk claim. ASSERTED, therefore used only to escalate. Trusting it
   * downward would let the asker grant itself permission.
   */
  readonly assertedRisk?: "read_only" | "reversible" | "sensitive";
  /** The owner's standing instruction for this goal, which may only tighten. */
  readonly humanApprovalPolicy?: "never" | "if_risky" | "always";
};

export type MissionAutonomyVerdict = {
  readonly policyClass: MissionPolicyClass;
  /** Why, in a few words. Never a secret. */
  readonly reason: string;
};

/**
 * Deterministic: same input, same verdict, no model in the loop.
 */
export function classifyMissionAutonomy(input: MissionAutonomyInput): MissionAutonomyVerdict {
  const capabilities = input.capabilities.map((c) => c.trim()).filter((c) => c.length > 0);

  /* The owner may always demand to be asked. This is the one input that is not a guess. */
  if (input.humanApprovalPolicy === "always") {
    return { policyClass: "APPROVAL_REQUIRED", reason: "le propriétaire exige une approbation" };
  }

  const gated = capabilities.filter((c) => APPROVAL_REQUIRED_CAPABILITIES.has(c));
  if (gated.length > 0) {
    return {
      policyClass: "APPROVAL_REQUIRED",
      reason: `capacité à effet externe ou irréversible : ${gated.join(", ")}`,
    };
  }

  /*
   * A goal that declares nothing is not a harmless goal — it is an unclassified one, and
   * the whole point of this function is that it never guesses in the permissive direction.
   */
  if (capabilities.length === 0) {
    return {
      policyClass: "APPROVAL_REQUIRED",
      reason: "aucune capacité déclarée : portée non vérifiable",
    };
  }

  const unknown = capabilities.filter((c) => !AUTO_ALLOWED_CAPABILITIES.has(c));
  if (unknown.length > 0) {
    return {
      policyClass: "POLICY_GATED",
      reason: `capacité non classée, soumise à la politique de déploiement : ${unknown.join(", ")}`,
    };
  }

  /* Escalation only. `read_only` and `reversible` cannot buy anything the allowlist refused. */
  if (input.assertedRisk === "sensitive") {
    return {
      policyClass: "APPROVAL_REQUIRED",
      reason: "le goal se déclare sensible (une affirmation ne peut qu'augmenter l'exigence)",
    };
  }

  return {
    policyClass: "AUTO_ALLOWED",
    reason: `lecture seule ou confiné à un worktree isolé : ${capabilities.join(", ")}`,
  };
}

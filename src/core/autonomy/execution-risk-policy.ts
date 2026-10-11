/**
 * What may a piece of work do without a human, judged from what it may TOUCH?
 *
 * This is the one table behind both questions ICOS asks about autonomy:
 *
 *   - at LAUNCH, `classifyMissionAutonomy` asks it whether a goal may start unattended;
 *   - before DISPATCH, the supervisor's risk gate asks it whether a planned task may reach a
 *     worker, because a goal that launched on policy may still be planned into a task that
 *     deploys, deletes or pays.
 *
 * Pure and deterministic: no I/O, no clock, no model in the loop. Everything here reads
 * DECLARED capabilities and STRUCTURAL facts (does the task write to a repository? is its
 * workspace isolated?). Anything the asker asserts about its own risk — the goal's
 * `riskLevel`, the planner's `riskClass` — is read only to ESCALATE: a request may volunteer
 * that it is dangerous, never that it is safe.
 *
 * FAIL CLOSED. A capability absent from the table is unclassified, and unclassified work
 * always reaches a human. Adding a capability is a deliberate edit to this file.
 */
import { PROTECTED_DOMAINS } from "./self-modification-policy";

/** Bumped whenever the table or a decision rule changes; approvals are bound to it. */
export const POLICY_VERSION = "execution-risk-policy/v1";

/**
 * The effect classes, ordered from least to most severe. The order is what "the most severe
 * class" means; the DECISION is always taken over every class a task touches, never only over
 * the most severe one (a permitted external effect is AUTONOMOUS while a privileged one is
 * GOVERNED, so the most severe class alone could hide an approval requirement).
 */
export const ACTION_RISK_CLASSES = [
  /** Reads, thinks, writes nothing anywhere that outlives the run. */
  "READ_ONLY",
  /** Writes, but only inside an isolated, disposable workspace reviewed before integration. */
  "REVERSIBLE_ISOLATED",
  /** Changes something outside ICOS that a real, available rollback can undo. */
  "REVERSIBLE_EXTERNAL",
  /** Changes who may do what: accounts, permissions, governance surfaces. */
  "PRIVILEGED",
  /** Reaches credentials or secret material. */
  "SECRET_SENSITIVE",
  /** Destroys data. */
  "DESTRUCTIVE",
  /** Moves money or commits to spending it. */
  "FINANCIAL",
  /** Cannot be undone once done: production change, deploy, merge, a message delivered. */
  "IRREVERSIBLE",
] as const;
export type ActionRiskClass = (typeof ACTION_RISK_CLASSES)[number];

/** What the runtime may do with the work before a human has answered. */
export const ACTION_AUTONOMY_DECISIONS = [
  /** Proceed now, no human. */
  "AUTONOMOUS",
  /** Proceed, but only through the governed execution layers (workspace, gateway, review). */
  "GOVERNED",
  /** A human decides first. */
  "APPROVAL_REQUIRED",
] as const;
export type ActionAutonomyDecision = (typeof ACTION_AUTONOMY_DECISIONS)[number];

const SEVERITY: Readonly<Record<ActionRiskClass, number>> = Object.fromEntries(
  ACTION_RISK_CLASSES.map((c, i) => [c, i]),
) as Record<ActionRiskClass, number>;

const DECISION_STRICTNESS: Readonly<Record<ActionAutonomyDecision, number>> = {
  AUTONOMOUS: 0,
  GOVERNED: 1,
  APPROVAL_REQUIRED: 2,
};

export function mostSevereClass(classes: readonly ActionRiskClass[]): ActionRiskClass | undefined {
  return classes.reduce<ActionRiskClass | undefined>(
    (worst, c) => (worst === undefined || SEVERITY[c] > SEVERITY[worst] ? c : worst),
    undefined,
  );
}

export function strictestDecision(
  decisions: readonly ActionAutonomyDecision[],
): ActionAutonomyDecision {
  return decisions.reduce<ActionAutonomyDecision>(
    (worst, d) => (DECISION_STRICTNESS[d] > DECISION_STRICTNESS[worst] ? d : worst),
    "AUTONOMOUS",
  );
}

export type CapabilityRiskEntry = {
  readonly riskClass: ActionRiskClass;
  /**
   * Part of the closed vocabulary a GOAL may declare (the cognition prompt lists exactly these).
   * Non-declarable entries are still classified wherever they appear — on a task, a skill — so
   * that naming them can never fall through to "unclassified, therefore policy-gated".
   */
  readonly declarable: boolean;
  /** Why this class, in one line. */
  readonly rationale: string;
};

/**
 * THE capability → class table. Explicit and total over every capability ICOS knows; anything
 * else is unclassified and fails closed.
 *
 * `customer_communication` is IRREVERSIBLE, not REVERSIBLE_EXTERNAL: a message that has been
 * delivered cannot be recalled, and a correction is a second message, not a rollback. The
 * REVERSIBLE_EXTERNAL class is reserved for external changes with a REAL, available undo,
 * and no capability in today's vocabulary has one — so that class has no member yet, and its
 * decision rule (permitted by policy AND rollback available) is exercised on the class itself.
 */
export const CAPABILITY_RISK_TABLE: Readonly<Record<string, CapabilityRiskEntry>> = {
  research: { riskClass: "READ_ONLY", declarable: true, rationale: "lecture et analyse" },
  planning: { riskClass: "READ_ONLY", declarable: true, rationale: "plan, aucun effet" },
  architecture_design: {
    riskClass: "READ_ONLY",
    declarable: true,
    rationale: "conception, aucun effet",
  },
  synthesis: { riskClass: "READ_ONLY", declarable: true, rationale: "synthèse, aucun effet" },
  independent_review: {
    riskClass: "READ_ONLY",
    declarable: true,
    rationale: "revue, aucun effet",
  },
  seo_audit: { riskClass: "READ_ONLY", declarable: true, rationale: "audit en lecture" },
  sales_strategy: { riskClass: "READ_ONLY", declarable: true, rationale: "stratégie, aucun effet" },
  /*
   * Safe ONLY because a writer is confined to its own worktree and its branch reaches the
   * repository through review and the integration gate. The decision rule enforces that: an
   * un-isolated REVERSIBLE_ISOLATED task is escalated.
   */
  code_write: {
    riskClass: "REVERSIBLE_ISOLATED",
    declarable: true,
    rationale: "écriture confinée à un worktree isolé, revue avant intégration",
  },
  /* Order below is the order the cognition prompt lists the vocabulary in; keep it stable. */
  deploy: { riskClass: "IRREVERSIBLE", declarable: true, rationale: "mise en production" },
  merge: { riskClass: "IRREVERSIBLE", declarable: true, rationale: "intégration au dépôt" },
  payment: { riskClass: "FINANCIAL", declarable: true, rationale: "paiement" },
  purchase: { riskClass: "FINANCIAL", declarable: true, rationale: "achat" },
  customer_communication: {
    riskClass: "IRREVERSIBLE",
    declarable: true,
    rationale: "un message délivré ne se rappelle pas",
  },
  account_change: {
    riskClass: "PRIVILEGED",
    declarable: true,
    rationale: "modification de compte ou de droits",
  },
  data_delete: { riskClass: "DESTRUCTIVE", declarable: true, rationale: "suppression de données" },
  production_change: {
    riskClass: "IRREVERSIBLE",
    declarable: true,
    rationale: "modification de la production",
  },
  /*
   * The FLEET's routing vocabulary (worker registry capabilities). A canonical Task may carry
   * these as `requiredCapabilities`; they describe compute, so they are classified by the
   * effect that compute has. Not declarable by a goal: at launch they stay POLICY_GATED.
   */
  review: { riskClass: "READ_ONLY", declarable: false, rationale: "revue, aucun effet" },
  audit: { riskClass: "READ_ONLY", declarable: false, rationale: "audit en lecture" },
  analysis: { riskClass: "READ_ONLY", declarable: false, rationale: "analyse, aucun effet" },
  "deep-research": { riskClass: "READ_ONLY", declarable: false, rationale: "recherche" },
  "code-generation": {
    riskClass: "REVERSIBLE_ISOLATED",
    declarable: false,
    rationale: "écriture de code, confinée comme code_write",
  },
  code_editing: {
    riskClass: "REVERSIBLE_ISOLATED",
    declarable: false,
    rationale: "édition de code, confinée comme code_write",
  },
  credential_access: {
    riskClass: "SECRET_SENSITIVE",
    declarable: false,
    rationale: "accès à des identifiants",
  },
  secret_access: {
    riskClass: "SECRET_SENSITIVE",
    declarable: false,
    rationale: "accès à du matériel secret",
  },
  /* The protected self-modification domains (self-modification-policy.ts). */
  ...Object.fromEntries(
    PROTECTED_DOMAINS.map((domain) => [
      domain,
      {
        riskClass:
          domain === "credential-secrets-authority"
            ? ("SECRET_SENSITIVE" as const)
            : ("PRIVILEGED" as const),
        declarable: false,
        rationale: "domaine d'auto-modification protégé",
      },
    ]),
  ),
};

/** The class of a capability, or `undefined` when unclassified (which fails closed). */
export function capabilityRiskClass(capability: string): ActionRiskClass | undefined {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_RISK_TABLE, capability)
    ? CAPABILITY_RISK_TABLE[capability].riskClass
    : undefined;
}

export type KernelRiskLevel = "read_only" | "reversible" | "sensitive";
export type OwnerApprovalPolicy = "never" | "if_risky" | "always";

export type TaskRiskInput = {
  /** Capabilities the work declares (task required capabilities, its routing capability). */
  readonly capabilities: readonly string[];
  /**
   * Structural fact: the work writes into a repository (it carries a file scope). Writing is
   * an effect whether or not a capability names it, so it always contributes
   * REVERSIBLE_ISOLATED.
   */
  readonly repositoryWrite?: boolean;
  /** Kernel risk of the canonical Task. Planner-chosen, therefore escalation only. */
  readonly riskLevel?: KernelRiskLevel;
  /** Risk the goal asserts about itself. Escalation only. */
  readonly assertedRisk?: KernelRiskLevel;
  /**
   * The owner's capability allowlist for the goal. Empty or absent means no allowlist was
   * declared. When present, any capability outside it — including the implicit `code_write`
   * of a repository writer — requires a human.
   */
  readonly allowedCapabilities?: readonly string[];
};

export type TaskRiskClassification = {
  /** The most severe class touched; `READ_ONLY` when nothing but reading is involved. */
  readonly riskClass: ActionRiskClass;
  /** Every class touched, deduplicated, in severity order. */
  readonly classes: readonly ActionRiskClass[];
  /** Capabilities nobody classified. Non-empty fails closed. */
  readonly unclassified: readonly string[];
  /** Capabilities outside the goal's allowlist. Non-empty fails closed. */
  readonly outsideAllowlist: readonly string[];
  /** An escalation-only signal demanded a human (`sensitive` asserted or planned). */
  readonly escalatedBy: readonly ("riskLevel" | "assertedRisk")[];
};

/**
 * The classes a task touches. Deterministic; ignores every relaxing claim.
 *
 * A task that declares no capability and writes nothing is READ_ONLY: at this level absence is
 * structural evidence (no file scope, no repository effect), and the planner is told NOT to
 * declare capabilities. Any external effect it might attempt at run time goes through the
 * Tool Gateway, whose grants and HIGH/CRITICAL approvals apply independently of this gate.
 */
export function classifyTaskRisk(input: TaskRiskInput): TaskRiskClassification {
  const declared = [
    ...new Set(input.capabilities.map((c) => c.trim()).filter((c) => c.length > 0)),
  ];
  const classes = new Set<ActionRiskClass>();
  const unclassified: string[] = [];
  for (const capability of declared) {
    const riskClass = capabilityRiskClass(capability);
    if (riskClass) classes.add(riskClass);
    else unclassified.push(capability);
  }
  if (input.repositoryWrite) classes.add("REVERSIBLE_ISOLATED");
  if (classes.size === 0) classes.add("READ_ONLY");

  const allowlist = (input.allowedCapabilities ?? []).map((c) => c.trim()).filter(Boolean);
  const outsideAllowlist =
    allowlist.length === 0
      ? []
      : [
          ...declared.filter((c) => !allowlist.includes(c)),
          ...(input.repositoryWrite &&
          !declared.includes("code_write") &&
          !allowlist.includes("code_write")
            ? ["code_write"]
            : []),
        ];

  const escalatedBy: ("riskLevel" | "assertedRisk")[] = [];
  if (input.riskLevel === "sensitive") escalatedBy.push("riskLevel");
  if (input.assertedRisk === "sensitive") escalatedBy.push("assertedRisk");

  const ordered = ACTION_RISK_CLASSES.filter((c) => classes.has(c));
  return {
    riskClass: mostSevereClass(ordered) ?? "READ_ONLY",
    classes: ordered,
    unclassified,
    outsideAllowlist,
    escalatedBy,
  };
}

export type ActionAutonomyContext = {
  /** The work runs in a truly isolated, governed workspace. */
  readonly isolatedWorkspace?: boolean;
  /** Deployment policy explicitly permits unattended external changes. */
  readonly externalPermitted?: boolean;
  /** A real rollback exists for the external change. */
  readonly rollbackAvailable?: boolean;
  /** Secret scopes the work needs. */
  readonly requestedSecretScopes?: readonly string[];
  /** Secret scopes the owner has pre-authorized, narrowly (no wildcard). */
  readonly preAuthorizedSecretScopes?: readonly string[];
  /** The owner's standing instruction; may only tighten. */
  readonly ownerPolicy?: OwnerApprovalPolicy;
  /**
   * Under `always`: a human's approval of THIS goal is durably recorded (the conversational
   * launch writes `approvedBy`). It covers the goal's read-only and isolated reversible work —
   * what the human approved launching — and nothing more: privileged, secret, destructive,
   * financial and irreversible tasks still each need their own approval. Without it, `always`
   * parks every task. Never relaxes any other owner policy.
   */
  readonly ownerApprovedGoal?: boolean;
};

/** Classes a recorded human approval of the goal covers under `always`. */
const COVERED_BY_GOAL_APPROVAL: ReadonlySet<ActionRiskClass> = new Set([
  "READ_ONLY",
  "REVERSIBLE_ISOLATED",
]);

export type ActionAutonomyVerdict = {
  readonly decision: ActionAutonomyDecision;
  readonly reason: string;
};

function secretsNarrowlyPreAuthorized(ctx: ActionAutonomyContext): boolean {
  const requested = ctx.requestedSecretScopes ?? [];
  const granted = ctx.preAuthorizedSecretScopes ?? [];
  if (requested.length === 0) return false;
  if (granted.some((s) => s.includes("*"))) return false;
  return requested.every((s) => s.trim().length > 0 && granted.includes(s));
}

/**
 * The decision for ONE class. The rules, exactly:
 *   READ_ONLY            → AUTONOMOUS
 *   REVERSIBLE_ISOLATED  → AUTONOMOUS only in a truly isolated workspace, else APPROVAL_REQUIRED
 *   REVERSIBLE_EXTERNAL  → AUTONOMOUS only if policy explicitly permits AND a rollback exists,
 *                          else APPROVAL_REQUIRED
 *   PRIVILEGED           → GOVERNED
 *   SECRET_SENSITIVE     → APPROVAL_REQUIRED unless narrowly pre-authorized (then GOVERNED)
 *   DESTRUCTIVE / FINANCIAL / IRREVERSIBLE → APPROVAL_REQUIRED
 * and an owner policy of `always` makes every class APPROVAL_REQUIRED — except READ_ONLY and
 * isolated REVERSIBLE work when a human's approval of the goal is recorded (`ownerApprovedGoal`).
 */
export function decideActionAutonomy(
  riskClass: ActionRiskClass,
  ctx: ActionAutonomyContext = {},
): ActionAutonomyVerdict {
  if (
    ctx.ownerPolicy === "always" &&
    !(ctx.ownerApprovedGoal === true && COVERED_BY_GOAL_APPROVAL.has(riskClass))
  ) {
    return { decision: "APPROVAL_REQUIRED", reason: "le propriétaire exige une approbation" };
  }
  switch (riskClass) {
    case "READ_ONLY":
      return { decision: "AUTONOMOUS", reason: "lecture seule" };
    case "REVERSIBLE_ISOLATED":
      return ctx.isolatedWorkspace === true
        ? { decision: "AUTONOMOUS", reason: "écriture confinée à un espace isolé" }
        : {
            decision: "APPROVAL_REQUIRED",
            reason: "écriture sans espace isolé gouverné",
          };
    case "REVERSIBLE_EXTERNAL":
      return ctx.externalPermitted === true && ctx.rollbackAvailable === true
        ? { decision: "AUTONOMOUS", reason: "effet externe permis par la politique, réversible" }
        : {
            decision: "APPROVAL_REQUIRED",
            reason: "effet externe sans permission explicite ou sans retour arrière",
          };
    case "PRIVILEGED":
      return { decision: "GOVERNED", reason: "action privilégiée : chemin gouverné uniquement" };
    case "SECRET_SENSITIVE":
      return secretsNarrowlyPreAuthorized(ctx)
        ? { decision: "GOVERNED", reason: "secrets pré-autorisés de façon étroite" }
        : { decision: "APPROVAL_REQUIRED", reason: "accès à des secrets non pré-autorisé" };
    case "DESTRUCTIVE":
      return { decision: "APPROVAL_REQUIRED", reason: "action destructive" };
    case "FINANCIAL":
      return { decision: "APPROVAL_REQUIRED", reason: "engagement financier" };
    case "IRREVERSIBLE":
      return { decision: "APPROVAL_REQUIRED", reason: "action irréversible" };
    default: {
      /* Exhaustive over the union; a value outside it (e.g. from storage) fails closed. */
      const unknown: never = riskClass;
      return { decision: "APPROVAL_REQUIRED", reason: `classe inconnue : ${String(unknown)}` };
    }
  }
}

export type TaskAutonomyVerdict = {
  readonly decision: ActionAutonomyDecision;
  readonly riskClass: ActionRiskClass;
  readonly classes: readonly ActionRiskClass[];
  readonly reasons: readonly string[];
  readonly policyVersion: string;
  /**
   * Stable identity of WHAT was classified. A human approval is bound to it, so an approval
   * given for one classification cannot be replayed for a different one.
   */
  readonly fingerprint: string;
};

/** The decision for a whole task: the strictest decision over every class and signal. */
export function decideTaskAutonomy(
  classification: TaskRiskClassification,
  ctx: ActionAutonomyContext = {},
): TaskAutonomyVerdict {
  const perClass = classification.classes.map((c) => ({ c, v: decideActionAutonomy(c, ctx) }));
  const decisions: ActionAutonomyDecision[] = perClass.map((x) => x.v.decision);
  const reasons: string[] = perClass
    .filter((x) => x.v.decision !== "AUTONOMOUS")
    .map((x) => `${x.c}: ${x.v.reason}`);

  if (
    ctx.ownerPolicy === "always" &&
    !(
      ctx.ownerApprovedGoal === true &&
      classification.classes.every((c) => COVERED_BY_GOAL_APPROVAL.has(c))
    )
  ) {
    decisions.push("APPROVAL_REQUIRED");
  }
  if (classification.unclassified.length > 0) {
    decisions.push("APPROVAL_REQUIRED");
    reasons.push(`capacité non classée : ${classification.unclassified.join(", ")}`);
  }
  if (classification.outsideAllowlist.length > 0) {
    decisions.push("APPROVAL_REQUIRED");
    reasons.push(`hors des capacités autorisées : ${classification.outsideAllowlist.join(", ")}`);
  }
  if (classification.escalatedBy.length > 0) {
    decisions.push("APPROVAL_REQUIRED");
    reasons.push(`déclaré sensible (${classification.escalatedBy.join(", ")})`);
  }

  const decision = strictestDecision(decisions);
  return {
    decision,
    riskClass: classification.riskClass,
    classes: classification.classes,
    reasons: decision === "AUTONOMOUS" ? [`${classification.riskClass}: autonome`] : reasons,
    policyVersion: POLICY_VERSION,
    fingerprint: [
      POLICY_VERSION,
      classification.classes.join("+"),
      `u=${[...classification.unclassified].sort().join(",")}`,
      `o=${[...classification.outsideAllowlist].sort().join(",")}`,
      `e=${[...classification.escalatedBy].sort().join(",")}`,
      `p=${ctx.ownerPolicy ?? "if_risky"}${ctx.ownerPolicy === "always" && ctx.ownerApprovedGoal ? "+approved" : ""}`,
    ].join("|"),
  };
}

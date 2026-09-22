import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";

/**
 * Classification of a self-modification action.
 */
export const selfModificationClassificationSchema = [
  "allowed",
  "protected",
  "unknown",
] as const;

export type SelfModificationClassification = (typeof selfModificationClassificationSchema)[number];

/**
 * Decision from the self-modification policy engine.
 * Fail-closed: UNKNOWN never becomes ALLOW.
 */
export const selfModificationDecisionSchema = {
  classification: { type: "string", enum: selfModificationClassificationSchema },
  allowed: { type: "boolean" },
  reason: { type: "string", minLength: 1 },
  evidence: { type: "array", items: { type: "string" } },
  protectedPaths: { type: "array", items: { type: "string" } },
  decidedAt: { type: "string", format: "date-time" },
  decidedBy: { type: "string", minLength: 1 },
} as const;

export type SelfModificationDecision = {
  classification: SelfModificationClassification;
  allowed: boolean;
  reason: string;
  evidence: string[];
  protectedPaths: string[];
  decidedAt: string;
  decidedBy: string;
};

/**
 * Protected domains that must never be autonomously modified.
 * These are the "crown jewels" - kernel authority, security policy, etc.
 */
export const PROTECTED_DOMAINS = [
  "kernel-authority",
  "security-policy",
  "credential-secrets-authority",
  "global-governance-policy",
  "completion-certification-authority",
] as const;

export type ProtectedDomain = (typeof PROTECTED_DOMAINS)[number];

/**
 * Protected paths that fall under protected domains.
 * Any modification touching these paths is DENIED.
 */
export const PROTECTED_PATHS: Record<ProtectedDomain, string[]> = {
  "kernel-authority": [
    "src/core/authorization/",
    "src/core/contracts/action-decision.ts",
    "src/core/contracts/approval.ts",
    "src/core/contracts/policy.ts",
    "src/core/contracts/policy-decision.ts",
    "src/server/autonomy/autonomous-mission-runner.ts",
    "src/server/autonomy/runtime.ts",
  ],
  "security-policy": [
    "src/core/identity/permissions.ts",
    "src/core/identity/role-management.ts",
    "src/core/identity/roles.ts",
    "src/core/contracts/skill.ts", // trustState, activationState
    "src/core/skills/lifecycle.ts",
    "src/server/autonomy/quality-control-recovery-sweeper.ts",
  ],
  "credential-secrets-authority": [
    "src/core/identity/tenant.ts",
    "src/core/contracts/high-level-goal.ts",
    "src/app/api/goals/convert-preview/route.ts",
    "src/server/usecases/ignite-autonomous-mission.ts",
    "src/server/services/credentials/",
    "src/server/repositories/postgres/",
  ],
  "global-governance-policy": [
    "src/core/contracts/task.ts",
    "src/core/contracts/task-execution.ts",
    "src/core/contracts/review.ts",
    "src/core/mission/contracts.ts",
    "src/core/contracts/scheduler.ts",
    "src/core/contracts/tool-gateway.ts",
    "src/server/usecases/start-autonomous-mission.ts",
  ],
  "completion-certification-authority": [
    "src/server/autonomy/autonomy-recovery-scheduler.ts",
    "src/server/autonomy/autonomy-recovery-sweeper.ts",
    "src/server/autonomy/autonomy-wakeup-service.ts",
    "src/server/autonomy/combined-autonomy-recovery-sweeper.ts",
    "src/server/autonomy/autonomous-mission-runner-restart.integration.test.ts",
  ],
};

/**
 * All protected paths flattened for quick lookup.
 */
export const ALL_PROTECTED_PATHS: string[] = Object.values(PROTECTED_PATHS).flat();

/**
 * Allowed ordinary self-improvement domains.
 * These are SAFE for autonomous modification with review.
 */
export const ALLOWED_IMPROVEMENT_DOMAINS = [
  "performance-optimization",
  "observability-enhancement",
  "documentation-improvement",
  "test-coverage",
  "refactoring-non-core",
  "dependency-update-non-breaking",
  "logging-enhancement",
  "metrics-instrumentation",
  "cache-optimization",
  "resource-cleanup",
] as const;

export type AllowedImprovementDomain = (typeof ALLOWED_IMPROVEMENT_DOMAINS)[number];

/**
 * Input for policy evaluation.
 */
export interface SelfModificationPolicyInput {
  /** Paths/files that would be modified */
  targetPaths: string[];
  /** Description of the proposed change */
  changeDescription: string;
  /** Category of improvement */
  improvementCategory: string;
  /** Whether this is a self-proposed change (vs human-proposed) */
  isSelfProposed: boolean;
  /** Actor requesting the change */
  actor: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

/**
 * Classify a self-modification based on target paths.
 * Returns "protected" if ANY path touches a protected domain.
 * Returns "unknown" if classification cannot be determined.
 * Returns "allowed" only if explicitly in allowed domains and not protected.
 */
export function classifySelfModification(
  input: SelfModificationPolicyInput,
): SelfModificationClassification {
  // First check: does any target path touch a protected domain?
  for (const targetPath of input.targetPaths) {
    for (const protectedPath of ALL_PROTECTED_PATHS) {
      if (targetPath.startsWith(protectedPath) || protectedPath.startsWith(targetPath)) {
        return "protected";
      }
      // Also check if targetPath is a parent of protected path
      if (protectedPath.startsWith(targetPath + "/")) {
        return "protected";
      }
    }
  }

  // Check if explicitly in allowed improvement domains
  const isAllowedDomain = ALLOWED_IMPROVEMENT_DOMAINS.includes(
    input.improvementCategory as AllowedImprovementDomain,
  );

  if (isAllowedDomain) {
    // Additional check: self-proposed changes need higher scrutiny
    if (input.isSelfProposed) {
      // Self-proposed allowed changes are still "allowed" but flagged
      return "allowed";
    }
    return "allowed";
  }

  // Cannot determine - fail closed
  return "unknown";
}

/**
 * Evaluate a self-modification request against policy.
 * FAIL-CLOSED: unknown classification -> DENIED.
 * Returns explicit reason and evidence.
 */
export function evaluateSelfModification(
  input: SelfModificationPolicyInput,
): SelfModificationDecision {
  const classification = classifySelfModification(input);
  const decidedAt = new Date().toISOString();
  const decidedBy = "self-modification-policy-engine";

  // Find which protected paths were matched (for evidence)
  const matchedProtectedPaths: string[] = [];
  for (const targetPath of input.targetPaths) {
    for (const protectedPath of ALL_PROTECTED_PATHS) {
      if (
        targetPath.startsWith(protectedPath) ||
        protectedPath.startsWith(targetPath) ||
        protectedPath.startsWith(targetPath + "/")
      ) {
        matchedProtectedPaths.push(targetPath);
      }
    }
  }

  let allowed = false;
  let reason = "";
  const evidence: string[] = [];

  switch (classification) {
    case "protected":
      allowed = false;
      reason = `Modification targets protected domain(s): ${matchedProtectedPaths.join(", ")}. Autonomous modification of kernel authority, security policy, credential/secrets authority, global governance policy, or completion/certification authority is explicitly denied.`;
      evidence.push(...input.targetPaths);
      evidence.push("fail-closed: protected domains require human approval");
      break;

    case "allowed":
      allowed = true;
      reason = `Change falls within allowed improvement domain: ${input.improvementCategory}. Ordinary self-improvement (performance, observability, documentation, tests, refactoring non-core, logging, metrics, cache, cleanup) is permitted with audit trail.`;
      evidence.push(`category: ${input.improvementCategory}`);
      evidence.push(`targetPaths: ${input.targetPaths.join(", ")}`);
      evidence.push(`actor: ${input.actor}`);
      if (input.isSelfProposed) {
        evidence.push("self-proposed: additional review recommended");
      }
      break;

    case "unknown":
    default:
      // FAIL-CLOSED: UNKNOWN must never become ALLOW
      allowed = false;
      reason = `Classification UNKNOWN for category "${input.improvementCategory}" and paths [${input.targetPaths.join(", ")}]. fail-closed policy: unknown classifications are explicitly denied. Human review required to classify and authorize.`;
      evidence.push(`category: ${input.improvementCategory} (not in allowed list)`);
      evidence.push(`targetPaths: ${input.targetPaths.join(", ")}`);
      evidence.push("fail-closed: unknown -> deny");
      break;
  }

  return {
    classification,
    allowed,
    reason,
    evidence,
    protectedPaths: matchedProtectedPaths,
    decidedAt,
    decidedBy,
  };
}

/**
 * Check if a specific path is protected.
 */
export function isPathProtected(path: string): boolean {
  return ALL_PROTECTED_PATHS.some(
    (protectedPath) =>
      path.startsWith(protectedPath) ||
      protectedPath.startsWith(path) ||
      protectedPath.startsWith(path + "/"),
  );
}

/**
 * Get the protected domain for a path, if any.
 */
export function getProtectedDomainForPath(path: string): ProtectedDomain | null {
  for (const [domain, paths] of Object.entries(PROTECTED_PATHS)) {
    for (const protectedPath of paths) {
      if (
        path.startsWith(protectedPath) ||
        protectedPath.startsWith(path) ||
        protectedPath.startsWith(path + "/")
      ) {
        return domain as ProtectedDomain;
      }
    }
  }
  return null;
}

/**
 * Check if a category is an allowed improvement domain.
 */
export function isAllowedImprovementCategory(category: string): boolean {
  return ALLOWED_IMPROVEMENT_DOMAINS.includes(category as AllowedImprovementDomain);
}

/**
 * Get all protected domains for audit/logging.
 */
export function getAllProtectedDomains(): ProtectedDomain[] {
  return [...PROTECTED_DOMAINS];
}

/**
 * Get all allowed improvement domains for audit/logging.
 */
export function getAllAllowedImprovementDomains(): AllowedImprovementDomain[] {
  return [...ALLOWED_IMPROVEMENT_DOMAINS];
}
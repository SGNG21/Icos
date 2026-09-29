/**
 * Classification of a self-modification action.
 */
export const selfModificationClassificationSchema = ["allowed", "protected", "unknown"] as const;

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
    // Tool Gateway authority (decision 0055): policy, grants, approvals, credentials.
    "src/core/tool-gateway/",
    "src/server/tool-gateway/",
    "src/server/database/tool-gateway-schema.ts",
    "drizzle/0049_tool_gateway.sql",
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
 * How a BACKLOG CATEGORY maps onto an allowed improvement domain (defect 30).
 *
 * `ImprovementCandidate.category` and `ALLOWED_IMPROVEMENT_DOMAINS` are two vocabularies that
 * never intersect — "maintainability" is not "refactoring-non-core" — so every candidate ICOS
 * proposed to itself classified as UNKNOWN and was denied fail-closed. Autonomous
 * self-modification was therefore structurally impossible, not merely unproven.
 *
 * THIS MAP IS DELIBERATELY PARTIAL. It names only the categories whose meaning is unambiguous
 * under the existing allow list; `reliability`, `security` and `other` are ABSENT on purpose
 * and keep classifying as UNKNOWN, because a reliability or security change is exactly the
 * kind that reaches core authority. A missing entry denies, as before.
 *
 * It widens nothing else: the protected-path rules still take precedence, so a mapped
 * category aimed at a protected path is still `protected`, and the review, the gate and the
 * real repository gates all still apply.
 */
export const BACKLOG_CATEGORY_DOMAINS: Readonly<Record<string, AllowedImprovementDomain>> = {
  performance: "performance-optimization",
  observability: "observability-enhancement",
  maintainability: "refactoring-non-core",
  cost: "resource-cleanup",
};

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

type CanonicalRepositoryPath = {
  path: string;
  segments: string[];
};

/**
 * Canonicalize a repository-relative path lexically. This deliberately does not
 * consult the host filesystem or process working directory.
 */
function canonicalizeRepositoryPath(candidate: string): CanonicalRepositoryPath | null {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
    return null;
  }

  const normalizedSeparators = candidate.replaceAll("\\", "/");
  if (
    normalizedSeparators.trim().length === 0 ||
    normalizedSeparators.slice(0, 2) === "//" ||
    normalizedSeparators[0] === "/" ||
    /^[a-z]:\//i.test(normalizedSeparators)
  ) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of normalizedSeparators.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return null;
  }

  return { path: segments.join("/"), segments };
}

function isSegmentPrefix(prefix: string[], candidate: string[]): boolean {
  return (
    prefix.length <= candidate.length &&
    prefix.every((segment, index) => segment === candidate[index])
  );
}

function pathsOverlap(a: CanonicalRepositoryPath, b: CanonicalRepositoryPath): boolean {
  return isSegmentPrefix(a.segments, b.segments) || isSegmentPrefix(b.segments, a.segments);
}

function canonicalProtectedPaths(): Array<{
  domain: ProtectedDomain;
  path: CanonicalRepositoryPath;
}> {
  const paths: Array<{ domain: ProtectedDomain; path: CanonicalRepositoryPath }> = [];
  for (const domain of PROTECTED_DOMAINS) {
    for (const protectedPath of PROTECTED_PATHS[domain]) {
      const canonical = canonicalizeRepositoryPath(protectedPath);
      if (canonical) {
        paths.push({ domain, path: canonical });
      }
    }
  }
  return paths;
}

function analyzeTargetPaths(targetPaths: string[]): {
  canonicalPaths: CanonicalRepositoryPath[];
  matchedProtectedPaths: string[];
  valid: boolean;
} {
  if (!Array.isArray(targetPaths) || targetPaths.length === 0) {
    return { canonicalPaths: [], matchedProtectedPaths: [], valid: false };
  }

  const canonicalPaths: CanonicalRepositoryPath[] = [];
  let valid = true;
  for (const targetPath of targetPaths) {
    const canonical = canonicalizeRepositoryPath(targetPath);
    if (!canonical) {
      valid = false;
      continue;
    }
    canonicalPaths.push(canonical);
  }

  const protectedPaths = canonicalProtectedPaths();
  const matchedProtectedPaths = canonicalPaths
    .filter((targetPath) =>
      protectedPaths.some((protectedPath) => pathsOverlap(targetPath, protectedPath.path)),
    )
    .map((targetPath) => targetPath.path);

  return { canonicalPaths, matchedProtectedPaths, valid };
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
  const pathAnalysis = analyzeTargetPaths(input.targetPaths);

  // Protected rules take precedence over every allow rule.
  if (pathAnalysis.matchedProtectedPaths.length > 0) {
    return "protected";
  }

  if (!pathAnalysis.valid) {
    return "unknown";
  }

  // Check if explicitly in allowed improvement domains, directly or by backlog category.
  const domain = BACKLOG_CATEGORY_DOMAINS[input.improvementCategory] ?? input.improvementCategory;
  const isAllowedDomain = ALLOWED_IMPROVEMENT_DOMAINS.includes(domain as AllowedImprovementDomain);

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
  const pathAnalysis = analyzeTargetPaths(input.targetPaths);
  const classification =
    pathAnalysis.matchedProtectedPaths.length > 0
      ? "protected"
      : !pathAnalysis.valid
        ? "unknown"
        : classifySelfModification(input);
  const decidedAt = new Date().toISOString();
  const decidedBy = "self-modification-policy-engine";
  const canonicalTargetPaths = pathAnalysis.canonicalPaths.map(({ path }) => path);
  const evidenceTargetPaths =
    canonicalTargetPaths.length === input.targetPaths.length
      ? canonicalTargetPaths
      : input.targetPaths;

  let allowed = false;
  let reason = "";
  const evidence: string[] = [];

  switch (classification) {
    case "protected":
      allowed = false;
      reason = `Modification targets protected domain(s): ${pathAnalysis.matchedProtectedPaths.join(", ")}. Autonomous modification of kernel authority, security policy, credential/secrets authority, global governance policy, or completion/certification authority is explicitly denied.`;
      evidence.push(...evidenceTargetPaths);
      evidence.push("fail-closed: protected domains require human approval");
      break;

    case "allowed":
      allowed = true;
      reason = `Change falls within allowed improvement domain: ${input.improvementCategory}. Ordinary self-improvement (performance, observability, documentation, tests, refactoring non-core, logging, metrics, cache, cleanup) is permitted with audit trail.`;
      evidence.push(`category: ${input.improvementCategory}`);
      evidence.push(`targetPaths: ${canonicalTargetPaths.join(", ")}`);
      evidence.push(`actor: ${input.actor}`);
      if (input.isSelfProposed) {
        evidence.push("self-proposed: additional review recommended");
      }
      break;

    case "unknown":
    default:
      // FAIL-CLOSED: UNKNOWN must never become ALLOW
      allowed = false;
      reason = `Classification UNKNOWN for category "${input.improvementCategory}" and paths [${evidenceTargetPaths.join(", ")}]. fail-closed policy: unknown classifications are explicitly denied. Human review required to classify and authorize.`;
      evidence.push(`category: ${input.improvementCategory} (not in allowed list)`);
      evidence.push(`targetPaths: ${evidenceTargetPaths.join(", ")}`);
      evidence.push("fail-closed: unknown -> deny");
      break;
  }

  return {
    classification,
    allowed,
    reason,
    evidence,
    protectedPaths: pathAnalysis.matchedProtectedPaths,
    decidedAt,
    decidedBy,
  };
}

/**
 * Check if a specific path is protected.
 */
export function isPathProtected(path: string): boolean {
  const candidate = canonicalizeRepositoryPath(path);
  return candidate
    ? canonicalProtectedPaths().some((protectedPath) => pathsOverlap(candidate, protectedPath.path))
    : false;
}

/**
 * Get the protected domain for a path, if any.
 */
export function getProtectedDomainForPath(path: string): ProtectedDomain | null {
  const candidate = canonicalizeRepositoryPath(path);
  if (!candidate) {
    return null;
  }
  for (const protectedPath of canonicalProtectedPaths()) {
    if (pathsOverlap(candidate, protectedPath.path)) {
      return protectedPath.domain;
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

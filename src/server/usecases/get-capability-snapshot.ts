import type {
  Capability,
  CapabilityStatus,
  DataCategory,
  RetentionPolicyRef,
  SensitivityLevel,
} from "@/core/contracts";
import { resolveActiveCapability } from "@/core/capabilities/lifecycle";
import type { Skill } from "@/core/contracts/skill";
import type { PolicyDecision, PolicyDenialCode, PolicyRequest } from "@/core/policy/contract";
import type { CapabilityRepository } from "@/server/repositories/capability-ports";
import type { SkillRepository } from "@/server/repositories/skill-ports";
import type { D1PolicyPort } from "@/server/policy/ports";

export type CapabilityPermissionState = "ALLOWED" | "APPROVAL_REQUIRED" | "DENIED" | "UNAVAILABLE";

export type TechnicalAvailabilityState = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";

export type TechnicalAvailabilityComponent = "CAPABILITY" | "PROVIDER" | "CREDENTIAL" | "TOOL";

export type TechnicalAvailabilitySource =
  | "CAPABILITY_REGISTRY"
  | "AI_HEALTH_PORT"
  | "CREDENTIAL_BROKER_PORT"
  | "TOOL_AVAILABILITY_PROBE"
  | "INJECTED_RUNTIME_PROBE"
  | "NOT_ESTABLISHED";

const SNAPSHOT_TEXT_MAX_LENGTH = 512;
const SNAPSHOT_COLLECTION_MAX_ITEMS = 64;

const boundedText = (value: string): string => value.slice(0, SNAPSHOT_TEXT_MAX_LENGTH);

/**
 * Preuve technique bornée. Elle ne transporte ni permission, ni approbation,
 * ni credential brut. `key` est un identifiant logique, jamais un secret.
 */
export interface TechnicalAvailabilityEvidence {
  component: TechnicalAvailabilityComponent;
  key: string;
  state: TechnicalAvailabilityState;
  source: TechnicalAvailabilitySource;
  reason: string;
}

/**
 * Résultat d'une sonde runtime en lecture seule.
 *
 * Une déclaration de Skill ne satisfait jamais ce contrat à elle seule :
 * l'adaptateur de sonde doit consulter sa source runtime canonique.
 */
export interface TechnicalAvailabilityAssessment {
  state: TechnicalAvailabilityState;
  evidence: readonly TechnicalAvailabilityEvidence[];
}

export interface CapabilityAvailabilityProbe {
  check(input: {
    capability: Capability;
    activeSkills: readonly Skill[];
  }): Promise<TechnicalAvailabilityAssessment>;
}

export interface CapabilitySnapshotScope {
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  ownerTenantId?: string;
  credentialScopes: readonly string[];
}

export interface CapabilitySnapshotConstraints {
  classification: {
    sensitivityLevel?: SensitivityLevel;
    dataCategory?: DataCategory;
  };
  retentionPolicy?: RetentionPolicyRef;
  tools: readonly { key: string; required: boolean }[];
  credentials: readonly { kind: string; scope: string; required: boolean }[];
  network: readonly { domain: string; required: boolean }[];
  isolation: readonly { level: string; networkMode: string }[];
  truncated: boolean;
}

export interface CapabilitySnapshotSource {
  capability: {
    source: "CAPABILITY_REPOSITORY";
    key?: string;
    status?: CapabilityStatus;
  };
  skills: readonly {
    source: "SKILL_REPOSITORY";
    skillId: string;
    skillKey: string;
    version: string;
  }[];
  skillsTruncated: boolean;
  technicalAvailability: readonly TechnicalAvailabilityEvidence[];
  policy:
    | { source: "D1_POLICY_PORT"; outcome: PolicyDecision["outcome"]; code?: PolicyDenialCode }
    | { source: "D1_POLICY_PORT"; outcome: "NOT_EVALUATED" };
}

export interface CapabilitySnapshotItem {
  capabilityId: string;
  available: boolean;
  permissionState: CapabilityPermissionState;
  scope: CapabilitySnapshotScope;
  reason: string;
  source: CapabilitySnapshotSource;
  constraints: CapabilitySnapshotConstraints;
}

export interface GetCapabilitySnapshotDeps {
  capabilities: Pick<CapabilityRepository, "list">;
  policy: D1PolicyPort;
  availability?: CapabilityAvailabilityProbe;
  skills?: Pick<SkillRepository, "list">;
}

export interface GetCapabilitySnapshotInput {
  /**
   * Requête D1 complète fournie par la frontière authentifiée. Le use case
   * ajoute uniquement `capabilityKey`; il n'ajoute jamais de rôle ou de niveau
   * d'autorisation.
   */
  policyRequest: Omit<PolicyRequest, "capabilityKey">;
  /** Absent = toutes les capacités canoniques. Les ids inconnus restent visibles. */
  capabilityIds?: readonly string[];
}

interface TechnicalRequirements {
  tools: Array<{ key: string; required: boolean }>;
  credentials: Array<{ kind: string; scope: string; required: boolean }>;
  network: Array<{ domain: string; required: boolean }>;
  isolation: Array<{ level: string; networkMode: string }>;
  truncated: boolean;
}

const cmp = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const uniqueBy = <T>(items: readonly T[], keyOf: (item: T) => string): T[] => {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (!byKey.has(key)) byKey.set(key, structuredClone(item));
  }
  return [...byKey.entries()].sort(([left], [right]) => cmp(left, right)).map(([, item]) => item);
};

function collectRequirements(activeSkills: readonly Skill[]): TechnicalRequirements {
  const tools = uniqueBy(
    activeSkills.flatMap((skill) =>
      (skill.toolRequirements ?? []).map((requirement) => ({
        key: boundedText(requirement.requiredTool),
        required: requirement.required,
      })),
    ),
    (requirement) => `${requirement.key}\u0000${requirement.required}`,
  );
  const credentials = uniqueBy(
    activeSkills.flatMap((skill) =>
      (skill.credentialRequirements ?? []).map((requirement) => ({
        kind: boundedText(requirement.requiredCredentialKind),
        scope: boundedText(requirement.requiredScope),
        required: requirement.required,
      })),
    ),
    (requirement) => `${requirement.kind}\u0000${requirement.scope}\u0000${requirement.required}`,
  );
  const network = uniqueBy(
    activeSkills.flatMap((skill) =>
      (skill.networkRequirements ?? []).map((requirement) => ({
        domain: boundedText(requirement.requiredDomain),
        required: requirement.required,
      })),
    ),
    (requirement) => `${requirement.domain}\u0000${requirement.required}`,
  );
  const isolation = uniqueBy(
    activeSkills.flatMap((skill) =>
      skill.executionIsolationRequirement
        ? [
            {
              level: skill.executionIsolationRequirement.requiredIsolationLevel,
              networkMode: skill.executionIsolationRequirement.requiredNetworkMode,
            },
          ]
        : [],
    ),
    (requirement) => `${requirement.level}\u0000${requirement.networkMode}`,
  );

  const all = [tools, credentials, network, isolation];
  return {
    tools: tools.slice(0, SNAPSHOT_COLLECTION_MAX_ITEMS),
    credentials: credentials.slice(0, SNAPSHOT_COLLECTION_MAX_ITEMS),
    network: network.slice(0, SNAPSHOT_COLLECTION_MAX_ITEMS),
    isolation: isolation.slice(0, SNAPSHOT_COLLECTION_MAX_ITEMS),
    truncated: all.some((items) => items.length > SNAPSHOT_COLLECTION_MAX_ITEMS),
  };
}

function requirementHasEvidence(
  evidence: readonly TechnicalAvailabilityEvidence[],
  component: "TOOL" | "CREDENTIAL",
  key: string,
): boolean {
  return evidence.some(
    (item) => item.component === component && item.key === key && item.state === "AVAILABLE",
  );
}

function normalizeAssessment(
  assessment: TechnicalAvailabilityAssessment,
  requirements: TechnicalRequirements,
): TechnicalAvailabilityAssessment {
  const normalizedEvidence = [...assessment.evidence]
    .map((item) => ({
      component: item.component,
      key: boundedText(item.key),
      state: item.state,
      source: item.source,
      reason: boundedText(item.reason),
    }))
    .sort(
      (left, right) =>
        cmp(left.component, right.component) ||
        cmp(left.key, right.key) ||
        cmp(left.source, right.source) ||
        cmp(left.reason, right.reason),
    );
  if (normalizedEvidence.length > SNAPSHOT_COLLECTION_MAX_ITEMS || requirements.truncated) {
    return {
      state: "UNKNOWN",
      evidence: [
        ...normalizedEvidence.slice(0, SNAPSHOT_COLLECTION_MAX_ITEMS - 1),
        {
          component: "CAPABILITY",
          key: "snapshot-bounds",
          state: "UNKNOWN",
          source: "NOT_ESTABLISHED",
          reason: "Technical evidence or requirements exceeded snapshot bounds",
        },
      ],
    };
  }
  const evidence = normalizedEvidence;

  const explicitlyUnavailable = evidence.some((item) => item.state === "UNAVAILABLE");
  if (assessment.state === "UNAVAILABLE" || explicitlyUnavailable) {
    const supported = evidence.some((item) => item.state === "UNAVAILABLE");
    return supported
      ? { state: "UNAVAILABLE", evidence }
      : {
          state: "UNKNOWN",
          evidence: [
            ...evidence,
            {
              component: "CAPABILITY",
              key: "technical-availability",
              state: "UNKNOWN",
              source: "NOT_ESTABLISHED",
              reason: "Unavailable result had no explicit runtime evidence",
            },
          ],
        };
  }

  const containsUnknownEvidence = evidence.some((item) => item.state === "UNKNOWN");
  const containsAvailableEvidence = evidence.some((item) => item.state === "AVAILABLE");
  if (assessment.state !== "AVAILABLE" || !containsAvailableEvidence || containsUnknownEvidence) {
    return {
      state: "UNKNOWN",
      evidence:
        evidence.length > 0
          ? evidence
          : [
              {
                component: "CAPABILITY",
                key: "technical-availability",
                state: "UNKNOWN",
                source: "NOT_ESTABLISHED",
                reason: "Technical availability was not established",
              },
            ],
    };
  }

  const missingToolEvidence = requirements.tools
    .filter((requirement) => requirement.required)
    .some((requirement) => !requirementHasEvidence(evidence, "TOOL", requirement.key));
  const missingCredentialEvidence = requirements.credentials
    .filter((requirement) => requirement.required)
    .some(
      (requirement) =>
        !requirementHasEvidence(evidence, "CREDENTIAL", `${requirement.kind}:${requirement.scope}`),
    );

  if (missingToolEvidence || missingCredentialEvidence) {
    return {
      state: "UNKNOWN",
      evidence: [
        ...evidence,
        {
          component: "CAPABILITY",
          key: "technical-requirements",
          state: "UNKNOWN",
          source: "NOT_ESTABLISHED",
          reason: "Required tool or credential availability was not established",
        },
      ],
    };
  }

  return { state: "AVAILABLE", evidence };
}

function unavailableEvidence(
  capabilityId: string,
  reason: string,
): TechnicalAvailabilityEvidence[] {
  return [
    {
      component: "CAPABILITY",
      key: capabilityId,
      state: "UNAVAILABLE",
      source: "CAPABILITY_REGISTRY",
      reason,
    },
  ];
}

function unknownEvidence(reason: string): TechnicalAvailabilityEvidence[] {
  return [
    {
      component: "CAPABILITY",
      key: "technical-availability",
      state: "UNKNOWN",
      source: "NOT_ESTABLISHED",
      reason,
    },
  ];
}

function buildScope(
  request: Omit<PolicyRequest, "capabilityKey">,
  requirements: TechnicalRequirements,
): CapabilitySnapshotScope {
  const credentialScopes = [
    ...new Set(
      requirements.credentials
        .filter((requirement) => requirement.required)
        .map((requirement) => requirement.scope),
    ),
  ].sort(cmp);

  return {
    tenantId: boundedText(request.tenant.tenantId),
    action: boundedText(request.action),
    resourceType: boundedText(request.resource.type),
    resourceId: boundedText(request.resource.id),
    ownerTenantId: request.resource.ownerTenantId
      ? boundedText(request.resource.ownerTenantId)
      : undefined,
    credentialScopes,
  };
}

function buildConstraints(
  capability: Capability | undefined,
  requirements: TechnicalRequirements,
): CapabilitySnapshotConstraints {
  return {
    classification: {
      sensitivityLevel: capability?.sensitivityLevel,
      dataCategory: capability?.dataCategory,
    },
    retentionPolicy: capability?.retentionPolicyRef
      ? {
          maxRetentionDays: capability.retentionPolicyRef.maxRetentionDays,
          legalBasis: capability.retentionPolicyRef.legalBasis,
          purpose: boundedText(capability.retentionPolicyRef.purpose),
        }
      : undefined,
    tools: requirements.tools,
    credentials: requirements.credentials,
    network: requirements.network,
    isolation: requirements.isolation,
    truncated: requirements.truncated,
  };
}

function sourceFor(
  capability: Capability | undefined,
  activeSkills: readonly Skill[],
  evidence: readonly TechnicalAvailabilityEvidence[],
  policy:
    { outcome: PolicyDecision["outcome"]; code?: PolicyDenialCode } | { outcome: "NOT_EVALUATED" },
): CapabilitySnapshotSource {
  return {
    capability: {
      source: "CAPABILITY_REPOSITORY",
      key: capability?.key ? boundedText(capability.key) : undefined,
      status: capability?.status,
    },
    skills: activeSkills
      .map((skill) => ({
        source: "SKILL_REPOSITORY" as const,
        skillId: boundedText(skill.id),
        skillKey: boundedText(skill.skillKey),
        version: boundedText(skill.version),
      }))
      .sort(
        (left, right) =>
          cmp(left.skillKey, right.skillKey) ||
          cmp(left.version, right.version) ||
          cmp(left.skillId, right.skillId),
      )
      .slice(0, SNAPSHOT_COLLECTION_MAX_ITEMS),
    skillsTruncated: activeSkills.length > SNAPSHOT_COLLECTION_MAX_ITEMS,
    technicalAvailability: evidence.map((item) => structuredClone(item)),
    policy: { source: "D1_POLICY_PORT", ...policy },
  };
}

function unavailableItem(input: {
  capabilityId: string;
  capability?: Capability;
  activeSkills?: readonly Skill[];
  policyRequest: Omit<PolicyRequest, "capabilityKey">;
  requirements?: TechnicalRequirements;
  evidence: readonly TechnicalAvailabilityEvidence[];
  reason: string;
}): CapabilitySnapshotItem {
  const requirements = input.requirements ?? {
    tools: [],
    credentials: [],
    network: [],
    isolation: [],
    truncated: false,
  };
  return {
    capabilityId: input.capabilityId,
    available: false,
    permissionState: "UNAVAILABLE",
    scope: buildScope(input.policyRequest, requirements),
    reason: input.reason,
    source: sourceFor(input.capability, input.activeSkills ?? [], input.evidence, {
      outcome: "NOT_EVALUATED",
    }),
    constraints: buildConstraints(input.capability, requirements),
  };
}

function fromPolicyDecision(input: {
  capability: Capability;
  activeSkills: readonly Skill[];
  policyRequest: Omit<PolicyRequest, "capabilityKey">;
  requirements: TechnicalRequirements;
  evidence: readonly TechnicalAvailabilityEvidence[];
  decision: PolicyDecision;
}): CapabilitySnapshotItem {
  const common = {
    capabilityId: input.capability.id,
    available: true,
    scope: buildScope(input.policyRequest, input.requirements),
    reason: boundedText(input.decision.reason),
    constraints: buildConstraints(input.capability, input.requirements),
  };

  if (input.decision.outcome === "deny") {
    return {
      ...common,
      permissionState: "DENIED",
      source: sourceFor(input.capability, input.activeSkills, input.evidence, {
        outcome: "deny",
        code: input.decision.code,
      }),
    };
  }

  if (input.decision.outcome === "require_approval") {
    return {
      ...common,
      permissionState: "APPROVAL_REQUIRED",
      source: sourceFor(input.capability, input.activeSkills, input.evidence, {
        outcome: "require_approval",
      }),
    };
  }

  return {
    ...common,
    permissionState: "ALLOWED",
    source: sourceFor(input.capability, input.activeSkills, input.evidence, {
      outcome: "allow",
    }),
  };
}

/**
 * Lecture déterministe de la vérité runtime disponible.
 *
 * Ordre de décision :
 * 1. registre canonique et lifecycle de la Capability ;
 * 2. preuve technique explicite, avec UNKNOWN fail-safe ;
 * 3. décision D1 inchangée.
 *
 * Cette fonction n'écrit dans aucun repository et ne consulte ni contexte de
 * conversation, ni texte de mission, ni approval, ni ExecutionGrant.
 */
export async function getCapabilitySnapshot(
  deps: GetCapabilitySnapshotDeps,
  input: GetCapabilitySnapshotInput,
): Promise<CapabilitySnapshotItem[]> {
  const capabilities = await deps.capabilities.list();
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  const byKey = new Map(capabilities.map((capability) => [capability.key, capability]));
  const capabilityIds = input.capabilityIds
    ? [...new Set(input.capabilityIds)].sort(cmp)
    : [...byId.keys()].sort(cmp);

  const activeSkills = deps.skills
    ? (
        await deps.skills.list(input.policyRequest.tenant.tenantId, {
          activationState: "active",
        })
      )
        .map((skill) => structuredClone(skill))
        .sort(
          (left, right) =>
            cmp(left.skillKey, right.skillKey) ||
            cmp(left.version, right.version) ||
            cmp(left.id, right.id),
        )
    : [];

  const result: CapabilitySnapshotItem[] = [];

  for (const capabilityId of capabilityIds) {
    const capability = byId.get(capabilityId);
    if (!capability) {
      const reason = "Capability is not present in the canonical registry";
      result.push(
        unavailableItem({
          capabilityId,
          policyRequest: input.policyRequest,
          evidence: unavailableEvidence(capabilityId, reason),
          reason,
        }),
      );
      continue;
    }

    const matchingSkills = activeSkills.filter((skill) =>
      skill.capabilityKeys.includes(capability.key),
    );
    const requirements = collectRequirements(matchingSkills);

    const resolved = await resolveActiveCapability(
      capability.key,
      async (key) => byKey.get(key) ?? null,
    );
    if (!resolved.usable) {
      const reason = `Capability status '${capability.status}' is not active`;
      result.push(
        unavailableItem({
          capabilityId,
          capability,
          activeSkills: matchingSkills,
          policyRequest: input.policyRequest,
          requirements,
          evidence: unavailableEvidence(capabilityId, reason),
          reason,
        }),
      );
      continue;
    }

    let assessment: TechnicalAvailabilityAssessment;
    if (!deps.availability) {
      assessment = {
        state: "UNKNOWN",
        evidence: unknownEvidence("No canonical technical availability probe was provided"),
      };
    } else {
      try {
        assessment = await deps.availability.check({
          capability: structuredClone(capability),
          activeSkills: structuredClone(matchingSkills),
        });
      } catch {
        assessment = {
          state: "UNKNOWN",
          evidence: unknownEvidence("Technical availability probe failed closed"),
        };
      }
    }

    const normalized = normalizeAssessment(assessment, requirements);
    if (normalized.state !== "AVAILABLE") {
      const reason =
        normalized.state === "UNAVAILABLE"
          ? "A required runtime component is unavailable"
          : "Technical availability is not established";
      result.push(
        unavailableItem({
          capabilityId,
          capability,
          activeSkills: matchingSkills,
          policyRequest: input.policyRequest,
          requirements,
          evidence: normalized.evidence,
          reason,
        }),
      );
      continue;
    }

    const request: PolicyRequest = {
      ...structuredClone(input.policyRequest),
      actor: structuredClone(input.policyRequest.actor),
      tenant: structuredClone(input.policyRequest.tenant),
      resource: structuredClone(input.policyRequest.resource),
      capabilityKey: capability.key,
    };
    let decision: PolicyDecision;
    try {
      decision = await deps.policy.decide(request);
    } catch {
      decision = {
        outcome: "deny",
        reason: "D1 policy decision could not be established",
        code: "policy_denied",
      };
    }
    result.push(
      fromPolicyDecision({
        capability,
        activeSkills: matchingSkills,
        policyRequest: input.policyRequest,
        requirements,
        evidence: normalized.evidence,
        decision,
      }),
    );
  }

  return result.sort((left, right) => cmp(left.capabilityId, right.capabilityId));
}

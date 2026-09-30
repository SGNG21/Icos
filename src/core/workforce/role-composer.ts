import type { ActorRef, AgentKind, AgentRole, SkillDefinition } from "./contracts";
import { ceilingForSkills, isWorkforceAdmin, maxRisk, type Principal } from "./governance";

/**
 * DYNAMIC ROLE CREATION (decision 0057).
 *
 *   need → capability decomposition → existing-skill lookup → role composition
 *        → policy validation → certification → registration (activation)
 *
 * Decomposing free text into capabilities is a model's job: it sits behind
 * `CapabilityDecomposer` and is NOT_CONNECTED in this lane. Everything after it is pure and
 * deterministic. A composed role NEVER carries tools or authority: those are granted to an
 * agent, separately, by a human.
 */

/** Port for the model side. No implementation in this lane (NOT_CONNECTED). */
export interface CapabilityDecomposer {
  decompose(need: string): Promise<{ capabilities: string[]; source: "REAL" | "SIMULATED" }>;
}

export type CompositionResult =
  | { kind: "REUSE_EXISTING"; roleId: string; coveredBy: string[] }
  | { kind: "INCOMPLETE"; coveredBy: string[]; uncoveredCapabilities: string[] }
  | { kind: "DRAFT"; role: AgentRole; coveredBy: string[] };

/**
 * Greedy set cover over active skills: most newly-covered capabilities first, then lower risk,
 * then skillId. Deterministic for fixed inputs.
 */
export function coverCapabilities(
  capabilities: readonly string[],
  skills: readonly SkillDefinition[],
): { chosen: SkillDefinition[]; uncovered: string[] } {
  const riskRank = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;
  const remaining = new Set(capabilities);
  const pool = skills.filter((s) => s.status === "active");
  const chosen: SkillDefinition[] = [];
  while (remaining.size > 0) {
    const best = pool
      .filter((s) => !chosen.includes(s))
      .map((s) => ({ s, gain: s.capabilities.filter((c) => remaining.has(c)).length }))
      .filter((x) => x.gain > 0)
      .sort(
        (a, b) =>
          b.gain - a.gain ||
          riskRank[a.s.risk] - riskRank[b.s.risk] ||
          a.s.skillId.localeCompare(b.s.skillId),
      )[0];
    if (!best) break;
    chosen.push(best.s);
    best.s.capabilities.forEach((c) => remaining.delete(c));
  }
  return { chosen, uncovered: [...remaining].sort() };
}

export interface ComposeInput {
  need: string;
  roleId: string;
  name: string;
  capabilities: readonly string[];
  agentKinds: readonly AgentKind[];
  skills: readonly SkillDefinition[];
  existingRoles: readonly AgentRole[];
  createdBy: ActorRef;
}

export function composeRole(input: ComposeInput): CompositionResult {
  const { chosen, uncovered } = coverCapabilities(input.capabilities, input.skills);
  const coveredBy = chosen.map((s) => s.skillId);
  if (uncovered.length > 0) {
    // A missing competence becomes a new SkillDefinition through its own review — never
    // invented here.
    return { kind: "INCOMPLETE", coveredBy, uncoveredCapabilities: uncovered };
  }

  const skillById = new Map(input.skills.map((s) => [s.skillId, s]));
  const reusable = input.existingRoles
    .filter((r) => r.status === "active" && input.agentKinds.every((k) => r.agentKinds.includes(k)))
    .filter((r) => {
      const caps = new Set(r.skills.flatMap((id) => skillById.get(id)?.capabilities ?? []));
      return input.capabilities.every((c) => caps.has(c));
    })
    .sort((a, b) => a.skills.length - b.skills.length || a.roleId.localeCompare(b.roleId))[0];
  if (reusable)
    return { kind: "REUSE_EXISTING", roleId: reusable.roleId, coveredBy: reusable.skills };

  const agentKinds = input.agentKinds.filter((k) =>
    chosen.every((s) => s.compatibleAgentKinds.includes(k)),
  );
  return {
    kind: "DRAFT",
    coveredBy,
    role: {
      roleId: input.roleId,
      name: input.name,
      version: "1.0.0",
      description: `Composed for: ${input.need}`,
      status: "draft",
      agentKinds: agentKinds.length > 0 ? agentKinds : [...input.agentKinds],
      skills: coveredBy,
      responsibilities: [input.need],
      kpis: [],
      autonomyCeiling: ceilingForSkills(chosen),
      provenance: { source: "dynamic_composition", createdBy: input.createdBy, need: input.need },
    },
  };
}

export type RoleViolation =
  | "UNKNOWN_SKILL"
  | "SKILL_NOT_ACTIVE"
  | "KIND_NOT_SUPPORTED_BY_SKILL"
  | "CEILING_ABOVE_RISK"
  | "NOT_DRAFT"
  | "NOT_CERTIFIED"
  | "SELF_CERTIFICATION"
  | "HUMAN_CERTIFICATION_REQUIRED"
  | "MISSING_TESTS"
  | "ACTOR_NOT_AUTHORIZED";

export function validateRole(role: AgentRole, skills: readonly SkillDefinition[]): RoleViolation[] {
  const v: RoleViolation[] = [];
  const used = role.skills.map((id) => skills.find((s) => s.skillId === id));
  if (used.some((s) => !s)) return ["UNKNOWN_SKILL"];
  const defined = used as SkillDefinition[];
  if (defined.some((s) => s.status !== "active")) v.push("SKILL_NOT_ACTIVE");
  if (role.agentKinds.some((k) => defined.some((s) => !s.compatibleAgentKinds.includes(k)))) {
    v.push("KIND_NOT_SUPPORTED_BY_SKILL");
  }
  if (role.autonomyCeiling > ceilingForSkills(defined)) v.push("CEILING_ABOVE_RISK");
  return v;
}

/** Every certification test of every skill in the role. */
export function requiredRoleTests(role: AgentRole, skills: readonly SkillDefinition[]): string[] {
  const ids = role.skills.flatMap((id) => skills.find((s) => s.skillId === id)?.tests ?? []);
  return [...new Set(ids)].sort();
}

/**
 * Certification: by someone other than the creator; by a human when the role carries HIGH or
 * CRITICAL risk; every required test passed. Returns the certified role or the violations.
 */
export function certifyRole(input: {
  role: AgentRole;
  skills: readonly SkillDefinition[];
  certifier: Principal;
  testsPassed: readonly string[];
  now: string;
}): { ok: true; role: AgentRole } | { ok: false; violations: RoleViolation[] } {
  const { role, skills, certifier, testsPassed, now } = input;
  const v: RoleViolation[] = validateRole(role, skills);
  if (role.status !== "draft") v.push("NOT_DRAFT");
  if (certifier.id === role.provenance.createdBy.id) v.push("SELF_CERTIFICATION");
  const used = skills.filter((s) => role.skills.includes(s.skillId));
  const risk = maxRisk(used);
  if ((risk === "HIGH" || risk === "CRITICAL") && certifier.kind !== "human") {
    v.push("HUMAN_CERTIFICATION_REQUIRED");
  }
  if (certifier.kind === "system") v.push("ACTOR_NOT_AUTHORIZED");
  const missing = requiredRoleTests(role, skills).filter((t) => !testsPassed.includes(t));
  if (missing.length > 0) v.push("MISSING_TESTS");
  if (v.length > 0) return { ok: false, violations: [...new Set(v)] };
  return {
    ok: true,
    role: {
      ...role,
      status: "certified",
      certification: {
        certifiedBy: { kind: certifier.kind, id: certifier.id },
        certifiedAt: now,
        testsPassed: [...testsPassed].sort(),
      },
    },
  };
}

/** Registration: a certified role becomes assignable only by a workforce admin. */
export function activateRole(
  role: AgentRole,
  principal: Principal,
): { ok: true; role: AgentRole } | { ok: false; violations: RoleViolation[] } {
  const v: RoleViolation[] = [];
  if (role.status !== "certified" || !role.certification) v.push("NOT_CERTIFIED");
  if (!isWorkforceAdmin(principal)) v.push("ACTOR_NOT_AUTHORIZED");
  return v.length > 0
    ? { ok: false, violations: v }
    : { ok: true, role: { ...role, status: "active" } };
}

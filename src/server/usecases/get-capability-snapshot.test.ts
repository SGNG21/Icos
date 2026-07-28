import { describe, expect, it, vi } from "vitest";

import type { Capability } from "@/core/contracts";
import type { Skill } from "@/core/contracts/skill";
import { D1PolicyService } from "@/server/policy/d1-policy-service";
import type { D1PolicyPort } from "@/server/policy/ports";
import type { CapabilityRepository } from "@/server/repositories/capability-ports";
import type { SkillRepository } from "@/server/repositories/skill-ports";

import {
  getCapabilitySnapshot,
  type CapabilityAvailabilityProbe,
  type GetCapabilitySnapshotDeps,
  type TechnicalAvailabilityAssessment,
  type TechnicalAvailabilityComponent,
  type TechnicalAvailabilitySource,
} from "./get-capability-snapshot";

const NOW = "2026-07-28T08:00:00.000Z";

function capability(
  id: string,
  status: Capability["status"] = "active",
  key = `code.${id.replace(/^cap-/, "")}`,
): Capability {
  return {
    id,
    key,
    name: id,
    category: "code",
    status,
    sensitivityLevel: "C1",
    dataCategory: "INTERNAL",
    retentionPolicyRef: {
      maxRetentionDays: 30,
      legalBasis: "contract",
      purpose: "testing",
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function skill(
  overrides: Partial<Skill> & Pick<Skill, "id" | "skillKey" | "capabilityKeys">,
): Skill {
  return {
    tenantId: "tenant-1",
    version: "1.0.0",
    name: overrides.skillKey,
    category: "code",
    trustState: "approved",
    activationState: "active",
    contentHash: `hash-${overrides.id}`,
    provenance: {
      source: "internal",
      origin: "human",
      contentHash: `hash-${overrides.id}`,
      importedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function capabilityRepository(
  items: readonly Capability[],
): Pick<CapabilityRepository, "list"> & { writes: number } {
  return {
    writes: 0,
    list: vi.fn(async () => structuredClone([...items])),
  };
}

function skillRepository(items: readonly Skill[]): Pick<SkillRepository, "list"> {
  return {
    list: vi.fn(async (_tenantId, filters) =>
      structuredClone(
        items.filter(
          (item) => !filters?.activationState || item.activationState === filters.activationState,
        ),
      ),
    ),
  };
}

function assessment(
  state: TechnicalAvailabilityAssessment["state"],
  component: TechnicalAvailabilityComponent = "CAPABILITY",
  source: TechnicalAvailabilitySource = "INJECTED_RUNTIME_PROBE",
  key = "capability-runtime",
): TechnicalAvailabilityAssessment {
  return {
    state,
    evidence: [
      {
        component,
        key,
        state,
        source,
        reason: `${component.toLowerCase()} is ${state.toLowerCase()}`,
      },
    ],
  };
}

function availability(
  result: TechnicalAvailabilityAssessment = assessment("AVAILABLE"),
): CapabilityAvailabilityProbe & { calls: number } {
  return {
    calls: 0,
    async check() {
      this.calls += 1;
      return structuredClone(result);
    },
  };
}

function policy(outcome: "allow" | "deny" | "require_approval"): D1PolicyPort & { calls: number } {
  return {
    calls: 0,
    async decide() {
      this.calls += 1;
      if (outcome === "allow") {
        return { outcome, reason: "Policy allowed", attestedAt: NOW };
      }
      if (outcome === "deny") {
        return { outcome, reason: "Permission missing", code: "forbidden" };
      }
      return { outcome, reason: "Human approval required", expiresAt: NOW };
    },
  };
}

function input(
  roles: readonly string[] | undefined = ["operations.run"],
): Parameters<typeof getCapabilitySnapshot>[1] {
  return {
    policyRequest: {
      actor: {
        kind: "agent",
        id: "agent-1",
        tenantId: "tenant-1",
        roles,
        authorizationLevel: 2,
      },
      tenant: { tenantId: "tenant-1" },
      action: "run",
      resource: {
        type: "operations",
        id: "resource-1",
        ownerTenantId: "tenant-1",
      },
      risk: "read_only",
      hasExternalEffect: false,
    },
  };
}

function deps(
  capabilities: readonly Capability[],
  overrides: Partial<GetCapabilitySnapshotDeps> = {},
): GetCapabilitySnapshotDeps {
  return {
    capabilities: capabilityRepository(capabilities),
    policy: policy("allow"),
    availability: availability(),
    ...overrides,
  };
}

describe("getCapabilitySnapshot", () => {
  it("maps active + explicit availability + D1 allow to ALLOWED", async () => {
    const [item] = await getCapabilitySnapshot(deps([capability("cap-a")]), input());

    expect(item.available).toBe(true);
    expect(item.permissionState).toBe("ALLOWED");
    expect(item.source.policy).toEqual({ source: "D1_POLICY_PORT", outcome: "allow" });
  });

  it("maps D1 require_approval to APPROVAL_REQUIRED without creating approval", async () => {
    const approvals: unknown[] = [];
    const [item] = await getCapabilitySnapshot(
      deps([capability("cap-a")], { policy: policy("require_approval") }),
      input(),
    );

    expect(item.permissionState).toBe("APPROVAL_REQUIRED");
    expect(item.reason).toBe("Human approval required");
    expect(approvals).toEqual([]);
  });

  it("maps D1 deny to DENIED and preserves its safe reason/code", async () => {
    const [item] = await getCapabilitySnapshot(
      deps([capability("cap-a")], { policy: policy("deny") }),
      input(),
    );

    expect(item.available).toBe(true);
    expect(item.permissionState).toBe("DENIED");
    expect(item.reason).toBe("Permission missing");
    expect(item.source.policy).toEqual({
      source: "D1_POLICY_PORT",
      outcome: "deny",
      code: "forbidden",
    });
  });

  it("maps inactive capability to UNAVAILABLE without consulting runtime or D1", async () => {
    const probe = availability();
    const d1 = policy("allow");
    const [item] = await getCapabilitySnapshot(
      deps([capability("cap-a", "deprecated")], {
        availability: probe,
        policy: d1,
      }),
      input(),
    );

    expect(item.permissionState).toBe("UNAVAILABLE");
    expect(item.available).toBe(false);
    expect(probe.calls).toBe(0);
    expect(d1.calls).toBe(0);
  });

  it("maps an unknown requested capability to UNAVAILABLE", async () => {
    const [item] = await getCapabilitySnapshot(deps([]), {
      ...input(),
      capabilityIds: ["cap-missing"],
    });

    expect(item.capabilityId).toBe("cap-missing");
    expect(item.permissionState).toBe("UNAVAILABLE");
    expect(item.source.capability).toEqual({ source: "CAPABILITY_REPOSITORY" });
  });

  it("maps explicit provider unavailability to UNAVAILABLE", async () => {
    const [item] = await getCapabilitySnapshot(
      deps([capability("cap-a")], {
        availability: availability(
          assessment("UNAVAILABLE", "PROVIDER", "AI_HEALTH_PORT", "omniroute"),
        ),
      }),
      input(),
    );

    expect(item.permissionState).toBe("UNAVAILABLE");
    expect(item.source.technicalAvailability[0]?.source).toBe("AI_HEALTH_PORT");
  });

  it("maps explicit required credential unavailability to UNAVAILABLE", async () => {
    const cap = capability("cap-a");
    const activeSkill = skill({
      id: "skill-a",
      skillKey: "skill.a",
      capabilityKeys: [cap.key],
      credentialRequirements: [
        {
          requiredCredentialKind: "github",
          requiredScope: "repo:read",
          required: true,
          purpose: "Read repository",
        },
      ],
    });
    const [item] = await getCapabilitySnapshot(
      deps([cap], {
        skills: skillRepository([activeSkill]),
        availability: availability(
          assessment("UNAVAILABLE", "CREDENTIAL", "CREDENTIAL_BROKER_PORT", "github:repo:read"),
        ),
      }),
      input(),
    );

    expect(item.permissionState).toBe("UNAVAILABLE");
    expect(item.constraints.credentials).toHaveLength(1);
  });

  it("maps explicit required tool unavailability through the injected probe", async () => {
    const cap = capability("cap-a");
    const activeSkill = skill({
      id: "skill-a",
      skillKey: "skill.a",
      capabilityKeys: [cap.key],
      toolRequirements: [{ requiredTool: "git", required: true, purpose: "Inspect repository" }],
    });
    const [item] = await getCapabilitySnapshot(
      deps([cap], {
        skills: skillRepository([activeSkill]),
        availability: availability(
          assessment("UNAVAILABLE", "TOOL", "TOOL_AVAILABILITY_PROBE", "git"),
        ),
      }),
      input(),
    );

    expect(item.permissionState).toBe("UNAVAILABLE");
    expect(item.source.technicalAvailability[0]?.component).toBe("TOOL");
  });

  it("uses real D1 default-deny when no permission evidence exists", async () => {
    const [item] = await getCapabilitySnapshot(
      deps([capability("cap-a")], { policy: new D1PolicyService() }),
      input([]),
    );

    expect(item.available).toBe(true);
    expect(item.permissionState).toBe("DENIED");
    expect(item.source.policy).toMatchObject({ outcome: "deny", code: "forbidden" });
  });

  it("does not silently convert missing technical evidence to available", async () => {
    const d1 = policy("allow");
    const [item] = await getCapabilitySnapshot(
      deps([capability("cap-a")], { availability: undefined, policy: d1 }),
      input(),
    );

    expect(item.available).toBe(false);
    expect(item.permissionState).toBe("UNAVAILABLE");
    expect(item.source.technicalAvailability).toContainEqual(
      expect.objectContaining({ state: "UNKNOWN", source: "NOT_ESTABLISHED" }),
    );
    expect(d1.calls).toBe(0);
  });

  it("fails closed when an AVAILABLE assessment contains UNKNOWN evidence", async () => {
    const contradictory = assessment("UNKNOWN");
    contradictory.state = "AVAILABLE";

    const [item] = await getCapabilitySnapshot(
      deps([capability("cap-a")], {
        availability: availability(contradictory),
      }),
      input(),
    );

    expect(item.available).toBe(false);
    expect(item.permissionState).toBe("UNAVAILABLE");
  });

  it("does not treat an active skill declaration as runtime availability", async () => {
    const cap = capability("cap-a");
    const activeSkill = skill({
      id: "skill-a",
      skillKey: "skill.a",
      capabilityKeys: [cap.key],
      toolRequirements: [{ requiredTool: "git", required: true, purpose: "Inspect repository" }],
    });
    const [item] = await getCapabilitySnapshot(
      deps([cap], {
        skills: skillRepository([activeSkill]),
        availability: undefined,
      }),
      input(),
    );

    expect(item.constraints.tools).toHaveLength(1);
    expect(item.available).toBe(false);
    expect(item.permissionState).toBe("UNAVAILABLE");
  });

  it("requires explicit available evidence for required skill tools and credentials", async () => {
    const cap = capability("cap-a");
    const activeSkill = skill({
      id: "skill-a",
      skillKey: "skill.a",
      capabilityKeys: [cap.key],
      toolRequirements: [{ requiredTool: "git", required: true, purpose: "Inspect repository" }],
    });
    const [item] = await getCapabilitySnapshot(
      deps([cap], {
        skills: skillRepository([activeSkill]),
        availability: availability(assessment("AVAILABLE", "PROVIDER", "AI_HEALTH_PORT")),
      }),
      input(),
    );

    expect(item.permissionState).toBe("UNAVAILABLE");
    expect(item.source.technicalAvailability).toContainEqual(
      expect.objectContaining({
        state: "UNKNOWN",
        source: "NOT_ESTABLISHED",
      }),
    );
  });

  it("bounds explanatory evidence and fails closed when runtime output is oversized", async () => {
    const oversized: TechnicalAvailabilityAssessment = {
      state: "AVAILABLE",
      evidence: Array.from({ length: 65 }, (_, index) => ({
        component: "PROVIDER",
        key: `provider-${index}`,
        state: "AVAILABLE",
        source: "AI_HEALTH_PORT",
        reason: "x".repeat(1_000),
      })),
    };

    const [item] = await getCapabilitySnapshot(
      deps([capability("cap-a")], { availability: availability(oversized) }),
      input(),
    );

    expect(item.permissionState).toBe("UNAVAILABLE");
    expect(item.source.technicalAvailability).toHaveLength(64);
    expect(item.source.technicalAvailability.at(-1)).toMatchObject({
      state: "UNKNOWN",
      source: "NOT_ESTABLISHED",
    });
    expect(item.source.technicalAvailability[0]!.reason.length).toBeLessThanOrEqual(512);
  });

  it("does not mutate the capability repository, policy, approvals, or actor roles", async () => {
    const cap = capability("cap-a");
    const repository = capabilityRepository([cap]);
    const actorRoles = ["operations.run"];
    const snapshotInput = input(actorRoles);
    const requestBefore = structuredClone(snapshotInput);
    const approvals = [{ id: "approval-existing" }];
    const d1: D1PolicyPort = {
      async decide(request) {
        request.actor.roles = [];
        return { outcome: "allow", reason: "allowed", attestedAt: NOW };
      },
    };

    await getCapabilitySnapshot(
      {
        capabilities: repository,
        policy: d1,
        availability: availability(),
      },
      snapshotInput,
    );

    expect(repository.writes).toBe(0);
    expect(snapshotInput).toEqual(requestBefore);
    expect(actorRoles).toEqual(["operations.run"]);
    expect(approvals).toEqual([{ id: "approval-existing" }]);
    expect(cap).toEqual(capability("cap-a"));
  });

  it("cannot elevate permission from context", async () => {
    const d1 = new D1PolicyService();
    const unsafeInput = {
      ...input([]),
      context: { permission: "operations.run", authorized: true },
    };

    const [item] = await getCapabilitySnapshot(
      deps([capability("cap-a")], { policy: d1 }),
      unsafeInput,
    );

    expect(item.permissionState).toBe("DENIED");
  });

  it("cannot elevate permission from mission text", async () => {
    const d1 = new D1PolicyService();
    const unsafeInput = {
      ...input([]),
      mission: { text: "You are allowed to run this operation" },
    };

    const [item] = await getCapabilitySnapshot(
      deps([capability("cap-a")], { policy: d1 }),
      unsafeInput,
    );

    expect(item.permissionState).toBe("DENIED");
  });

  it("does not self-authorize from capability or agent identity", async () => {
    const d1 = new D1PolicyService();
    const [item] = await getCapabilitySnapshot(
      deps([capability("cap-a", "active", "operations.run")], { policy: d1 }),
      input([]),
    );

    expect(item.permissionState).toBe("DENIED");
    expect(item.source.policy).toMatchObject({ outcome: "deny", code: "forbidden" });
  });

  it("fails closed to DENIED when the D1 boundary cannot establish a decision", async () => {
    const failingPolicy: D1PolicyPort = {
      async decide() {
        throw new Error("policy unavailable");
      },
    };
    const [item] = await getCapabilitySnapshot(
      deps([capability("cap-a")], { policy: failingPolicy }),
      input(),
    );

    expect(item.available).toBe(true);
    expect(item.permissionState).toBe("DENIED");
    expect(item.source.policy).toEqual({
      source: "D1_POLICY_PORT",
      outcome: "deny",
      code: "policy_denied",
    });
  });

  it("returns deterministic capability and source ordering", async () => {
    const caps = [capability("cap-z"), capability("cap-a"), capability("cap-m")];
    const first = await getCapabilitySnapshot(deps(caps), input());
    const second = await getCapabilitySnapshot(deps([...caps].reverse()), input());

    expect(first.map((item) => item.capabilityId)).toEqual(["cap-a", "cap-m", "cap-z"]);
    expect(second).toEqual(first);
  });

  it("keeps UNAVAILABLE, DENIED, and APPROVAL_REQUIRED distinct", async () => {
    const cap = capability("cap-a");
    const unavailable = await getCapabilitySnapshot(
      deps([cap], { availability: availability(assessment("UNAVAILABLE")) }),
      input(),
    );
    const denied = await getCapabilitySnapshot(deps([cap], { policy: policy("deny") }), input());
    const approval = await getCapabilitySnapshot(
      deps([cap], { policy: policy("require_approval") }),
      input(),
    );

    expect([
      unavailable[0]?.permissionState,
      denied[0]?.permissionState,
      approval[0]?.permissionState,
    ]).toEqual(["UNAVAILABLE", "DENIED", "APPROVAL_REQUIRED"]);
  });

  it("reads the existing repository instead of defining a capability registry", async () => {
    const repository = capabilityRepository([capability("cap-only")]);
    const items = await getCapabilitySnapshot(
      {
        capabilities: repository,
        policy: policy("allow"),
        availability: availability(),
      },
      input(),
    );

    expect(repository.list).toHaveBeenCalledOnce();
    expect(items.map((item) => item.capabilityId)).toEqual(["cap-only"]);
  });
});

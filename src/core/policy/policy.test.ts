import { describe, expect, it } from "vitest";

import { D1PolicyEngine } from "./engine";
import type { PolicyRequest } from "./contract";

function makeRequest(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    actor: {
      kind: "human",
      id: "user-1",
      tenantId: "default",
      roles: ["capabilities.read", "tasks.write"],
      authorizationLevel: 2,
      ...overrides.actor,
    },
    tenant: { tenantId: "default", ...overrides.tenant },
    action: "read",
    resource: {
      type: "capabilities",
      id: "cap-1",
      ...overrides.resource,
    },
    risk: "read_only",
    ...overrides,
  };
}

describe("D1PolicyEngine — TENANT gate", () => {
  it("TENANT-01: refuse si l'acteur n'a pas de tenant", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide(makeRequest({ actor: { kind: "human", id: "u1", tenantId: "" } }));
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.code).toBe("no_tenant");
    }
  });
});

describe("D1PolicyEngine — IDOR gate", () => {
  it("IDOR-01: refuse si acteur tenant ≠ session tenant", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide(
      makeRequest({
        actor: { kind: "human", id: "u1", tenantId: "tenant-a" },
        tenant: { tenantId: "tenant-b" },
      }),
    );
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.code).toBe("cross_tenant_idor");
    }
  });
});

describe("D1PolicyEngine — CLASSIFICATION gate", () => {
  it("CLASS-01: C0 sans niveau suffisant est refusé", () => {
    // La gate classification ne bloque pas C0 — accessible à tous.
    const engine = new D1PolicyEngine();
    const result = engine.decide(
      makeRequest({
        actor: { kind: "human", id: "u1", tenantId: "default", authorizationLevel: 0 },
        resource: { type: "capabilities", id: "cap-1", sensitivityLevel: "C2" },
      }),
    );
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.code).toBe("classification_too_high");
    }
  });

  it("CLASS-02: C3 sans niveau 3 est refusé", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide(
      makeRequest({
        actor: { kind: "human", id: "u1", tenantId: "default", authorizationLevel: 2 },
        resource: { type: "capabilities", id: "cap-1", sensitivityLevel: "C3" },
      }),
    );
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.code).toBe("classification_too_high");
    }
  });

  it("CLASS-03: C2 avec niveau 2 est accepté", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({
      actor: { kind: "human", id: "u1", tenantId: "default", roles: ["capabilities.read"], authorizationLevel: 2 },
      tenant: { tenantId: "default" },
      action: "read",
      resource: { type: "capabilities", id: "cap-1", sensitivityLevel: "C2" },
      risk: "read_only",
    });
    expect(result.outcome).toBe("allow");
  });
});

describe("D1PolicyEngine — PERMISSION gate", () => {
  it("PERM-01: permission manquante → deny", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide(
      makeRequest({
        actor: { kind: "human", id: "u1", tenantId: "default", roles: [] },
      }),
    );
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.code).toBe("forbidden");
    }
  });

  it("PERM-02: permission valide → allow", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide(
      makeRequest({
        actor: {
          kind: "human",
          id: "u1",
          tenantId: "default",
          roles: ["capabilities.read"],
          authorizationLevel: 0,
        },
        resource: { type: "capabilities", id: "cap-1" },
        action: "read",
      }),
    );
    expect(result.outcome).toBe("allow");
  });
});

describe("D1PolicyEngine — RETENTION gate", () => {
  it("RET-01: activation C3 sans retention → deny", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide(
      makeRequest({
        actor: { kind: "human", id: "u1", tenantId: "default", roles: ["capabilities.status.write"], authorizationLevel: 3 },
        action: "activate",
        resource: {
          type: "capabilities",
          id: "cap-1",
          sensitivityLevel: "C3",
          // pas de retentionPolicyRef
        },
      }),
    );
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.code).toBe("retention_policy_required");
    }
  });

  it("RET-02: activation C3 avec retention → allow", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({
      actor: { kind: "human", id: "u1", tenantId: "default", roles: ["capabilities.status.write"], authorizationLevel: 3 },
      tenant: { tenantId: "default" },
      action: "status.write",
      resource: {
        type: "capabilities",
        id: "cap-1",
        sensitivityLevel: "C3",
        retentionPolicyRef: { maxRetentionDays: 90, legalBasis: "consent", purpose: "Test" },
      },
      risk: "read_only",
    });
    expect(result.outcome).toBe("allow");
  });
});

describe("D1PolicyEngine — RISK gate", () => {
  it("RISK-01: action sensible sans niveau suffisant → require_approval", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({
      actor: { kind: "human", id: "u1", tenantId: "default", roles: ["tasks.write"], authorizationLevel: 1 },
      tenant: { tenantId: "default" },
      action: "write",
      resource: { type: "tasks", id: "task-1" },
      risk: "sensitive",
    });
    expect(result.outcome).toBe("require_approval");
  });
});

describe("D1PolicyEngine — EXTERNAL EFFECT gate", () => {
  it("EXT-01: mutation externe → require_approval", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide(
      makeRequest({
        hasExternalEffect: true,
        risk: "reversible",
      }),
    );
    expect(result.outcome).toBe("require_approval");
  });
});

describe("D1PolicyEngine — ALLOW path", () => {
  it("ALLOW-01: toutes les gates passent → allow", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide(
      makeRequest({
        actor: {
          kind: "human",
          id: "user-1",
          tenantId: "default",
          roles: ["capabilities.read"],
          authorizationLevel: 1,
        },
        resource: { type: "capabilities", id: "cap-1", sensitivityLevel: "C1" },
        action: "read",
        risk: "read_only",
      }),
    );
    expect(result.outcome).toBe("allow");
  });
});

describe("D1PolicyEngine — FAIL CLOSED", () => {
  it("FAIL-01: requête invalide → deny (pas d'exception)", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({} as PolicyRequest);
    expect(result.outcome).toBe("deny");
  });
});

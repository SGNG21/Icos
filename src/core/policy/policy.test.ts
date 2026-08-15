import { describe, expect, it } from "vitest";

import { D1PolicyEngine } from "./engine";
import type { PolicyRequest } from "./contract";
import { PERMISSION_SUPERVISOR_WORKER_EXECUTE } from "./system-agent";

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
      actor: {
        kind: "human",
        id: "u1",
        tenantId: "default",
        roles: ["capabilities.read"],
        authorizationLevel: 2,
      },
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

  it("PERM-03: worker-execution permission avec roles corrects → allow", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({
      actor: {
        kind: "agent",
        id: "supervisor",
        tenantId: "icos-single-tenant",
        roles: ["worker-execution.supervisor.worker.execute"],
        authorizationLevel: 2,
      },
      tenant: { tenantId: "icos-single-tenant" },
      action: "supervisor.worker.execute",
      resource: {
        type: "worker-execution",
        id: "worker-auto-abc123",
        ownerTenantId: "icos-single-tenant",
      },
      risk: "reversible",
    });
    expect(result.outcome).toBe("allow");
  });

  it("PERM-04: worker-execution sans roles → deny", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({
      actor: {
        kind: "agent",
        id: "supervisor",
        tenantId: "icos-single-tenant",
        // pas de roles
        authorizationLevel: 2,
      },
      tenant: { tenantId: "icos-single-tenant" },
      action: "supervisor.worker.execute",
      resource: {
        type: "worker-execution",
        id: "worker-auto-abc123",
        ownerTenantId: "icos-single-tenant",
      },
      risk: "reversible",
    });
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.code).toBe("forbidden");
    }
  });

  it("PERM-05: worker-execution avec mauvais role → deny", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({
      actor: {
        kind: "agent",
        id: "supervisor",
        tenantId: "icos-single-tenant",
        roles: ["capabilities.read"], // wrong — ne correspond pas à worker-execution.supervisor.worker.execute
        authorizationLevel: 2,
      },
      tenant: { tenantId: "icos-single-tenant" },
      action: "supervisor.worker.execute",
      resource: {
        type: "worker-execution",
        id: "worker-auto-abc123",
        ownerTenantId: "icos-single-tenant",
      },
      risk: "reversible",
    });
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.code).toBe("forbidden");
    }
  });

  it("PERM-06: worker-execution pour autre tenant → deny (IDOR gate)", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({
      actor: {
        kind: "agent",
        id: "supervisor",
        tenantId: "tenant-a",
        roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
        authorizationLevel: 2,
      },
      tenant: { tenantId: "tenant-b" }, // Mismatch
      action: "supervisor.worker.execute",
      resource: {
        type: "worker-execution",
        id: "worker-auto-abc123",
        ownerTenantId: "tenant-b",
      },
      risk: "reversible",
    });
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      // La première gate à échouer est TENANT ou IDOR, pas PERMISSION
      expect(["no_tenant", "cross_tenant_idor"]).toContain(result.code);
    }
  });
});

describe("D1PolicyEngine — SYSTEM AGENT AUTHORIZATION", () => {
  // Use SystemAgent-level kind and canonical permission constants.

  it("AUTH-01: SystemAgent with canonical permission → allow", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({
      actor: {
        kind: "system",
        id: "supervisor",
        tenantId: "icos-single-tenant",
        roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
        authorizationLevel: 2,
      },
      tenant: { tenantId: "icos-single-tenant" },
      action: "supervisor.worker.execute",
      resource: {
        type: "worker-execution",
        id: "worker-auto-abc123",
        ownerTenantId: "icos-single-tenant",
      },
      risk: "reversible",
    });
    expect(result.outcome).toBe("allow");
  });

  it("AUTH-02: SystemAgent without roles → deny (default-deny)", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({
      actor: {
        kind: "system",
        id: "supervisor",
        tenantId: "icos-single-tenant",
        // No roles → default deny
      },
      tenant: { tenantId: "icos-single-tenant" },
      action: "supervisor.worker.execute",
      resource: {
        type: "worker-execution",
        id: "worker-auto-abc123",
        ownerTenantId: "icos-single-tenant",
      },
      risk: "reversible",
    });
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.code).toBe("forbidden");
    }
  });

  it("AUTH-03: SystemAgent with wrong action → deny", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({
      actor: {
        kind: "system",
        id: "supervisor",
        tenantId: "icos-single-tenant",
        roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
        authorizationLevel: 2,
      },
      tenant: { tenantId: "icos-single-tenant" },
      // Wrong action — PERMISSION_SUPERVISOR_WORKER_EXECUTE does not cover "read"
      action: "read",
      resource: {
        type: "worker-execution",
        id: "worker-auto-abc123",
        ownerTenantId: "icos-single-tenant",
      },
      risk: "read_only",
    });
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.code).toBe("forbidden");
    }
  });

  it("AUTH-04: SystemAgent with wrong tenant → deny", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({
      actor: {
        kind: "system",
        id: "supervisor",
        tenantId: "tenant-a",
        roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
        authorizationLevel: 2,
      },
      tenant: { tenantId: "tenant-b" },
      action: "supervisor.worker.execute",
      resource: {
        type: "worker-execution",
        id: "worker-auto-abc123",
        ownerTenantId: "tenant-b",
      },
      risk: "reversible",
    });
    expect(result.outcome).toBe("deny");
  });

  it("AUTH-05: SystemAgent without authorizationLevel for reversible → deny (RiskGate defaults to 0)", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide({
      actor: {
        kind: "system",
        id: "supervisor",
        tenantId: "icos-single-tenant",
        roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
        // authorizationLevel missing → RiskGate defaults to 0
      },
      tenant: { tenantId: "icos-single-tenant" },
      action: "supervisor.worker.execute",
      resource: {
        type: "worker-execution",
        id: "worker-auto-abc123",
        ownerTenantId: "icos-single-tenant",
      },
      risk: "reversible",
    });
    // RiskGate: actorLevel (0) < 2 ⇒ deny with insufficient_authorization
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.code).toBe("insufficient_authorization");
    }
  });

  it("AUTH-06: kind:system is distinct from kind:agent", () => {
    // Verify that both kinds are valid and distinguishable.
    // Governance: SystemAgent (kind: "system") is separate from AI agents (kind: "agent").
    const engine = new D1PolicyEngine();
    const sysResult = engine.decide({
      actor: {
        kind: "system",
        id: "sys-1",
        tenantId: "default",
        roles: ["capabilities.read"],
        authorizationLevel: 0,
      },
      tenant: { tenantId: "default" },
      action: "read",
      resource: { type: "capabilities", id: "cap-1" },
      risk: "read_only",
    });
    expect(sysResult.outcome).toBe("allow");
  });
});

describe("D1PolicyEngine — RETENTION gate", () => {
  it("RET-01: activation C3 sans retention → deny", () => {
    const engine = new D1PolicyEngine();
    const result = engine.decide(
      makeRequest({
        actor: {
          kind: "human",
          id: "u1",
          tenantId: "default",
          roles: ["capabilities.status.write"],
          authorizationLevel: 3,
        },
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
      actor: {
        kind: "human",
        id: "u1",
        tenantId: "default",
        roles: ["capabilities.status.write"],
        authorizationLevel: 3,
      },
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
      actor: {
        kind: "human",
        id: "u1",
        tenantId: "default",
        roles: ["tasks.write"],
        authorizationLevel: 1,
      },
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

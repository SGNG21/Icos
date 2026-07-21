import { describe, expect, it } from "vitest";

import { demoAgents } from "@/features/agents/data";
import { demoTasks } from "@/features/tasks/data";

import {
  agentActionSchema,
  agentSchema,
  approvalSchema,
  auditEntrySchema,
  idSchema,
  isoDateTimeSchema,
  taskSchema,
} from "./index";

const validAction = {
  id: "action-001",
  initiatedByAgentId: "agent-cto",
  kind: "repository.read",
  risk: "read_only",
  requiresHumanApproval: false,
  approvalStatus: "not_required",
  requestedAt: "2026-07-21T08:00:00.000Z",
};

const validApproval = {
  id: "approval-001",
  actionId: "action-001",
  decidedBy: "geoffrey",
  decision: "approved",
  decidedAt: "2026-07-21T09:00:00.000Z",
};

const validAuditEntry = {
  id: "audit-001",
  occurredAt: "2026-07-21T09:00:00.000Z",
  eventType: "approval.recorded",
  actor: { kind: "human", id: "geoffrey" },
  actionId: "action-001",
  details: { decision: "approved" },
};

describe("identifiants", () => {
  it("accepte un identifiant conforme", () => {
    expect(idSchema.safeParse("agent-cto").success).toBe(true);
  });

  it("rejette les identifiants trop courts, vides ou mal formés", () => {
    expect(idSchema.safeParse("").success).toBe(false);
    expect(idSchema.safeParse("ab").success).toBe(false);
    expect(idSchema.safeParse("Agent CTO").success).toBe(false);
    expect(idSchema.safeParse("-invalide").success).toBe(false);
  });
});

describe("horodatages", () => {
  it("accepte un datetime ISO avec zone", () => {
    expect(isoDateTimeSchema.safeParse("2026-07-21T08:00:00.000Z").success).toBe(true);
    expect(isoDateTimeSchema.safeParse("2026-07-21T08:00:00+02:00").success).toBe(true);
  });

  it("rejette une chaîne générique ou une date seule", () => {
    expect(isoDateTimeSchema.safeParse("hier").success).toBe(false);
    expect(isoDateTimeSchema.safeParse("2026-07-21").success).toBe(false);
  });
});

describe("agentSchema", () => {
  it("valide toutes les données de démonstration", () => {
    for (const agent of demoAgents) {
      expect(agentSchema.safeParse(agent).success).toBe(true);
    }
  });

  it("rejette un niveau d'autorisation hors plage", () => {
    expect(agentSchema.safeParse({ ...demoAgents[0], authorizationLevel: 4 }).success).toBe(false);
  });
});

describe("taskSchema", () => {
  it("valide toutes les données de démonstration", () => {
    for (const task of demoTasks) {
      expect(taskSchema.safeParse(task).success).toBe(true);
    }
  });

  it("rejette un statut inconnu", () => {
    expect(taskSchema.safeParse({ ...demoTasks[0], status: "paused" }).success).toBe(false);
  });
});

describe("agentActionSchema", () => {
  it("accepte une action valide", () => {
    expect(agentActionSchema.safeParse(validAction).success).toBe(true);
  });

  it("rejette un risque inconnu et un horodatage invalide", () => {
    expect(agentActionSchema.safeParse({ ...validAction, risk: "extreme" }).success).toBe(false);
    expect(agentActionSchema.safeParse({ ...validAction, requestedAt: "demain" }).success).toBe(
      false,
    );
  });
});

describe("approvalSchema", () => {
  it("accepte une décision humaine valide", () => {
    expect(approvalSchema.safeParse(validApproval).success).toBe(true);
  });

  it("rejette une décision hors approved/rejected", () => {
    expect(approvalSchema.safeParse({ ...validApproval, decision: "maybe" }).success).toBe(false);
  });
});

describe("auditEntrySchema", () => {
  it("accepte une entrée valide", () => {
    expect(auditEntrySchema.safeParse(validAuditEntry).success).toBe(true);
  });

  it("rejette des details non sérialisables (fonction)", () => {
    const invalid = { ...validAuditEntry, details: { callback: () => "secret" } };
    expect(auditEntrySchema.safeParse(invalid).success).toBe(false);
  });

  it("accepte un nombre fini dans details", () => {
    const valid = { ...validAuditEntry, details: { count: 3 } };
    expect(auditEntrySchema.safeParse(valid).success).toBe(true);
  });

  it("rejette NaN, Infinity et -Infinity dans details", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const invalid = { ...validAuditEntry, details: { value } };
      expect(auditEntrySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejette un type d'événement inconnu", () => {
    expect(auditEntrySchema.safeParse({ ...validAuditEntry, eventType: "boot" }).success).toBe(
      false,
    );
  });
});

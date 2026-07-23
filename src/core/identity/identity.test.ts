import { describe, expect, it } from "vitest";

import {
  hasPermission,
  highestRole,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  wouldLeaveNoActiveOwner,
  type Role,
} from "./index";

describe("hiérarchie des rôles", () => {
  it("détermine le rôle le plus élevé", () => {
    expect(highestRole(["viewer", "admin", "operator"])).toBe("admin");
    expect(highestRole([])).toBeNull();
  });

  it("owner ⊇ admin ⊇ operator ⊇ viewer (inclusion des permissions)", () => {
    const order: Role[] = ["viewer", "operator", "admin", "owner"];
    for (let i = 1; i < order.length; i += 1) {
      const lower = ROLE_PERMISSIONS[order[i - 1]];
      const higher = ROLE_PERMISSIONS[order[i]];
      for (const permission of lower) {
        expect(higher.has(permission)).toBe(true);
      }
      expect(higher.size).toBeGreaterThanOrEqual(lower.size);
    }
  });
});

describe("matrice de permissions", () => {
  it("lecture cockpit : tous les rôles", () => {
    for (const role of ["viewer", "operator", "admin", "owner"] as Role[]) {
      expect(hasPermission([role], "cockpit.read")).toBe(true);
    }
  });

  it("tâches / approbations / audit complet : operator+", () => {
    expect(hasPermission(["viewer"], "tasks.write")).toBe(false);
    expect(hasPermission(["operator"], "tasks.write")).toBe(true);
    expect(hasPermission(["viewer"], "approvals.decide")).toBe(false);
    expect(hasPermission(["operator"], "approvals.decide")).toBe(true);
    expect(hasPermission(["viewer"], "audit.read.full")).toBe(false);
    expect(hasPermission(["operator"], "audit.read.full")).toBe(true);
    expect(hasPermission(["viewer"], "audit.read.limited")).toBe(true);
  });

  it("agents / config / administration humaine / intégrations : admin+", () => {
    for (const permission of [
      "agents.manage",
      "config.manage",
      "users.read",
      "users.create",
      "users.role.write",
      "users.status.write",
      "agentLinks.read",
      "agentLinks.write",
      "integrations.manage",
    ] as const) {
      expect(hasPermission(["operator"], permission)).toBe(false);
      expect(hasPermission(["admin"], permission)).toBe(true);
      expect(hasPermission(["owner"], permission)).toBe(true);
    }
  });

  it("retire les permissions administratives historiques", () => {
    expect(PERMISSIONS).not.toContain("users.manage");
    expect(PERMISSIONS).not.toContain("owners.manage");
  });
});

describe("dernier owner (prédicat pur)", () => {
  it("détecte le retrait du dernier owner actif", () => {
    expect(wouldLeaveNoActiveOwner({ activeOwnerUserIds: ["u1"], targetUserId: "u1" })).toBe(true);
    expect(wouldLeaveNoActiveOwner({ activeOwnerUserIds: ["u1", "u2"], targetUserId: "u1" })).toBe(
      false,
    );
    expect(wouldLeaveNoActiveOwner({ activeOwnerUserIds: ["u1"], targetUserId: "u2" })).toBe(false);
  });
});

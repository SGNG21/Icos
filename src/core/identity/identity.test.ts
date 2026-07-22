import { describe, expect, it } from "vitest";

import {
  canManageRoleChange,
  hasPermission,
  highestRole,
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
      expect(higher.size).toBeGreaterThan(lower.size);
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

  it("agents / config / gestion utilisateurs / intégrations : admin+", () => {
    for (const p of [
      "agents.manage",
      "config.manage",
      "users.manage",
      "integrations.manage",
    ] as const) {
      expect(hasPermission(["operator"], p)).toBe(false);
      expect(hasPermission(["admin"], p)).toBe(true);
    }
  });

  it("gestion des owners : owner uniquement", () => {
    expect(hasPermission(["admin"], "owners.manage")).toBe(false);
    expect(hasPermission(["owner"], "owners.manage")).toBe(true);
  });
});

describe("gestion des rôles (autorisation)", () => {
  it("un admin ne peut pas promouvoir en owner", () => {
    expect(canManageRoleChange(["admin"], { kind: "grant", role: "owner" }, { roles: [] })).toEqual(
      { ok: false, reason: "forbidden" },
    );
  });

  it("un admin ne peut pas modifier un utilisateur owner", () => {
    expect(
      canManageRoleChange(["admin"], { kind: "grant", role: "operator" }, { roles: ["owner"] }),
    ).toEqual({ ok: false, reason: "forbidden" });
  });

  it("un admin peut gérer les rôles non-owner d'un non-owner", () => {
    expect(
      canManageRoleChange(["admin"], { kind: "grant", role: "operator" }, { roles: ["viewer"] }),
    ).toEqual({ ok: true });
  });

  it("un owner peut promouvoir en owner", () => {
    expect(canManageRoleChange(["owner"], { kind: "grant", role: "owner" }, { roles: [] })).toEqual(
      { ok: true },
    );
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

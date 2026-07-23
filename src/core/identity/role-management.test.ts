import { describe, expect, it } from "vitest";

import { canAdministerTarget, canCreateRole, type Role } from "./index";

describe("canCreateRole", () => {
  it.each(["operator", "viewer"] as const)("autorise un admin à créer un %s", (requestedRole) => {
    expect(canCreateRole(["admin"], requestedRole)).toEqual({ ok: true });
  });

  it.each(["admin", "owner"] as const)("refuse à un admin de créer un %s", (requestedRole) => {
    expect(canCreateRole(["admin"], requestedRole)).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it.each(["owner", "admin", "operator", "viewer"] as const)(
    "autorise un owner à créer un %s",
    (requestedRole) => {
      expect(canCreateRole(["owner"], requestedRole)).toEqual({ ok: true });
    },
  );

  it("refuse un acteur sans rôle effectif", () => {
    expect(canCreateRole([], "viewer")).toEqual({ ok: false, reason: "forbidden" });
  });
});

describe("canAdministerTarget", () => {
  const decide = (
    actorRoles: readonly Role[],
    targetRoles: readonly Role[],
    targetUserId = "target",
  ) =>
    canAdministerTarget({
      actorUserId: "actor",
      actorRoles,
      targetUserId,
      targetRoles,
    });

  it.each(["operator", "viewer"] as const)(
    "autorise un admin à administrer un %s",
    (targetRole) => {
      expect(decide(["admin"], [targetRole])).toEqual({ ok: true });
    },
  );

  it.each(["admin", "owner"] as const)("refuse à un admin d'administrer un %s", (targetRole) => {
    expect(decide(["admin"], [targetRole])).toEqual({ ok: false, reason: "forbidden" });
  });

  it.each(["owner", "admin", "operator", "viewer"] as const)(
    "autorise un owner à administrer une autre cible %s",
    (targetRole) => {
      expect(decide(["owner"], [targetRole])).toEqual({ ok: true });
    },
  );

  it("refuse toute auto-administration", () => {
    expect(decide(["owner"], ["owner"], "actor")).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("refuse un acteur ou une cible sans rôle effectif", () => {
    expect(decide([], ["viewer"])).toEqual({ ok: false, reason: "forbidden" });
    expect(decide(["owner"], [])).toEqual({ ok: false, reason: "forbidden" });
  });
});

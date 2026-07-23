import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Permission, Role } from "@/core/identity";

import { AuthorizationService } from "./authorization-service";
import { requirePermission, requireRole, requireSession } from "./guards";
import type { AuthGateway } from "./ports";

const activeUser = {
  id: "human-1",
  email: "human@icos.test",
  status: "active" as const,
};

function session(roles: Role[], status: "active" | "disabled" = "active"): AuthenticatedSession {
  return { user: { ...activeUser, status }, roles };
}

function gateway(readSession: AuthGateway["readSession"]): AuthGateway {
  return {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => null,
    readHumanUserByEmail: async () => null,
    deleteHumanUser: async () => undefined,
    readSession,
    revokeSession: async () => undefined,
    revokeUserSessions: async () => undefined,
  };
}

function credentialHeaders(): Headers {
  return new Headers({ cookie: "icos.session_token=opaque-test-value" });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("requireSession", () => {
  it("échoue explicitement quand l'auth n'est pas composée", async () => {
    await expectCode(requireSession({}, credentialHeaders()), "unauthenticated");
  });

  it("refuse une requête sans credential avant toute lecture de session", async () => {
    const readSession = vi.fn(async () => session(["viewer"]));

    await expectCode(
      requireSession({ auth: gateway(readSession) }, new Headers()),
      "unauthenticated",
    );
    expect(readSession).not.toHaveBeenCalled();
  });

  it("classe comme expiré un credential sans session autoritaire", async () => {
    const readSession = vi.fn(async () => null);

    await expectCode(
      requireSession({ auth: gateway(readSession) }, credentialHeaders()),
      "session_expired",
    );
    expect(readSession).toHaveBeenCalledOnce();
  });

  it("refuse un compte désactivé et conserve le refus si la révocation échoue", async () => {
    const readSession = vi.fn(async () => session(["owner"], "disabled"));
    const auth = gateway(readSession);
    auth.revokeUserSessions = vi.fn(async () => {
      throw new Error("revocation unavailable");
    });

    await expectCode(requireSession({ auth }, credentialHeaders()), "account_disabled");
  });

  it("retourne une session active validée autoritairement", async () => {
    const expected = session(["viewer"]);

    await expect(
      requireSession({ auth: gateway(async () => expected) }, credentialHeaders()),
    ).resolves.toEqual(expected);
  });
});

describe("requireRole", () => {
  it.each([
    ["viewer", "viewer", true],
    ["operator", "viewer", true],
    ["operator", "operator", true],
    ["admin", "operator", true],
    ["admin", "admin", true],
    ["owner", "admin", true],
    ["owner", "owner", true],
    ["viewer", "operator", false],
    ["operator", "admin", false],
    ["admin", "owner", false],
  ] as const)("rôle %s requis comme %s: %s", async (granted, required, allowed) => {
    const result = requireRole(
      { auth: gateway(async () => session([granted])) },
      credentialHeaders(),
      required,
    );

    if (allowed) {
      await expect(result).resolves.toMatchObject({ roles: [granted] });
    } else {
      await expectCode(result, "forbidden");
    }
  });
});

describe("requirePermission", () => {
  it.each([
    ["viewer", "cockpit.read", true],
    ["viewer", "tasks.write", false],
    ["operator", "tasks.write", true],
    ["operator", "agents.manage", false],
    ["admin", "agents.manage", true],
  ] as const)("rôle %s et permission %s: %s", async (role, permission, allowed) => {
    const result = requirePermission(
      { auth: gateway(async () => session([role])) },
      credentialHeaders(),
      permission as Permission,
    );

    if (allowed) {
      await expect(result).resolves.toMatchObject({ roles: [role] });
    } else {
      await expectCode(result, "forbidden");
    }
  });
});

describe("AuthorizationService.hasRole", () => {
  it("applique la hiérarchie sans dupliquer les rôles", () => {
    const authorization = new AuthorizationService();

    expect(authorization.hasRole(session(["owner"]), "viewer")).toBe(true);
    expect(authorization.hasRole(session(["operator"]), "admin")).toBe(false);
  });
});

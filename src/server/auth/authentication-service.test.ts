import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/server/database/client";

import { AuthenticationService } from "./authentication-service";
import { createBetterAuth, type IcosBetterAuth } from "./better-auth";
import { AuthGuardError } from "./errors";
import type { HumanUserRepository, RoleRepository } from "./ports";

const users: HumanUserRepository = {
  findById: async () => null,
  findByEmail: async () => null,
};

function authReturning(user: Record<string, unknown>): IcosBetterAuth {
  return {
    api: {
      getSession: async () => ({ user }),
    },
  } as unknown as IcosBetterAuth;
}

function rolesWith(listRoles = vi.fn(async () => ["viewer"] as "viewer"[])): RoleRepository {
  return {
    listRoles,
    grantRole: async () => undefined,
    listActiveOwnerIds: async () => [],
    revokeRole: async () => ({ ok: false, reason: "not_found" }),
    setUserStatus: async () => ({ ok: false, reason: "not_found" }),
  };
}

const unusedDatabase = {} as Database;

describe("AuthGuardError", () => {
  it("conserve un code de refus stable", () => {
    const error = new AuthGuardError("session_expired");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("session_expired");
  });
});

describe("AuthenticationService.createHumanUser", () => {
  it("désactive l'inscription email publique tout en conservant une création interne sans session", async () => {
    const createUser = vi.fn(async () => ({ id: "human-1" }));
    const linkAccount = vi.fn(async () => ({}));
    const hash = vi.fn(async () => "stored-password-hash");
    const publicSignUp = vi.fn();
    const context = {
      internalAdapter: { createUser, linkAccount },
      password: { hash },
      newSession: null,
    };
    const service = new AuthenticationService(
      {
        api: { signUpEmail: publicSignUp },
        options: { emailAndPassword: { disableSignUp: true } },
        $context: Promise.resolve(context),
      } as unknown as IcosBetterAuth,
      users,
      rolesWith(),
      unusedDatabase,
    );

    expect(createBetterAuth.toString()).toContain("disableSignUp: true");
    await expect(
      service.createHumanUser({
        email: "human@icos.test",
        password: "correct horse battery staple",
        name: "Human",
      }),
    ).resolves.toEqual({ ok: true, userId: "human-1" });
    expect(publicSignUp).not.toHaveBeenCalled();
    expect(createUser).toHaveBeenCalledWith({
      email: "human@icos.test",
      name: "Human",
      emailVerified: false,
      status: "active",
    });
    expect(hash).toHaveBeenCalledWith("correct horse battery staple");
    expect(linkAccount).toHaveBeenCalledWith({
      userId: "human-1",
      accountId: "human-1",
      providerId: "credential",
      password: "stored-password-hash",
    });
    expect(context.newSession).toBeNull();
  });

  it("retourne un résultat contrôlé même si la compensation échoue", async () => {
    const createUser = vi.fn(async () => ({ id: "human-partial" }));
    const linkAccount = vi.fn(async () => {
      throw new Error("link failed");
    });
    const deleteHumanUser = vi.fn(async () => {
      throw new Error("delete failed");
    });
    const service = new AuthenticationService(
      {
        $context: Promise.resolve({
          internalAdapter: { createUser, linkAccount },
          password: { hash: vi.fn(async () => "stored-password-hash") },
        }),
      } as unknown as IcosBetterAuth,
      users,
      rolesWith(),
      {
        delete: vi.fn(() => ({ where: deleteHumanUser })),
      } as unknown as Database,
    );

    await expect(
      service.createHumanUser({
        email: "partial@icos.test",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_input" });
    expect(deleteHumanUser).toHaveBeenCalledOnce();
  });
});

describe("AuthenticationService.readSession", () => {
  it("distingue un utilisateur absent d'une session inexistante", async () => {
    const listRoles = vi.fn(async () => ["viewer"] as "viewer"[]);
    const service = new AuthenticationService(
      {
        api: {
          getSession: async () => ({ session: { userId: "human-1" } }),
        },
      } as unknown as IcosBetterAuth,
      users,
      rolesWith(listRoles),
      unusedDatabase,
    );

    await expect(service.readSession(new Headers())).rejects.toMatchObject({
      code: "account_disabled",
      userId: "human-1",
    });
    expect(listRoles).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", undefined],
    ["nul", null],
    ["inconnu", "locked"],
  ])("refuse en mode fail-closed un statut %s", async (_label, status) => {
    const listRoles = vi.fn(async () => ["viewer"] as "viewer"[]);
    const service = new AuthenticationService(
      authReturning({
        id: "human-1",
        email: "human@icos.test",
        name: "Human",
        ...(status === undefined ? {} : { status }),
      }),
      users,
      rolesWith(listRoles),
      unusedDatabase,
    );

    await expect(service.readSession(new Headers())).rejects.toMatchObject({
      code: "account_disabled",
      userId: "human-1",
    });
    expect(listRoles).not.toHaveBeenCalled();
  });

  it("projette une session dont le statut est explicitement actif", async () => {
    const service = new AuthenticationService(
      authReturning({
        id: "human-1",
        email: "human@icos.test",
        name: null,
        status: "active",
      }),
      users,
      rolesWith(),
      unusedDatabase,
    );

    await expect(service.readSession(new Headers())).resolves.toEqual({
      user: {
        id: "human-1",
        email: "human@icos.test",
        name: undefined,
        status: "active",
      },
      roles: ["viewer"],
    });
  });
});

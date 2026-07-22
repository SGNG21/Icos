import { APIError } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, HumanUser } from "@/core/identity";
import { AuthGuardError } from "@/server/auth/errors";
import type { AuthGateway, AuthHttpGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";
import type { AuditRepository } from "@/server/repositories/ports";

import { GET, POST } from "./route";

const CONTAINER_KEY = "__icosContainerPromise__";
const activeUser: HumanUser = {
  id: "human-1",
  email: "human@icos.test",
  name: "Human",
  status: "active",
};
const activeSession: AuthenticatedSession = {
  user: activeUser,
  roles: ["viewer"],
};

type RouteContext = {
  params: Promise<{ all: string[] }>;
};

function context(...all: string[]): RouteContext {
  return { params: Promise.resolve({ all }) };
}

function request(
  path: string,
  body: unknown = {
    email: "human@icos.test",
    password: "correct horse battery staple",
  },
  headers: HeadersInit = {},
): Request {
  return new Request(`https://icos.test/api/auth/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://icos.test",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function authGateway(overrides: Partial<AuthGateway> = {}): AuthGateway {
  return {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: vi.fn(async () => activeUser),
    readHumanUserByEmail: async () => activeUser,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => activeSession),
    revokeSession: async () => {},
    revokeUserSessions: vi.fn(async () => {}),
    ...overrides,
  };
}

function authHttpGateway(overrides: Partial<AuthHttpGateway> = {}): AuthHttpGateway {
  return {
    signIn: vi.fn(async () => ({
      headers: new Headers({
        "set-cookie": "icos.session_token=opaque; HttpOnly; SameSite=Lax",
      }),
      userId: activeUser.id,
    })),
    signOut: vi.fn(async () => ({
      headers: new Headers({
        "set-cookie": "icos.session_token=; Max-Age=0; HttpOnly; SameSite=Lax",
      }),
      success: true,
    })),
    ...overrides,
  };
}

function installContainer(
  input: {
    auth?: AuthGateway;
    authHttp?: AuthHttpGateway;
    audit?: AuditRepository;
  } = {},
): Container {
  const base = buildMemoryContainer();
  const container: Container = {
    ...base,
    auth: input.auth ?? authGateway(),
    authHttp: input.authHttp ?? authHttpGateway(),
    audit: input.audit ?? base.audit,
  };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return container;
}

async function body(response: Response): Promise<{
  success?: boolean;
  error?: { code: string; message: string };
}> {
  return response.json() as Promise<{
    success?: boolean;
    error?: { code: string; message: string };
  }>;
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
});

describe("POST /api/auth/[...all]", () => {
  it("connecte un humain, relit sa session avec le nouveau cookie et n'expose aucun token", async () => {
    const readSession = vi.fn(async (headers: Headers) => {
      expect(headers.get("cookie")).toContain("icos.session_token=opaque");
      return activeSession;
    });
    const auth = authGateway({ readSession });
    const authHttp = authHttpGateway();
    const container = installContainer({ auth, authHttp });

    const response = await POST(request("sign-in/email"), context("sign-in", "email"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie")).toContain("icos.session_token=opaque");
    expect(await body(response)).toEqual({ success: true });
    expect(authHttp.signIn).toHaveBeenCalledWith({
      email: "human@icos.test",
      password: "correct horse battery staple",
      headers: expect.any(Headers),
    });
    expect(readSession).toHaveBeenCalledOnce();
    expect(JSON.stringify(await container.audit.list())).not.toMatch(
      /password|cookie|token|secret|hash/i,
    );
    expect(await container.audit.list()).toEqual([
      expect.objectContaining({
        eventType: "auth.login.succeeded",
        actor: { kind: "human", id: activeUser.id },
        details: {},
      }),
    ]);
  });

  it("normalise une erreur Better Auth sans refléter son message", async () => {
    const authHttp = authHttpGateway({
      signIn: vi.fn(async () => {
        throw new APIError("UNAUTHORIZED", {
          code: "INVALID_EMAIL_OR_PASSWORD",
          message: "raw better auth sentinel",
        });
      }),
    });
    const container = installContainer({ authHttp });

    const response = await POST(request("sign-in/email"), context("sign-in", "email"));
    const result = await response.text();

    expect(response.status).toBe(401);
    expect(result).toContain('"code":"unauthenticated"');
    expect(result).not.toContain("raw better auth sentinel");
    expect(await container.audit.list()).toEqual([
      expect.objectContaining({
        eventType: "auth.login.rejected",
        actor: { kind: "system", id: "icos-auth" },
        details: { reason: "invalid_credentials" },
      }),
    ]);
  });

  it("reste contrôlé si l'audit et la compensation de connexion échouent", async () => {
    const revokeSession = vi.fn<(headers: Headers) => Promise<void>>(async () => {
      throw new Error("revocation unavailable sentinel");
    });
    const append = vi.fn(async () => {
      throw new Error("audit unavailable sentinel");
    });
    const base = buildMemoryContainer();
    installContainer({
      auth: authGateway({ revokeSession }),
      audit: { ...base.audit, append },
    });

    const response = await POST(request("sign-in/email"), context("sign-in", "email"));
    const result = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(result).not.toContain("audit unavailable sentinel");
    expect(result).not.toContain("revocation unavailable sentinel");
    expect(revokeSession).toHaveBeenCalledOnce();
    expect(revokeSession.mock.calls[0]?.[0].get("cookie")).toContain("icos.session_token=opaque");
  });

  it("refuse un compte désactivé même si la révocation échoue", async () => {
    const disabledUser: HumanUser = { ...activeUser, status: "disabled" };
    const revokeUserSessions = vi.fn(async () => {
      throw new Error("revocation unavailable");
    });
    const auth = authGateway({
      readHumanUser: vi.fn(async () => disabledUser),
      revokeUserSessions,
    });
    const container = installContainer({ auth });

    const response = await POST(request("sign-in/email"), context("sign-in", "email"));

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({
      error: {
        code: "account_disabled",
        message: "Le compte est désactivé.",
      },
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(revokeUserSessions).toHaveBeenCalledWith(activeUser.id);
    expect(await container.audit.list()).toEqual([
      expect.objectContaining({
        eventType: "auth.login.rejected",
        actor: { kind: "human", id: activeUser.id },
        details: { reason: "account_disabled" },
      }),
    ]);
  });

  it("refuse une session non relue autoritairement et la révoque", async () => {
    const revokeUserSessions = vi.fn(async () => {});
    const auth = authGateway({
      readSession: vi.fn(async () => null),
      revokeUserSessions,
    });
    installContainer({ auth });

    const response = await POST(request("sign-in/email"), context("sign-in", "email"));

    expect(response.status).toBe(403);
    expect((await body(response)).error?.code).toBe("account_disabled");
    expect(revokeUserSessions).toHaveBeenCalledWith(activeUser.id);
  });

  it("normalise comme compte désactivé une projection autoritaire invalide", async () => {
    const revokeUserSessions = vi.fn(async () => {});
    const auth = authGateway({
      readSession: vi.fn(async () => {
        throw new AuthGuardError("account_disabled", activeUser.id);
      }),
      revokeUserSessions,
    });
    installContainer({ auth });

    const response = await POST(request("sign-in/email"), context("sign-in", "email"));

    expect(response.status).toBe(403);
    expect((await body(response)).error?.code).toBe("account_disabled");
    expect(revokeUserSessions).toHaveBeenCalledWith(activeUser.id);
  });

  it.each([
    ["sign-up/email", ["sign-up", "email"]],
    ["unknown", ["unknown"]],
  ])("ne délègue jamais la sous-route non allowlistée %s", async (path, all) => {
    const authHttp = authHttpGateway();
    installContainer({ authHttp });

    const response = await POST(request(path), context(...all));

    expect(response.status).toBe(404);
    expect((await body(response)).error?.code).toBe("not_found");
    expect(authHttp.signIn).not.toHaveBeenCalled();
    expect(authHttp.signOut).not.toHaveBeenCalled();
  });

  it("refuse une méthode non allowlistée avec une réponse contrôlée", async () => {
    installContainer();

    const response = await GET();

    expect(response.status).toBe(404);
    expect((await body(response)).error?.code).toBe("not_found");
  });

  it.each([
    ["JSON invalide", "{"],
    [
      "schéma non strict",
      {
        email: "human@icos.test",
        password: "correct horse battery staple",
        token: "sentinel-never-reflected",
      },
    ],
  ])("rejette un %s sans refléter le corps", async (_label, invalidBody) => {
    const authHttp = authHttpGateway();
    installContainer({ authHttp });

    const response = await POST(request("sign-in/email", invalidBody), context("sign-in", "email"));
    const result = await response.text();

    expect(response.status).toBe(400);
    expect(result).toContain('"code":"invalid_input"');
    expect(result).not.toContain("sentinel-never-reflected");
    expect(result).not.toContain("correct horse battery staple");
    expect(authHttp.signIn).not.toHaveBeenCalled();
  });

  it("vérifie l'origine avant toute lecture du mot de passe et audite le refus", async () => {
    const authHttp = authHttpGateway();
    const container = installContainer({ authHttp });
    const crossOrigin = request("sign-in/email", undefined, {
      origin: "https://attacker.test",
      "sec-fetch-site": "cross-site",
    });
    const readBody = vi.spyOn(crossOrigin, "json");

    const response = await POST(crossOrigin, context("sign-in", "email"));

    expect(response.status).toBe(403);
    expect(readBody).not.toHaveBeenCalled();
    expect(authHttp.signIn).not.toHaveBeenCalled();
    expect(await container.audit.list()).toEqual([
      expect.objectContaining({
        eventType: "auth.access.denied",
        details: {
          method: "POST",
          route: "auth.sign-in.email",
          reason: "cross_origin",
        },
      }),
    ]);
  });

  it("déconnecte après résolution de l'acteur, conserve le cookie expiré et tolère la panne d'audit", async () => {
    const readSession = vi.fn(async () => activeSession);
    const signOut = vi.fn(async () => ({
      headers: new Headers({
        "set-cookie": "icos.session_token=; Max-Age=0; HttpOnly; SameSite=Lax",
      }),
      success: true,
    }));
    const append = vi.fn(async () => {
      throw new Error("audit unavailable");
    });
    const base = buildMemoryContainer();
    const audit: AuditRepository = { ...base.audit, append };
    installContainer({
      auth: authGateway({ readSession }),
      authHttp: authHttpGateway({ signOut }),
      audit,
    });
    const logoutRequest = request(
      "sign-out",
      {},
      {
        cookie: "icos.session_token=opaque",
      },
    );

    const response = await POST(logoutRequest, context("sign-out"));

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ success: true });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(readSession).toHaveBeenCalledBefore(signOut);
    expect(signOut).toHaveBeenCalledWith(logoutRequest.headers);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.logout.succeeded",
        actor: { kind: "human", id: activeUser.id },
        details: {},
      }),
    );
  });

  it("déconnecte une session même si la projection autoritaire du compte est invalide", async () => {
    const readSession = vi.fn(async () => {
      throw new AuthGuardError("account_disabled", activeUser.id);
    });
    const signOut = vi.fn(async () => ({
      headers: new Headers({
        "set-cookie": "icos.session_token=; Max-Age=0; HttpOnly; SameSite=Lax",
      }),
      success: true,
    }));
    const container = installContainer({
      auth: authGateway({ readSession }),
      authHttp: authHttpGateway({ signOut }),
    });
    const logoutRequest = request(
      "sign-out",
      {},
      {
        cookie: "icos.session_token=opaque",
      },
    );

    const response = await POST(logoutRequest, context("sign-out"));

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ success: true });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(readSession).toHaveBeenCalledBefore(signOut);
    expect(signOut).toHaveBeenCalledWith(logoutRequest.headers);
    expect(await container.audit.list()).toEqual([
      expect.objectContaining({
        eventType: "auth.logout.succeeded",
        actor: { kind: "human", id: activeUser.id },
        details: {},
      }),
    ]);
  });
});

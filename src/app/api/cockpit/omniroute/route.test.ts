import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import { OperationalAccessService } from "@/server/administration/operational-access-service";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";
import { resetTelemetryRateLimiterForTests } from "@/server/telemetry/rate-limit";

const readOmniRouteCockpit = vi.fn();
vi.mock("@/server/omniroute/cockpit-service", () => ({ readOmniRouteCockpit }));

const CONTAINER_KEY = "__icosContainerPromise__";
const URL_ = "http://localhost/api/cockpit/omniroute";
const SESSION_COOKIE = "icos.session_token=opaque-test-value";

function authGateway(value: AuthenticatedSession | null): AuthGateway {
  return {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => value?.user ?? null,
    readHumanUserByEmail: async () => value?.user ?? null,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => value),
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
    readSessionEvidence: async () =>
      value ? { sessionId: "sess-omni", userId: value.user.id, issuedAt: new Date() } : null,
    verifyPassword: async () => false,
  };
}

function installSession(role: Role | null): Container {
  const base = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
  const session: AuthenticatedSession | null =
    role === null
      ? null
      : {
          user: {
            id: "trusted-human",
            email: "human@icos.test",
            name: "Human",
            status: "active",
          },
          roles: [role],
        };
  const container: Container = {
    ...base,
    auth: authGateway(session),
    operationalAccess: new OperationalAccessService({
      listAgentIdsForHuman: async () => new Set<string>(),
    } as never),
  };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return container;
}

function request(authenticated = true): Request {
  return new Request(URL_, { headers: authenticated ? { cookie: SESSION_COOKIE } : undefined });
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  resetTelemetryRateLimiterForTests();
  readOmniRouteCockpit.mockReset();
  vi.restoreAllMocks();
});

describe("GET /api/cockpit/omniroute", () => {
  it("refuse une requête sans session", async () => {
    installSession(null);
    const { GET } = await import("./route");

    const response = await GET(request(false));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthenticated", message: "Authentification requise." },
    });
    expect(readOmniRouteCockpit).not.toHaveBeenCalled();
  });

  it("refuse un membre sans rôle operator", async () => {
    installSession("viewer");
    const { GET } = await import("./route");

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(readOmniRouteCockpit).not.toHaveBeenCalled();
  });

  it("refuse un opérateur qui n'a pas la portée owner/admin globale", async () => {
    installSession("operator");
    const { GET } = await import("./route");

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "forbidden",
        message: "Les indicateurs OmniRoute exigent la portée owner/admin.",
      },
    });
    expect(readOmniRouteCockpit).not.toHaveBeenCalled();
  });

  it("renvoie le contrat versionné, sans cache, à un owner", async () => {
    const container = installSession("owner");
    readOmniRouteCockpit.mockResolvedValue({
      schema: 1,
      generatedAt: "2026-10-21T18:00:00.000Z",
      readOnly: true,
      health: { available: false, code: "NOT_CONNECTED" },
      providers: { available: false, code: "NOT_CONNECTED" },
      models: { available: false, code: "NOT_CONNECTED" },
      usage: { available: false, code: "NOT_CONNECTED" },
      cost: { available: false, code: "NOT_CONNECTED" },
      errors: { window: "24h", available: false, code: "NOT_INSTRUMENTED" },
      latency: { window: "24h", available: false, code: "NOT_INSTRUMENTED" },
    });
    const { GET } = await import("./route");

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ schema: 1, readOnly: true });
    expect(readOmniRouteCockpit).toHaveBeenCalledOnce();
    expect(readOmniRouteCockpit).toHaveBeenCalledWith(container);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";

/**
 * REGRESSION — the phone must be able to learn WHY voice was refused.
 *
 * The client probes this route after a few failed upgrades. It used to probe
 * `GET /api/conversation`, which is gated on `cockpit.read`, while the socket is
 * gated on `tasks.write`. A `viewer` therefore got 200 from the probe and 403
 * from the socket, and the phone reconnected in silence forever with no reason
 * shown. This route must stay on the socket's own permission.
 */
const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";
const COOKIE = "icos.session_token=opaque-test-value";

function install(access: Role | "anonymous") {
  const session: AuthenticatedSession | null =
    access === "anonymous"
      ? null
      : {
          user: { id: "human-1", email: "h@icos.test", name: "H", status: "active" },
          roles: [access],
        };
  const auth: AuthGateway = {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => session?.user ?? null,
    readHumanUserByEmail: async () => session?.user ?? null,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => session),
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };
  const container: Container = { ...buildMemoryContainer(), auth };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
}

async function probe(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("@/app/api/voice/status/route");
  return GET(new Request(`${ORIGIN}/api/voice/status`, { method: "GET", headers }));
}

describe("GET /api/voice/status — the voice refusal reason", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
    vi.resetModules();
  });

  it("answers 401 when signed out, so the phone goes to /login", async () => {
    install("anonymous");
    expect((await probe({})).status).toBe(401);
  });

  it("answers 403 for a viewer — the account the old probe wrongly cleared", async () => {
    install("viewer");
    const response = await probe({ cookie: COOKIE });
    expect(response.status).toBe(403);
  });

  it("answers 204 for an operator, who may use voice", async () => {
    install("operator");
    const response = await probe({ cookie: COOKIE });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("carries the SAME permission the voice socket requires", async () => {
    const [route, compose] = await Promise.all([
      import("node:fs/promises").then((fs) =>
        fs.readFile("src/app/api/voice/status/route.ts", "utf8"),
      ),
      import("node:fs/promises").then((fs) =>
        fs.readFile("src/server/voice/compose.ts", "utf8"),
      ),
    ]);
    const permission = /permission: "([^"]+)"/.exec(compose)?.[1];
    expect(permission).toBe("tasks.write");
    expect(route).toContain(`permission: "${permission}"`);
  });
});

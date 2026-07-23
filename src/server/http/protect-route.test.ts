import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";

import { protectRoute } from "./protect-route";

const credentialHeaders = new Headers({
  cookie: "icos.session_token=opaque-test-value",
});

function session(): AuthenticatedSession {
  return {
    user: {
      id: "human-1",
      email: "human@icos.test",
      status: "active",
    },
    roles: ["viewer"],
  };
}

function container(current: AuthenticatedSession): {
  container: Container;
  readSession: ReturnType<typeof vi.fn>;
} {
  const base = buildMemoryContainer();
  const readSession = vi.fn(async () => current);
  const auth: AuthGateway = {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => current.user,
    readHumanUserByEmail: async () => current.user,
    deleteHumanUser: async () => {},
    readSession,
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };

  return {
    container: { ...base, auth },
    readSession,
  };
}

describe("protectRoute", () => {
  it("renvoie la session autorisée sans la relire", async () => {
    const expected = session();
    const current = container(expected);
    const request = new Request("https://icos.test/api/agents", {
      headers: credentialHeaders,
    });

    await expect(
      protectRoute({
        container: current.container,
        request,
        route: "api.agents",
        permission: "cockpit.read",
      }),
    ).resolves.toEqual({ ok: true, session: expected });
    expect(current.readSession).toHaveBeenCalledTimes(1);
  });

  it("refuse une mutation cross-origin avant toute lecture du corps", async () => {
    const current = container(session());
    const request = new Request("https://icos.test/api/tasks", {
      method: "POST",
      headers: {
        ...Object.fromEntries(credentialHeaders),
        "content-type": "application/json",
        origin: "https://attacker.test",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ title: "Ne doit pas être lu" }),
    });
    const readBody = vi.spyOn(request, "json");

    const result = await protectRoute({
      container: current.container,
      request,
      route: "api.tasks",
      permission: "tasks.write",
      sameOrigin: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
    expect(readBody).not.toHaveBeenCalled();
    expect(current.readSession).toHaveBeenCalledTimes(1);
  });
});

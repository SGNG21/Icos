import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "@/core/identity";
import { buildMemoryContainer, type Container } from "@/server/container";

import { resolveCockpitAccess } from "./cockpit-access";
import type { AuthGateway } from "./ports";

function session(status: "active" | "disabled" = "active"): AuthenticatedSession {
  return {
    user: {
      id: "human-1",
      email: "human@icos.test",
      status,
    },
    roles: ["viewer"],
  };
}

function container(current: AuthenticatedSession | null): Container {
  const base = buildMemoryContainer();
  const readSession = vi.fn(async () => current);
  const auth: AuthGateway = {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => current?.user ?? null,
    readHumanUserByEmail: async () => current?.user ?? null,
    deleteHumanUser: async () => {},
    readSession,
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };

  return {
    ...base,
    agents: {
      ...base.agents,
      list: vi.fn(async () => {
        throw new Error("repository must not be read");
      }),
    },
    auth,
  };
}

const credentialHeaders = new Headers({ cookie: "icos.session_token=opaque-test-value" });

describe("resolveCockpitAccess", () => {
  it("redirige une requête sans credential avant toute lecture de repository", async () => {
    const current = container(session());

    await expect(resolveCockpitAccess(current, new Headers())).resolves.toEqual({
      kind: "redirect",
      code: "unauthenticated",
    });
    expect(current.agents.list).not.toHaveBeenCalled();
  });

  it("redirige un credential expiré", async () => {
    await expect(resolveCockpitAccess(container(null), credentialHeaders)).resolves.toEqual({
      kind: "redirect",
      code: "session_expired",
    });
  });

  it("retourne un refus contrôlé pour un compte désactivé", async () => {
    await expect(
      resolveCockpitAccess(container(session("disabled")), credentialHeaders),
    ).resolves.toEqual({ kind: "forbidden", code: "account_disabled" });
  });

  it("autorise une session disposant de cockpit.read", async () => {
    await expect(resolveCockpitAccess(container(session()), credentialHeaders)).resolves.toEqual({
      kind: "allowed",
    });
  });
});

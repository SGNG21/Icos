import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLink,
  createUser,
  listLinks,
  listUsers,
  removeLink,
  replaceRole,
  setStatus,
} from "./user-administration-client";

function mockFetch(status: number, body: unknown) {
  return vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function mockFetch204() {
  return vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client d'administration", () => {
  it("liste les utilisateurs", async () => {
    const expected = {
      users: [{ id: "human-1", email: "admin@icos.test", status: "active", role: "owner" }],
    };
    mockFetch(200, expected);

    const result = await listUsers();

    expect(result).toEqual(expected);
    expect(fetch).toHaveBeenCalledWith("/api/users", undefined);
  });

  it("crée un utilisateur", async () => {
    const input = {
      email: "new@icos.test",
      password: "correct horse battery staple",
      role: "viewer" as const,
    };
    const expected = {
      user: { id: "new-id", email: "new@icos.test", status: "active", role: "viewer" },
    };
    mockFetch(201, expected);

    const result = await createUser(input);

    expect(result).toEqual(expected);
    expect(fetch).toHaveBeenCalledWith("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  });

  it("remplace le rôle", async () => {
    const expected = {
      user: { id: "human-2", email: "t@icos.test", status: "active", role: "admin" },
    };
    mockFetch(200, expected);

    const result = await replaceRole("human-2", "admin");

    expect(result).toEqual(expected);
    expect(fetch).toHaveBeenCalledWith("/api/users/human-2/role", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
  });

  it("met à jour le statut", async () => {
    const expected = {
      user: { id: "human-2", email: "t@icos.test", status: "disabled", role: "viewer" },
    };
    mockFetch(200, expected);

    const result = await setStatus("human-2", "disabled");

    expect(result).toEqual(expected);
    expect(fetch).toHaveBeenCalledWith("/api/users/human-2/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "disabled" }),
    });
  });

  it("liste les liens d'un utilisateur", async () => {
    const expected = {
      links: [
        {
          id: "lnk-1",
          humanUserId: "human-2",
          agentId: "agent-cto",
          relation: "operator",
          createdAt: new Date().toISOString(),
          createdByHumanUserId: "human-1",
        },
      ],
    };
    mockFetch(200, expected);

    const result = await listLinks("human-2");

    expect(result).toEqual(expected);
    expect(fetch).toHaveBeenCalledWith("/api/users/human-2/agent-links", undefined);
  });

  it("ajoute un lien", async () => {
    const expected = {
      link: {
        id: "lnk-2",
        humanUserId: "human-2",
        agentId: "agent-cto",
        relation: "operator",
        createdAt: new Date().toISOString(),
        createdByHumanUserId: "human-1",
      },
    };
    mockFetch(201, expected);

    const result = await createLink("human-2", { agentId: "agent-cto", relation: "operator" });

    expect(result).toEqual(expected);
    expect(fetch).toHaveBeenCalledWith("/api/users/human-2/agent-links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-cto", relation: "operator" }),
    });
  });

  it("retire un lien (204)", async () => {
    mockFetch204();

    await removeLink("human-2", "agent-cto");

    expect(fetch).toHaveBeenCalledWith("/api/users/human-2/agent-links/agent-cto", {
      method: "DELETE",
    });
  });

  it("mappe les erreurs HTTP en exceptions génériques", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "accès refusé" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(listUsers()).rejects.toThrow("accès refusé");
  });

  it("ne stocke ni n'attend pas de token", async () => {
    const fetchSpy = vi.mocked(fetch);
    mockFetch(200, { users: [] });

    await listUsers();

    const [, options] = fetchSpy.mock.calls[0];
    const headers = (options as RequestInit | undefined)?.headers;
    if (headers !== undefined) {
      const headerRecord =
        headers instanceof Headers
          ? Object.fromEntries(headers.entries())
          : (headers as Record<string, string>);
      expect(headerRecord).not.toHaveProperty("authorization");
    }
  });
});

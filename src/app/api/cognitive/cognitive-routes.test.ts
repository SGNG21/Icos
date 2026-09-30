import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";

const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";
const COOKIE = "icos.session_token=opaque-test-value";

type Access = Role | "anonymous" | "expired" | "no-auth-gateway";

function install(access: Access) {
  const session: AuthenticatedSession | null =
    access === "anonymous" || access === "expired" || access === "no-auth-gateway"
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
    readSession: vi.fn(async () => session), // expired => cookie present but no valid session
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };
  const dispatch = vi.fn(async (input: { workflowId?: string; taskId: string }) => ({
    workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
  }));
  const baseContainer = buildMemoryContainer();
  const container: Container = {
    ...baseContainer,
    auth: access === "no-auth-gateway" ? undefined : auth,
    taskExecution: { dispatch } as never,
  };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return { container, dispatch, readSession: auth.readSession as ReturnType<typeof vi.fn> };
}

// Helper functions for each endpoint
async function callGetConversations(headers: Record<string, string>) {
  const { GET } = await import("@/app/api/cognitive/conversations/route");
  return GET(
    new Request(`${ORIGIN}/api/cognitive/conversations`, {
      method: "GET",
      headers,
    }),
  );
}

async function callPostConversations(headers: Record<string, string>, body: unknown = {}) {
  const { POST } = await import("@/app/api/cognitive/conversations/route");
  return POST(
    new Request(`${ORIGIN}/api/cognitive/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function callPostTurns(
  conversationId: string,
  headers: Record<string, string>,
  body: unknown = {},
) {
  const { POST } = await import("@/app/api/cognitive/conversations/[id]/turns/route");
  return POST(
    new Request(`${ORIGIN}/api/cognitive/conversations/${conversationId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: conversationId }) },
  );
}

async function callGetEvents(conversationId: string, headers: Record<string, string>) {
  const { GET } = await import("@/app/api/cognitive/conversations/[id]/events/route");
  return GET(
    new Request(`${ORIGIN}/api/cognitive/conversations/${conversationId}/events`, {
      method: "GET",
      headers,
    }),
    { params: Promise.resolve({ id: conversationId }) },
  );
}

async function callPostDecision(
  conversationId: string,
  proposalRefId: string,
  headers: Record<string, string>,
  body: unknown = {},
) {
  const { POST } =
    await import("@/app/api/cognitive/conversations/[id]/proposals/[refId]/decision/route");
  return POST(
    new Request(
      `${ORIGIN}/api/cognitive/conversations/${conversationId}/proposals/${proposalRefId}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ id: conversationId, refId: proposalRefId }) },
  );
}

async function callPostMemory(headers: Record<string, string>, body: unknown = {}) {
  const { POST } = await import("@/app/api/cognitive/memory/route");
  return POST(
    new Request(`${ORIGIN}/api/cognitive/memory`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const authed = { origin: ORIGIN, cookie: COOKIE };

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Anonymous access", () => {
  it("GET /api/cognitive/conversations returns 401", async () => {
    const f = install("anonymous");
    const response = await callGetConversations({ origin: ORIGIN });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    expect(f.readSession).not.toHaveBeenCalled();
  });

  it("POST /api/cognitive/conversations/[id]/turns returns 401", async () => {
    const f = install("anonymous");
    const response = await callPostTurns("conv-x", { origin: ORIGIN });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    expect(f.readSession).not.toHaveBeenCalled();
  });
});

describe("Viewer role (403 for write operations)", () => {
  it("POST /api/cognitive/conversations returns 403", async () => {
    install("viewer");
    const response = await callPostConversations(authed);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("POST /api/cognitive/conversations/[id]/proposals/[refId]/decision returns 403", async () => {
    install("viewer");
    const response = await callPostDecision("conv-x", "prop-y", authed);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("Operator with in-memory container (persistence_unavailable)", () => {
  it("GET /api/cognitive/conversations returns 503", async () => {
    install("operator");
    const response = await callGetConversations(authed);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "persistence_unavailable" } });
  });

  it("POST /api/cognitive/conversations returns 503", async () => {
    install("operator");
    const response = await callPostConversations(authed);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "persistence_unavailable" } });
  });

  it("POST /api/cognitive/conversations/[id]/turns returns 503", async () => {
    install("operator");
    const response = await callPostTurns("conv-x", authed);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "persistence_unavailable" } });
  });

  it("GET /api/cognitive/conversations/[id]/events returns 503", async () => {
    install("operator");
    const response = await callGetEvents("conv-x", authed);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "persistence_unavailable" } });
  });

  it("POST /api/cognitive/memory returns 503", async () => {
    install("operator");
    const response = await callPostMemory(authed);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "persistence_unavailable" } });
  });
});

describe("Same-origin protection for mutations", () => {
  it("POST /api/cognitive/conversations with non-same origin returns 403", async () => {
    install("operator");
    const response = await callPostConversations({ ...authed, origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  });
});

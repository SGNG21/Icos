import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "@/core/identity";
import { buildMemoryContainer, type Container } from "@/server/container";

import { POST } from "./route";

// ---------------------------------------------------------------------------
// Mock OmniRouteAdapter — no real HTTP calls during unit tests.
// ---------------------------------------------------------------------------

const { mockGenerate } = vi.hoisted(() => ({
  mockGenerate: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("@/server/ai/omniroute-adapter", () => ({
  OmniRouteAdapter: class {
    readonly generate = mockGenerate;
  },
}));

// ---------------------------------------------------------------------------
// Test helpers (mirrors patterns from ../routes.test.ts)
// ---------------------------------------------------------------------------

const CONTAINER_KEY = "__icosContainerPromise__";
const APP_ORIGIN = "http://localhost";
const SESSION_COOKIE = "icos.session_token=opaque-test-value";

function authenticatedSession(): AuthenticatedSession {
  return {
    user: { id: "human-1", email: "human@icos.test", name: "Human", status: "active" },
    roles: ["viewer"],
  };
}

type AuthLike = NonNullable<Container["auth"]>;

function installSession(session: AuthenticatedSession | null): Container {
  const base = buildMemoryContainer();
  const auth: AuthLike = {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => session?.user ?? null,
    readHumanUserByEmail: async () => session?.user ?? null,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => session),
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };
  const container: Container = { ...base, auth };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return container;
}

function jsonRequest(
  body: unknown,
  options: { origin?: string } = {},
): Request {
  const origin = options.origin ?? APP_ORIGIN;
  return new Request(`${APP_ORIGIN}/api/conversation`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: SESSION_COOKIE,
      origin,
      "sec-fetch-site": origin === APP_ORIGIN ? "same-origin" : "cross-site",
    },
    body: JSON.stringify(body),
  });
}

function unauthenticatedRequest(body: unknown): Request {
  return new Request(`${APP_ORIGIN}/api/conversation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  vi.clearAllMocks();
});

describe("POST /api/conversation", () => {
  it("rejects unauthenticated requests (401)", async () => {
    installSession(authenticatedSession());

    const response = await POST(unauthenticatedRequest({ message: "Bonjour" }));

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe("unauthenticated");
  });

  it("rejects cross-origin requests (403)", async () => {
    installSession(authenticatedSession());

    const response = await POST(
      jsonRequest({ message: "Bonjour" }, { origin: "https://attacker.test" }),
    );

    expect(response.status).toBe(403);
  });

  it("rejects invalid JSON body (400)", async () => {
    installSession(authenticatedSession());
    const request = new Request(`${APP_ORIGIN}/api/conversation`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: SESSION_COOKIE,
        origin: APP_ORIGIN,
        "sec-fetch-site": "same-origin",
      },
      body: "pas du json",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("invalid_json");
  });

  it("rejects empty message (400)", async () => {
    installSession(authenticatedSession());

    const response = await POST(jsonRequest({ message: "" }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rejects missing message (400)", async () => {
    installSession(authenticatedSession());

    const response = await POST(jsonRequest({}));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rejects message exceeding max length (400)", async () => {
    installSession(authenticatedSession());

    const response = await POST(jsonRequest({ message: "x".repeat(8_001) }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("invalid_request");
  });

  it("returns successful OmniRoute response (200)", async () => {
    installSession(authenticatedSession());

    mockGenerate.mockResolvedValueOnce({
      success: true,
      content: "Je suis ICOS, votre assistant vocal.",
      finishReason: "stop",
      provider: { id: "openai", model: "gpt-4o-mini" },
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
      latencyMs: 1200,
      fallbackUsed: false,
    });

    const response = await POST(jsonRequest({ message: "Présente-toi." }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      reply?: string;
      provider?: string;
      fallbackUsed?: boolean;
    };
    expect(body.reply).toBe("Je suis ICOS, votre assistant vocal.");
    expect(body.provider).toBe("openai");
    expect(body.fallbackUsed).toBe(false);
  });

  it("maps OmniRoute timeout to 504", async () => {
    installSession(authenticatedSession());

    mockGenerate.mockResolvedValueOnce({
      success: false,
      error: { code: "TIMEOUT", message: "Délai d'attente dépassé", retryable: true, fallbackPossible: true },
      latencyMs: 45000,
      fallbackUsed: false,
    });

    const response = await POST(jsonRequest({ message: "Test timeout." }));

    expect(response.status).toBe(504);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("TIMEOUT");
  });

  it("maps provider unavailable to 503", async () => {
    installSession(authenticatedSession());

    mockGenerate.mockResolvedValueOnce({
      success: false,
      error: { code: "PROVIDER_UNAVAILABLE", message: "Provider injoignable", retryable: true, fallbackPossible: true },
      latencyMs: 5000,
      fallbackUsed: false,
    });

    const response = await POST(jsonRequest({ message: "Test provider down." }));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("PROVIDER_UNAVAILABLE");
  });
});

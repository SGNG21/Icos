import { describe, expect, it, vi } from "vitest";

import type { IcosBetterAuth } from "./better-auth";
import { BetterAuthHttpGateway } from "./http-gateway";

function authWithApi(api: Record<string, unknown>): IcosBetterAuth {
  return { api } as unknown as IcosBetterAuth;
}

describe("BetterAuthHttpGateway", () => {
  it("connecte un humain sans exposer le token Better Auth", async () => {
    const responseHeaders = new Headers({
      "set-cookie": "icos.session_token=opaque; HttpOnly; SameSite=Lax",
    });
    const signInEmail = vi.fn(async () => ({
      headers: responseHeaders,
      response: {
        redirect: false,
        token: "sentinel-token-never-exposed",
        url: undefined,
        user: { id: "human-1" },
      },
      status: 200,
    }));
    const gateway = new BetterAuthHttpGateway(authWithApi({ signInEmail }));
    const headers = new Headers({ origin: "https://icos.test" });

    const result = await gateway.signIn({
      email: "human@icos.test",
      password: "correct horse battery staple",
      headers,
    });

    expect(signInEmail).toHaveBeenCalledWith({
      body: {
        email: "human@icos.test",
        password: "correct horse battery staple",
      },
      headers,
      returnHeaders: true,
      returnStatus: true,
    });
    expect(result).toEqual({
      headers: responseHeaders,
      userId: "human-1",
    });
    expect(JSON.stringify(result)).not.toContain("sentinel-token-never-exposed");
  });

  it("déconnecte en conservant le cookie expiré sans exposer la réponse native", async () => {
    const responseHeaders = new Headers({
      "set-cookie": "icos.session_token=; Max-Age=0; HttpOnly; SameSite=Lax",
    });
    const signOut = vi.fn(async () => ({
      headers: responseHeaders,
      response: { success: true },
      status: 200,
    }));
    const gateway = new BetterAuthHttpGateway(authWithApi({ signOut }));
    const headers = new Headers({ cookie: "icos.session_token=opaque" });

    const result = await gateway.signOut(headers);

    expect(signOut).toHaveBeenCalledWith({
      headers,
      returnHeaders: true,
      returnStatus: true,
    });
    expect(result).toEqual({
      headers: responseHeaders,
      success: true,
    });
  });
});

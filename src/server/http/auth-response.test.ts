import { describe, expect, it } from "vitest";

import { AuthGuardError } from "@/server/auth/errors";

import { authErrorResponse } from "./auth-response";

describe("authErrorResponse", () => {
  it.each([
    ["unauthenticated", 401, "Authentification requise."],
    ["session_expired", 401, "La session a expiré."],
    ["forbidden", 403, "Accès interdit."],
    ["account_disabled", 403, "Le compte est désactivé."],
  ] as const)("convertit %s en réponse contrôlée", async (code, status, message) => {
    const response = authErrorResponse(new AuthGuardError(code));

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ error: { code, message } });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthGuardError } from "@/server/auth/errors";

import { isSameOriginMutation, requireSameOrigin } from "./origin";

const PUBLIC_URL = "https://icos-node.tailnet.ts.net";

function mutation(headers: Record<string, string> = {}): Request {
  return new Request("https://icos.test/api/tasks", {
    method: "POST",
    headers,
  });
}

/** Requête telle que reçue derrière un reverse proxy (Tailscale Serve → 127.0.0.1:3000). */
function proxiedMutation(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  // Isole chaque test de l'environnement ambiant.
  vi.stubEnv("BETTER_AUTH_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isSameOriginMutation", () => {
  it("accepte une origine normalisée identique", () => {
    expect(
      isSameOriginMutation(
        mutation({
          origin: "https://icos.test",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["origine absente", {}],
    ["origine différente", { origin: "https://other.test" }],
    ["origine cross-site", { origin: "https://icos.test", "sec-fetch-site": "cross-site" }],
    ["port différent", { origin: "https://icos.test:8443" }],
    ["origine malformée", { origin: "not a url" }],
    ["origine opaque", { origin: "null" }],
  ])("refuse une mutation avec %s", (_label, headers) => {
    expect(isSameOriginMutation(mutation(headers))).toBe(false);
  });
});

describe("isSameOriginMutation derrière l'origine publique configurée (BETTER_AUTH_URL)", () => {
  it("accepte l'origine publique canonique configurée", () => {
    vi.stubEnv("BETTER_AUTH_URL", PUBLIC_URL);
    expect(
      isSameOriginMutation(
        proxiedMutation({ origin: PUBLIC_URL, "sec-fetch-site": "same-origin" }),
      ),
    ).toBe(true);
  });

  it("accepte toujours l'origine directe lorsque l'origine publique est configurée", () => {
    vi.stubEnv("BETTER_AUTH_URL", PUBLIC_URL);
    expect(isSameOriginMutation(proxiedMutation({ origin: "http://127.0.0.1:3000" }))).toBe(true);
  });

  it("ne retient que l'origine d'une BETTER_AUTH_URL comportant un chemin", () => {
    vi.stubEnv("BETTER_AUTH_URL", `${PUBLIC_URL}/api/auth?x=1#y`);
    expect(isSameOriginMutation(proxiedMutation({ origin: PUBLIC_URL }))).toBe(true);
    expect(isSameOriginMutation(proxiedMutation({ origin: `${PUBLIC_URL}/api/auth` }))).toBe(true);
  });

  it("refuse l'origine publique sans configuration", () => {
    expect(isSameOriginMutation(proxiedMutation({ origin: PUBLIC_URL }))).toBe(false);
  });

  it.each([
    ["origine tierce", { origin: "https://evil.example" }],
    ["port différent", { origin: `${PUBLIC_URL}:8443` }],
    ["schéma différent", { origin: "http://icos-node.tailnet.ts.net" }],
    ["sous-domaine", { origin: "https://evil.icos-node.tailnet.ts.net" }],
    ["origine absente", {}],
    ["origine malformée", { origin: "https://" }],
    ["origine opaque", { origin: "null" }],
    ["cross-site malgré l'origine publique", { origin: PUBLIC_URL, "sec-fetch-site": "cross-site" }],
  ])("refuse une mutation avec %s", (_label, headers) => {
    vi.stubEnv("BETTER_AUTH_URL", PUBLIC_URL);
    expect(isSameOriginMutation(proxiedMutation(headers))).toBe(false);
  });

  it.each([
    ["non-URL", "not a url"],
    ["joker", "*"],
    ["schéma opaque", "javascript:alert(1)"],
    ["schéma data", "data:text/plain,x"],
  ])("BETTER_AUTH_URL %s n'ouvre aucune origine supplémentaire", (_label, value) => {
    vi.stubEnv("BETTER_AUTH_URL", value);
    expect(isSameOriginMutation(proxiedMutation({ origin: PUBLIC_URL }))).toBe(false);
    expect(isSameOriginMutation(proxiedMutation({ origin: "null" }))).toBe(false);
    expect(isSameOriginMutation(proxiedMutation({ origin: "https://evil.example" }))).toBe(false);
    // L'origine directe reste acceptée : une mauvaise configuration ne ferme pas le service local.
    expect(isSameOriginMutation(proxiedMutation({ origin: "http://127.0.0.1:3000" }))).toBe(true);
  });

  it("n'accorde aucune confiance aux headers X-Forwarded-*", () => {
    // Sans configuration : les headers proxy ne fabriquent pas d'origine acceptable.
    expect(
      isSameOriginMutation(
        proxiedMutation({
          origin: "https://evil.example",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe(false);

    // Avec configuration : X-Forwarded-* pointant vers une origine hostile reste refusé…
    vi.stubEnv("BETTER_AUTH_URL", PUBLIC_URL);
    expect(
      isSameOriginMutation(
        proxiedMutation({
          origin: "https://evil.example",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe(false);
    // … et ne retire rien à l'origine configurée.
    expect(
      isSameOriginMutation(
        proxiedMutation({
          origin: PUBLIC_URL,
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "http",
        }),
      ),
    ).toBe(true);
  });
});

describe("requireSameOrigin", () => {
  it("lève un refus typé sans refléter l'origine", () => {
    expect(() => requireSameOrigin(mutation({ origin: "https://other.test" }))).toThrowError(
      new AuthGuardError("forbidden"),
    );
  });

  it("accepte l'origine publique configurée", () => {
    vi.stubEnv("BETTER_AUTH_URL", PUBLIC_URL);
    expect(() => requireSameOrigin(proxiedMutation({ origin: PUBLIC_URL }))).not.toThrow();
  });
});

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { config, proxy } from "./proxy";

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

describe("proxy", () => {
  it("redirige une page cockpit sans cookie en conservant la destination", () => {
    const response = proxy(request("/tasks?status=pending"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/login?next=%2Ftasks%3Fstatus%3Dpending",
    );
  });

  it("laisse passer une page cockpit si le cookie Better Auth est présent", () => {
    const response = proxy(request("/", "icos.session_token=opaque-test-value"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("laisse passer une page cockpit si le cookie Better Auth sécurisé est présent", () => {
    const response = proxy(request("/", "__Secure-icos.session_token=opaque-test-value"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("ne redirige jamais la page de connexion", () => {
    const response = proxy(request("/login?next=%2F"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("continue d'exclure les routes publiques du matcher", () => {
    const matches = (path: string) => config.matcher.some((m) => new RegExp(`^${m}$`).test(path));
    for (const open of [
      "/api/cockpit",
      "/_next/static/x.js",
      "/favicon.ico",
      "/manifest.webmanifest",
      "/sw.js",
      "/offline.html",
      "/icon/192",
      "/apple-icon",
    ]) {
      expect(matches(open), open).toBe(false);
    }
  });

  it("garde protégées les routes applicatives, y compris les préfixes trompeurs", () => {
    const matches = (path: string) => config.matcher.some((m) => new RegExp(`^${m}$`).test(path));
    for (const guarded of [
      "/",
      "/cockpit",
      "/cockpit/system",
      "/control-room",
      "/sw.jsx",
      "/offline.html/x",
      "/manifest.webmanifest.bak",
      "/iconography",
    ]) {
      expect(matches(guarded), guarded).toBe(true);
    }
  });
});

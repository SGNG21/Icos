import { describe, expect, it } from "vitest";

import type { ConnectorInstance } from "@/core/tool-gateway/model";

import type { ConnectorContext } from "../ports";
import {
  checkResolvedTarget,
  htmlToText,
  isForbiddenAddress,
  isForbiddenHost,
  validateWebTarget,
  webConnector,
  WEB_DEFINITION,
} from "./web";

const instance: ConnectorInstance = {
  instanceId: "web-main",
  connectorId: "web",
  tenantId: "t1",
  config: {},
  enabled: true,
};
const ctx = (config: ConnectorInstance["config"] = {}): ConnectorContext => ({
  instance: { ...instance, config },
  signal: new AbortController().signal,
  idempotencyKey: "k",
  toolExecutionId: "x",
});
const fakeFetch = (handler: (url: URL) => Response) =>
  (async (input: string | URL | Request) => handler(new URL(String(input)))) as typeof fetch;
const at = () => new Date("2026-10-05T10:00:00.000Z");
/** No real DNS in tests: every name resolves to a public documentation-free address. */
const publicDns = async () => ["93.184.215.14"];

describe("web connector: governed read-only web access", () => {
  it("is READ / LOW / no approval, so research is autonomous by default", () => {
    const [action] = WEB_DEFINITION.tools[0]!.actions;
    expect(action).toMatchObject({ action: "READ", risk: "LOW", sideEffects: "none" });
    expect(action!.approval.mode).toBe("none");
    expect(WEB_DEFINITION.tools[0]!.actions).toHaveLength(1);
  });

  it("returns the page as text with retrieval provenance", async () => {
    const web = webConnector(
      fakeFetch(
        () =>
          new Response(
            "<html><body><h1>Hi</h1><script>x()</script><p>Body &amp; more</p></body></html>",
            {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          ),
      ),
      at,
      publicDns,
    );
    const out = await web.execute("web-fetch", "READ", { url: "https://example.org/a" }, ctx());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output).toMatchObject({
      url: "https://example.org/a",
      finalUrl: "https://example.org/a",
      status: 200,
      retrievedAt: "2026-10-05T10:00:00.000Z",
      text: "Hi\nBody & more",
      truncated: false,
    });
    // The summary carries provenance only, never the content.
    expect(out.summary).not.toHaveProperty("text");
    expect(out.summary).toMatchObject({ url: "https://example.org/a", status: 200 });
  });

  it("refuses private, local and non-http targets, and credentials in the URL", async () => {
    const web = webConnector(
      fakeFetch(() => new Response("never")),
      at,
      publicDns,
    );
    for (const url of [
      "http://127.0.0.1/admin",
      "http://localhost:3000/",
      "http://10.1.2.3/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://intranet/",
      "http://db.internal/",
      "file:///etc/passwd",
      "ftp://example.org/",
      "https://user:pw@example.org/",
    ]) {
      const out = await web.execute("web-fetch", "READ", { url }, ctx());
      expect(out.ok, url).toBe(false);
      if (!out.ok) expect(out.settlement).toBe("NOT_APPLIED");
    }
    expect(isForbiddenHost("example.org")).toBe(false);
    expect(validateWebTarget("https://docs.example.org/x", ["example.org"]).ok).toBe(true);
    expect(validateWebTarget("https://evil.org/x", ["example.org"]).ok).toBe(false);
  });

  it("follows a public redirect but refuses one that lands on a private host", async () => {
    const hops: string[] = [];
    const web = webConnector(
      fakeFetch((url) => {
        hops.push(url.toString());
        if (url.pathname === "/start")
          return new Response(null, { status: 302, headers: { location: "/final" } });
        if (url.pathname === "/trap")
          return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } });
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }),
      at,
      publicDns,
    );
    const ok = await web.execute("web-fetch", "READ", { url: "https://example.org/start" }, ctx());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.output.finalUrl).toBe("https://example.org/final");
    const trap = await web.execute("web-fetch", "READ", { url: "https://example.org/trap" }, ctx());
    expect(trap.ok).toBe(false);
    if (!trap.ok) expect(trap.failureClass).toBe("PERMISSION_DENIED");
    expect(hops).not.toContain("http://127.0.0.1/");
  });

  it("caps the body and says so; a non-2xx is classified, never silently empty", async () => {
    const big = "x".repeat(600_000);
    const web = webConnector(
      fakeFetch((url) =>
        url.pathname === "/404"
          ? new Response("nope", { status: 404 })
          : new Response(big, { status: 200, headers: { "content-type": "text/plain" } }),
      ),
      at,
      publicDns,
    );
    const out = await web.execute("web-fetch", "READ", { url: "https://example.org/big" }, ctx());
    expect(out.ok && out.output.truncated).toBe(true);
    expect(out.ok && (out.output.text as string).length).toBe(256_000);
    const missing = await web.execute(
      "web-fetch",
      "READ",
      { url: "https://example.org/404" },
      ctx(),
    );
    expect(!missing.ok && missing.failureClass).toBe("NOT_FOUND");
  });

  it("html is reduced to readable text", () => {
    expect(htmlToText("<p>a</p><style>b{}</style><div>c &lt;d&gt;</div>")).toBe("a\nc <d>");
  });

  it("DNS REBINDING: a public name resolving to a private address is refused before any request", async () => {
    const hits: string[] = [];
    const dns: Record<string, string[]> = {
      "rebind.example.org": ["93.184.215.14", "10.0.0.5"],
      "meta.example.org": ["169.254.169.254"],
      "v6.example.org": ["::ffff:127.0.0.1"],
      "ok.example.org": ["93.184.215.14"],
      "hop.example.org": ["93.184.215.14"],
    };
    const web = webConnector(
      fakeFetch((url) => {
        hits.push(url.hostname);
        if (url.hostname === "hop.example.org")
          return new Response(null, {
            status: 302,
            headers: { location: "https://meta.example.org/latest" },
          });
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }),
      at,
      async (host) => dns[host] ?? [],
    );
    for (const host of ["rebind.example.org", "meta.example.org", "v6.example.org"]) {
      const out = await web.execute("web-fetch", "READ", { url: `https://${host}/` }, ctx());
      expect(out.ok, host).toBe(false);
      if (!out.ok) expect(out.failureClass).toBe("PERMISSION_DENIED");
    }
    // Checked on every hop: the redirect target resolves inside, so it is never fetched.
    const viaRedirect = await web.execute(
      "web-fetch",
      "READ",
      { url: "https://hop.example.org/" },
      ctx(),
    );
    expect(!viaRedirect.ok && viaRedirect.failureClass).toBe("PERMISSION_DENIED");
    // Unresolvable is a not-applied network failure, never a blind fetch.
    const nx = await web.execute("web-fetch", "READ", { url: "https://nx.example.org/" }, ctx());
    expect(!nx.ok && nx.failureClass).toBe("NETWORK_ERROR");
    expect(hits).toEqual(["hop.example.org"]);
    const ok = await web.execute("web-fetch", "READ", { url: "https://ok.example.org/" }, ctx());
    expect(ok.ok).toBe(true);
  });

  it("address policy covers private, reserved, multicast and embedded v4 forms", async () => {
    for (const a of [
      "10.1.1.1",
      "127.0.0.1",
      "169.254.1.1",
      "100.64.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:192.168.0.1",
      "64:ff9b::10.0.0.1",
      "not-an-ip",
    ]) {
      expect(isForbiddenAddress(a), a).toBe(true);
    }
    for (const a of ["93.184.215.14", "2606:4700::6810:84e5", "1.1.1.1"]) {
      expect(isForbiddenAddress(a), a).toBe(false);
    }
    const resolverThrows = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await checkResolvedTarget(new URL("https://x.example.org/"), resolverThrows)).toEqual({
      ok: false,
      reason: "unresolvable",
    });
  });

  it("declares a local per-minute rate limit", () => {
    expect(WEB_DEFINITION.tools[0]!.rateLimit).toEqual({ maxRequests: 60, perSeconds: 60 });
  });
});

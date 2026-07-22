import { describe, expect, it } from "vitest";

import { AuthGuardError } from "@/server/auth/errors";

import { isSameOriginMutation, requireSameOrigin } from "./origin";

function mutation(headers: Record<string, string> = {}): Request {
  return new Request("https://icos.test/api/tasks", {
    method: "POST",
    headers,
  });
}

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
  ])("refuse une mutation avec %s", (_label, headers) => {
    expect(isSameOriginMutation(mutation(headers))).toBe(false);
  });
});

describe("requireSameOrigin", () => {
  it("lève un refus typé sans refléter l'origine", () => {
    expect(() => requireSameOrigin(mutation({ origin: "https://other.test" }))).toThrowError(
      new AuthGuardError("forbidden"),
    );
  });
});

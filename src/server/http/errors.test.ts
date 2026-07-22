import { describe, expect, it } from "vitest";

import { httpStatusFor } from "./errors";

describe("httpStatusFor", () => {
  it.each([
    ["unauthenticated", 401],
    ["session_expired", 401],
    ["forbidden", 403],
    ["account_disabled", 403],
  ] as const)("mappe %s vers %i", (code, status) => {
    expect(httpStatusFor(code)).toBe(status);
  });
});

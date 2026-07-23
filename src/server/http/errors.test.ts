import { describe, expect, it } from "vitest";

import { httpStatusFor } from "./errors";

describe("httpStatusFor", () => {
  it.each([
    ["unauthenticated", 401],
    ["session_expired", 401],
    ["forbidden", 403],
    ["account_disabled", 403],
    ["already_exists", 409],
    ["last_owner", 409],
    ["invalid_input", 400],
    ["not_found", 404],
    ["persistence_unavailable", 503],
    ["internal_error", 500],
  ] as const)("mappe %s vers %i", (code, status) => {
    expect(httpStatusFor(code)).toBe(status);
  });
});

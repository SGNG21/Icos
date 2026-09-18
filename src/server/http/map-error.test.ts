import { afterEach, describe, expect, it, vi } from "vitest";

import { PersistenceUnavailableError } from "@/server/database/errors";
import { toErrorResponse } from "@/server/http/map-error";

afterEach(() => vi.restoreAllMocks());

describe("toErrorResponse diagnosability", () => {
  it("logs an unexpected error (name + bounded message) while returning a generic 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = toErrorResponse(new Error("AUTONOMY_PLANNER_PROVIDER_HTTP:503 " + "x".repeat(2000)));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("AUTONOMY_PLANNER");
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0].join(" "));
    expect(line).toContain("AUTONOMY_PLANNER_PROVIDER_HTTP:503");
    expect(line.length).toBeLessThan(600);
  });

  it("does not log known, mapped errors", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(toErrorResponse(new PersistenceUnavailableError("db")).status).toBe(503);
    expect(log).not.toHaveBeenCalled();
  });
});

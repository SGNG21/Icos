import { describe, expect, it } from "vitest";

import { createDatabase } from "@/server/database/client";
import {
  TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
} from "@/server/database/test-database-guard";

describe("test database guard (fail closed)", () => {
  it.each([
    "postgres://coco@localhost:5432/icos_n23_probe",
    "postgres://coco@localhost:5432/icos",
    "postgres://coco@localhost:5432/icos_live",
    "postgres://coco@localhost:5432/production",
    "postgres://coco@localhost:5432/test_probe",
    "postgres://coco@localhost:5432/",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => assertSafeTestDatabaseUrl(url)).toThrow("TEST_DATABASE_UNSAFE");
  });

  it.each([
    "postgres://coco@localhost:5432/icos_test",
    "postgres://test:test@localhost:49152/test",
    "postgres://coco@localhost:5432/icos_test_2",
  ])("accepts %s", (url) => {
    expect(() => assertSafeTestDatabaseUrl(url)).not.toThrow();
  });

  it("uses a dedicated default test database that is itself safe", () => {
    expect(() => assertSafeTestDatabaseUrl(TEST_DATABASE_URL)).not.toThrow();
  });

  it("createDatabase refuses a live-looking URL under Vitest, before any connection", () => {
    expect(() => createDatabase("postgres://coco@localhost:5432/icos_n23_probe")).toThrow(
      "TEST_DATABASE_UNSAFE",
    );
  });
});

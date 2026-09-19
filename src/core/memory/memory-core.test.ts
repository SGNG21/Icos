import { describe, expect, it } from "vitest";

import {
  assertConfidencePolicy,
  assertHuman,
  assertNoSecrets,
  assertSourceAllowed,
  assertTenant,
  canRead,
  containsSecret,
  defaultFreshness,
  freshnessOf,
  MemoryPolicyError,
  MemorySecretRejectedError,
  MemoryTenantRequiredError,
  missionMemoryInputSchema,
  proceduralConfidence,
  type MemoryActor,
} from "./index";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const day = 86_400_000;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

const human: MemoryActor = { tenantId: "default", kind: "human", id: "user-1", permissions: [] };
const agent: MemoryActor = { tenantId: "default", kind: "agent", id: "agent-1", permissions: [] };

describe("freshnessOf", () => {
  it("is fresh when no window is set", () => {
    expect(freshnessOf({ staleAfter: null, expiresAt: null }, NOW)).toBe("fresh");
  });
  it("is stale exactly at staleAfter and expired exactly at expiresAt", () => {
    expect(freshnessOf({ staleAfter: iso(1), expiresAt: null }, NOW)).toBe("fresh");
    expect(freshnessOf({ staleAfter: iso(0), expiresAt: null }, NOW)).toBe("stale");
    expect(freshnessOf({ staleAfter: iso(-day), expiresAt: iso(1) }, NOW)).toBe("stale");
    expect(freshnessOf({ staleAfter: iso(-day), expiresAt: iso(0) }, NOW)).toBe("expired");
  });
  it("expired wins over stale", () => {
    expect(freshnessOf({ staleAfter: iso(-2 * day), expiresAt: iso(-day) }, NOW)).toBe("expired");
  });
});

describe("defaultFreshness", () => {
  it("mission memory never goes stale or expires", () => {
    expect(defaultFreshness("mission", iso(0))).toEqual({ staleAfter: null, expiresAt: null });
  });
  it("procedural memory is stale after 30d and expires after 180d from lastVerifiedAt", () => {
    expect(defaultFreshness("procedural", iso(0))).toEqual({
      staleAfter: iso(30 * day),
      expiresAt: iso(180 * day),
    });
  });
  it("business memory goes stale after 180d and never expires", () => {
    expect(defaultFreshness("business", iso(0))).toEqual({
      staleAfter: iso(180 * day),
      expiresAt: null,
    });
  });
});

describe("proceduralConfidence", () => {
  it("is a smoothed success rate in (0,1)", () => {
    expect(proceduralConfidence(0, 0)).toBe(0.5);
    expect(proceduralConfidence(1, 0)).toBeCloseTo(2 / 3);
    expect(proceduralConfidence(8, 0)).toBeCloseTo(0.9);
    expect(proceduralConfidence(0, 8)).toBeCloseTo(0.1);
  });
  it("rejects negative counters", () => {
    expect(() => proceduralConfidence(-1, 0)).toThrow(RangeError);
  });
});

describe("assertConfidencePolicy", () => {
  it("lets system observe execution results at full confidence", () => {
    expect(() =>
      assertConfidencePolicy({ sourceType: "execution_result", basis: "observed", value: 1 }),
    ).not.toThrow();
  });
  it("caps agent reports at 0.7 and only as declared", () => {
    expect(() =>
      assertConfidencePolicy({ sourceType: "agent_report", basis: "declared", value: 0.7 }),
    ).not.toThrow();
    expect(() =>
      assertConfidencePolicy({ sourceType: "agent_report", basis: "declared", value: 0.71 }),
    ).toThrow(MemoryPolicyError);
    expect(() =>
      assertConfidencePolicy({ sourceType: "agent_report", basis: "observed", value: 0.5 }),
    ).toThrow(MemoryPolicyError);
  });
  it("requires a human or review source for validated confidence", () => {
    expect(() =>
      assertConfidencePolicy({ sourceType: "system", basis: "validated", value: 1 }),
    ).toThrow(MemoryPolicyError);
    expect(() =>
      assertConfidencePolicy({ sourceType: "review_decision", basis: "validated", value: 1 }),
    ).not.toThrow();
    expect(() =>
      assertConfidencePolicy({ sourceType: "human_input", basis: "validated", value: 1 }),
    ).not.toThrow();
  });
});

describe("canRead visibility", () => {
  const base = { tenantId: "default", ownerSubject: null, requiredPermission: null };
  it("tenant visibility is readable by any actor of the tenant, never across tenants", () => {
    expect(canRead({ ...base, visibility: "tenant" }, agent)).toBe(true);
    expect(canRead({ ...base, visibility: "tenant" }, { ...agent, tenantId: "other" })).toBe(false);
  });
  it("restricted needs the permission", () => {
    const entry = {
      ...base,
      visibility: "restricted" as const,
      requiredPermission: "audit.read.full",
    };
    expect(canRead(entry, agent)).toBe(false);
    expect(canRead(entry, { ...agent, permissions: ["audit.read.full"] })).toBe(true);
  });
  it("private is readable by the owner or an actor acting on the owner's behalf only", () => {
    const entry = { ...base, visibility: "private" as const, ownerSubject: "user-1" };
    expect(canRead(entry, human)).toBe(true);
    expect(canRead(entry, { ...human, id: "user-2" })).toBe(false);
    expect(canRead(entry, agent)).toBe(false);
    expect(canRead(entry, { ...agent, onBehalfOfUserId: "user-1" })).toBe(true);
  });
});

describe("secret guard", () => {
  it.each([
    ["bearer token", { note: "Authorization: Bearer abcdefghijklmnop1234567890" }],
    ["openai style key", { k: "sk-abcdefghijklmnopqrstuvwx" }],
    ["github token", { k: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }],
    ["aws key id", { k: "AKIAABCDEFGHIJKLMNOP" }],
    ["private key block", { k: "-----BEGIN RSA PRIVATE KEY-----" }],
    ["jwt", { k: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk" }],
    ["password key", { password: "hunter2" }],
    ["nested secret key", { a: { b: [{ api_key: "x" }] } }],
    ["connection string", { url: "postgres://user:pw@host:5432/db" }],
  ])("detects %s", (_label, value) => {
    expect(containsSecret(value)).toBe(true);
    expect(() => assertNoSecrets(value)).toThrow(MemorySecretRejectedError);
  });
  it("accepts ordinary structured content", () => {
    expect(containsSecret({ capability: "website.build", retries: 2, note: "build ok" })).toBe(
      false,
    );
  });
  it("does not echo the secret in the error message", () => {
    try {
      assertNoSecrets({ k: "sk-abcdefghijklmnopqrstuvwx" });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    }
  });
});

describe("actor guards", () => {
  it("assertTenant rejects a missing or empty tenant", () => {
    expect(() => assertTenant({ ...human, tenantId: "" })).toThrow(MemoryTenantRequiredError);
    expect(() => assertTenant(undefined as unknown as MemoryActor)).toThrow(
      MemoryTenantRequiredError,
    );
    expect(() => assertTenant(human)).not.toThrow();
  });
  it("assertHuman rejects workers", () => {
    expect(() => assertHuman(agent)).toThrow(MemoryPolicyError);
    expect(() => assertHuman({ ...agent, kind: "system" })).toThrow(MemoryPolicyError);
    expect(() => assertHuman(human)).not.toThrow();
  });
});

describe("missionMemoryInputSchema", () => {
  const valid = {
    missionId: "mission-1",
    kind: "result",
    title: "Build ok",
    summary: "The build succeeded",
    payload: { outcome: "success" },
    provenance: { sourceType: "execution_result", sourceId: "res-1" },
    occurredAt: iso(-1000),
    confidence: { value: 1, basis: "observed" },
  };
  it("accepts a minimal valid input", () => {
    expect(missionMemoryInputSchema.safeParse(valid).success).toBe(true);
  });
  it("requires provenance and a bounded summary", () => {
    expect(missionMemoryInputSchema.safeParse({ ...valid, provenance: undefined }).success).toBe(
      false,
    );
    expect(
      missionMemoryInputSchema.safeParse({
        ...valid,
        provenance: { sourceType: "system", sourceId: "" },
      }).success,
    ).toBe(false);
    expect(
      missionMemoryInputSchema.safeParse({ ...valid, summary: "x".repeat(2001) }).success,
    ).toBe(false);
  });
  it("rejects unknown kinds and out-of-range confidence", () => {
    expect(missionMemoryInputSchema.safeParse({ ...valid, kind: "gossip" }).success).toBe(false);
    expect(
      missionMemoryInputSchema.safeParse({
        ...valid,
        confidence: { value: 1.2, basis: "observed" },
      }).success,
    ).toBe(false);
  });
  it("task scope is derived from missionTaskId", () => {
    const parsed = missionMemoryInputSchema.parse({ ...valid, missionTaskId: "mt-1" });
    expect(parsed.scope).toBe("task");
    expect(missionMemoryInputSchema.parse(valid).scope).toBe("mission");
  });
});

describe("assertSourceAllowed (provenance cannot be forged by the writer kind)", () => {
  const system: MemoryActor = { ...agent, kind: "system", id: "sys" };
  it("agents may only cite agent_report", () => {
    expect(() => assertSourceAllowed(agent, "agent_report")).not.toThrow();
    expect(() => assertSourceAllowed(agent, "execution_result")).toThrow(MemoryPolicyError);
    expect(() => assertSourceAllowed(agent, "human_input")).toThrow(MemoryPolicyError);
  });
  it("system cannot pose as a human or an agent", () => {
    expect(() => assertSourceAllowed(system, "execution_result")).not.toThrow();
    expect(() => assertSourceAllowed(system, "review_decision")).not.toThrow();
    expect(() => assertSourceAllowed(system, "human_input")).toThrow(MemoryPolicyError);
    expect(() => assertSourceAllowed(system, "agent_report")).toThrow(MemoryPolicyError);
  });
  it("humans may cite anything but an agent report", () => {
    expect(() => assertSourceAllowed(human, "human_input")).not.toThrow();
    expect(() => assertSourceAllowed(human, "review_decision")).not.toThrow();
    expect(() => assertSourceAllowed(human, "agent_report")).toThrow(MemoryPolicyError);
  });
});

import { describe, expect, it, vi } from "vitest";

import { selfStateSnapshotSchema } from "@/core/self-state";

import { getSelfStateSnapshot } from "./get-self-state-snapshot";
import { loadSelfStateSnapshot } from "./load-self-state-snapshot";

function mutableCanonicalState(): Record<string, unknown> {
  return structuredClone(getSelfStateSnapshot()) as unknown as Record<string, unknown>;
}

function expectInvalidState(state: unknown): void {
  expect(selfStateSnapshotSchema.safeParse(state).success).toBe(false);
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (value === null || typeof value !== "object") {
    return keys;
  }

  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    collectKeys(child, keys);
  }

  return keys;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") {
    return;
  }

  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectDeepFrozen(child);
  }
}

describe("SELF-STATE-1", () => {
  it("loads the deterministic repository-owned self-state", () => {
    expect(loadSelfStateSnapshot()).toEqual(getSelfStateSnapshot());
  });

  it("accepts schema version 1", () => {
    expect(getSelfStateSnapshot().schemaVersion).toBe(1);
  });

  it("rejects an unsupported schema version safely", () => {
    const state = mutableCanonicalState();
    state.schemaVersion = 2;

    expectInvalidState(state);
  });

  it("handles a missing optional capability reference safely", () => {
    const state = mutableCanonicalState();
    delete state.capabilityReference;

    expect(selfStateSnapshotSchema.parse(state).capabilityReference).toEqual({
      status: "UNKNOWN",
    });
  });

  it("fails safely when required state is missing", () => {
    const state = mutableCanonicalState();
    delete state.currentMilestone;

    expectInvalidState(state);
  });

  it("rejects unknown extra fields", () => {
    const state = mutableCanonicalState();
    state.unexpected = true;

    expectInvalidState(state);
  });

  it("contains no secret values or secret-bearing fields", () => {
    const snapshot = getSelfStateSnapshot();
    const keys = collectKeys(snapshot).map((key) => key.toLowerCase());
    const serialized = JSON.stringify(snapshot).toLowerCase();

    expect(keys).not.toContain("password");
    expect(keys).not.toContain("token");
    expect(keys).not.toContain("apikey");
    expect(keys).not.toContain("secret");
    expect(keys).not.toContain("credentialvalue");
    expect(serialized).not.toContain("bearer ");
    expect(serialized).not.toContain("private_key");
  });

  it("contains no permission fields or grants", () => {
    const keys = collectKeys(getSelfStateSnapshot()).map((key) => key.toLowerCase());

    expect(keys.filter((key) => key.includes("permission"))).toEqual([]);
    expect(keys).not.toContain("grant");
  });

  it("contains no approval fields or grants", () => {
    const keys = collectKeys(getSelfStateSnapshot()).map((key) => key.toLowerCase());

    expect(keys.filter((key) => key.includes("approval"))).toEqual([]);
  });

  it("contains no authority fields or grants", () => {
    const keys = collectKeys(getSelfStateSnapshot()).map((key) => key.toLowerCase());

    expect(keys.filter((key) => key.includes("authority"))).toEqual([]);
  });

  it("contains no ExecutionGrant data", () => {
    const keys = collectKeys(getSelfStateSnapshot()).map((key) => key.toLowerCase());

    expect(keys).not.toContain("executiongrant");
    expect(keys).not.toContain("execution_grant");
    expect(keys).not.toContain("policyprovenance");
  });

  it("preserves all local-only invariants exactly", () => {
    expect(getSelfStateSnapshot().operatingMode).toEqual({
      LOCAL_DEV_ONLY: true,
      CLIENT_SYSTEM_ACCESS: false,
      PRODUCTION_ACCESS: false,
      CLIENT_CREDENTIALS: "forbidden",
      EXTERNAL_IRREVERSIBLE_ACTIONS: "forbidden",
    });
  });

  it("rejects every weakened local-only invariant", () => {
    const invalidValues: Record<string, unknown> = {
      LOCAL_DEV_ONLY: false,
      CLIENT_SYSTEM_ACCESS: true,
      PRODUCTION_ACCESS: true,
      CLIENT_CREDENTIALS: "allowed",
      EXTERNAL_IRREVERSIBLE_ACTIONS: "allowed",
    };

    for (const [field, value] of Object.entries(invalidValues)) {
      const state = mutableCanonicalState();
      const operatingMode = state.operatingMode as Record<string, unknown>;
      operatingMode[field] = value;

      expect(selfStateSnapshotSchema.safeParse(state).success, field).toBe(false);
    }
  });

  it("preserves the exact priority ordering", () => {
    expect(getSelfStateSnapshot().priorities).toEqual([
      { prefer: "FINISH", over: "NEW FEATURES" },
      { prefer: "INTEGRATION", over: "EXPLORATION" },
      { prefer: "E2E", over: "OPTIONAL ARCHITECTURE" },
      { prefer: "TESTABLE PRODUCT", over: "PERFECT FUTURE PRODUCT" },
    ]);
  });

  it("rejects invalid priority ordering", () => {
    const state = mutableCanonicalState();
    const priorities = state.priorities as Array<Record<string, unknown>>;
    [priorities[0], priorities[1]] = [priorities[1], priorities[0]];

    expectInvalidState(state);
  });

  it("provides provenance for every important field", () => {
    const snapshot = getSelfStateSnapshot();
    const expectedFields = [
      "schemaVersion",
      "currentMilestone",
      "completedMilestones",
      "incompleteMilestones",
      "knownBlockers",
      "capabilityReference",
      "protectedAreas",
      "operatingMode",
      "priorities",
      "gateSummary",
      "candidateImprovementAreas",
      "provenance",
    ] as const;

    for (const field of expectedFields) {
      expect(snapshot.provenance.fields[field].length, field).toBeGreaterThan(0);
    }
  });

  it("rejects malformed provenance references", () => {
    const state = mutableCanonicalState();
    const provenance = state.provenance as Record<string, unknown>;
    const fields = provenance.fields as Record<string, unknown>;
    fields.currentMilestone = ["missing-source"];

    expectInvalidState(state);
  });

  it("keeps gate summary UNKNOWN", () => {
    expect(getSelfStateSnapshot().gateSummary).toEqual({ status: "UNKNOWN" });
  });

  it("never converts UNKNOWN gate state to PASS", () => {
    const snapshot = loadSelfStateSnapshot();

    expect(snapshot.gateSummary.status).toBe("UNKNOWN");
    expect(snapshot.gateSummary.status).not.toBe("PASS");
  });

  it("keeps candidate improvements descriptive and non-executable", () => {
    const state = mutableCanonicalState();
    state.candidateImprovementAreas = [
      {
        id: "candidate-1",
        description: "Validate the M1 end-to-end scenario.",
        milestoneRelevance: "m1",
        riskClassification: "MEDIUM",
        provenance: ["m1-definition"],
      },
    ];

    const [candidate] = selfStateSnapshotSchema.parse(state).candidateImprovementAreas;
    expect(Object.keys(candidate).sort()).toEqual([
      "description",
      "id",
      "milestoneRelevance",
      "provenance",
      "riskClassification",
    ]);

    const invalidState = mutableCanonicalState();
    invalidState.candidateImprovementAreas = [
      {
        id: "candidate-1",
        description: "Validate the M1 end-to-end scenario.",
        riskClassification: "MEDIUM",
        provenance: ["m1-definition"],
        executionGrant: true,
      },
    ];
    expectInvalidState(invalidState);
  });

  it("does not turn a capability reference into authorization", () => {
    const state = mutableCanonicalState();
    state.capabilityReference = {
      status: "AVAILABLE",
      source: "canonical-self-state",
    };

    const reference = selfStateSnapshotSchema.parse(state).capabilityReference;
    expect(Object.keys(reference).sort()).toEqual(["source", "status"]);

    state.capabilityReference = {
      status: "AVAILABLE",
      source: "canonical-self-state",
      authorization: "allowed",
    };
    expectInvalidState(state);
  });

  it("returns a deeply immutable snapshot", () => {
    const snapshot = getSelfStateSnapshot();

    expectDeepFrozen(snapshot);
    expect(() => {
      (snapshot.incompleteMilestones as unknown as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it("does not accept a runtime source override", () => {
    expect(loadSelfStateSnapshot.length).toBe(0);
  });

  it("does not require chat or session memory", () => {
    vi.stubEnv("ICOS_CHAT_MEMORY", "not-canonical");
    vi.stubEnv("ICOS_SESSION_MEMORY", "not-canonical");

    expect(getSelfStateSnapshot().currentMilestone.id).toBe("m1");
    vi.unstubAllEnvs();
  });

  it("produces equivalent output across repeated uncached loads", () => {
    const first = loadSelfStateSnapshot();
    const second = loadSelfStateSnapshot();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});

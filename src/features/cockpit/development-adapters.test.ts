import { describe, expect, it } from "vitest";

import { createDevelopmentCockpitClients } from "./development-adapters";

describe("development Cockpit adapters", () => {
  it("isolates local fixtures behind all three read-only UI clients", async () => {
    const development = createDevelopmentCockpitClients();

    const initial = await development.supervisorClient.read(development.initialMissionId);
    const capabilities = await development.capabilityClient.read(development.initialMissionId);

    expect(initial.missionState).toBe("IN_PROGRESS");
    expect(capabilities.map((capability) => capability.permissionState)).toEqual([
      "ALLOWED",
      "APPROVAL_REQUIRED",
      "DENIED",
      "UNAVAILABLE",
    ]);
    expect(development.dataLabel).toContain("Données locales simulées");
  });

  it("preserves leading and trailing whitespace in valid mission objectives", async () => {
    const development = createDevelopmentCockpitClients();
    const objective = "  objectif exact  \n";

    const entry = await development.missionEntryClient.submit(objective);
    const supervision = await development.supervisorClient.read(entry.missionId);

    expect(Object.keys(entry).sort()).toEqual(["missionId", "readiness", "state"]);
    expect(supervision.objective).toBe(objective);
  });

  it("does not let capability reads mutate denied or approval-required states", async () => {
    const development = createDevelopmentCockpitClients();

    const first = await development.capabilityClient.read();
    const second = await development.capabilityClient.read();

    expect(first.find((item) => item.permissionState === "DENIED")?.permissionState).toBe("DENIED");
    expect(
      second.find((item) => item.permissionState === "APPROVAL_REQUIRED")?.permissionState,
    ).toBe("APPROVAL_REQUIRED");
    expect("resolveApproval" in development.capabilityClient).toBe(false);
  });
});

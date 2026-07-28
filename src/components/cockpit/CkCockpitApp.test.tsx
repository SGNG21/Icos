import { describe, expect, it, vi } from "vitest";

import type {
  CapabilitySnapshotClient,
  MissionEntryClient,
  SupervisorStateClient,
} from "@/features/cockpit/clients";

import { readCockpitState, submitMissionObjective, type CockpitClients } from "./CkCockpitApp";

describe("mission entry adapter boundary", () => {
  it("submits the exact textarea value without trimming or rewriting it", async () => {
    const objective = "  Préserver exactement cet objectif\n";
    const submit = vi.fn<MissionEntryClient["submit"]>(async () => ({
      missionId: "mission-exact",
      state: "CREATED",
      readiness: "READY",
    }));

    await expect(submitMissionObjective(objective, { submit })).resolves.toBe("mission-exact");
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(objective);
  });

  it("rejects empty and whitespace-only input before calling the adapter", async () => {
    const submit = vi.fn<MissionEntryClient["submit"]>();

    await expect(submitMissionObjective("", { submit })).rejects.toThrow(
      "Un objectif non vide est requis.",
    );
    await expect(submitMissionObjective(" \n\t ", { submit })).rejects.toThrow(
      "Un objectif non vide est requis.",
    );
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("cockpit adapter consumption", () => {
  it("reads supervisor and capability snapshots through the declared clients", async () => {
    const supervisorClient: SupervisorStateClient = {
      read: vi.fn<SupervisorStateClient["read"]>(async (missionId) => ({
        missionId,
        objective: "Objectif",
        missionState: "CREATED",
        tasks: [],
        workers: [],
        blockers: [],
        errors: [],
        mergePerformed: false,
        productionDeploymentPerformed: false,
      })),
    };
    const capabilityClient: CapabilitySnapshotClient = {
      read: vi.fn(async () => []),
    };
    const missionEntryClient: MissionEntryClient = {
      submit: vi.fn(),
    };
    const clients: CockpitClients = {
      missionEntryClient,
      capabilityClient,
      supervisorClient,
    };

    const result = await readCockpitState(clients, "mission-read");

    expect(supervisorClient.read).toHaveBeenCalledWith("mission-read");
    expect(capabilityClient.read).toHaveBeenCalledWith("mission-read");
    expect(result.snapshot.missionId).toBe("mission-read");
  });
});

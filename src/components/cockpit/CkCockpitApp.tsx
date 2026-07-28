"use client";

import { useEffect, useMemo, useState } from "react";

import { CkSupervisorSurface } from "@/components/cockpit/CkSupervisorSurface";
import type {
  CapabilitySnapshotClient,
  CapabilityViewSnapshot,
  CockpitSupervisorSnapshot,
  MissionEntryClient,
  SupervisorStateClient,
} from "@/features/cockpit/clients";
import {
  createDevelopmentCockpitClients,
  type DevelopmentCockpitClients,
} from "@/features/cockpit/development-adapters";

export interface CockpitClients {
  missionEntryClient: MissionEntryClient;
  capabilityClient: CapabilitySnapshotClient;
  supervisorClient: SupervisorStateClient;
}

export async function submitMissionObjective(
  objective: string,
  client: MissionEntryClient,
): Promise<string> {
  if (objective.trim().length === 0) {
    throw new Error("Un objectif non vide est requis.");
  }
  const mission = await client.submit(objective);
  return mission.missionId;
}

export async function readCockpitState(clients: CockpitClients, missionId: string) {
  const [snapshot, capabilities] = await Promise.all([
    clients.supervisorClient.read(missionId),
    clients.capabilityClient.read(missionId),
  ]);
  return { snapshot, capabilities };
}

export function CkCockpitApp() {
  const development = useMemo<DevelopmentCockpitClients>(
    () => createDevelopmentCockpitClients(),
    [],
  );
  return (
    <CkCockpitClient
      clients={development}
      initialMissionId={development.initialMissionId}
      dataLabel={development.dataLabel}
    />
  );
}

interface CkCockpitClientProps {
  clients: CockpitClients;
  initialMissionId: string;
  dataLabel: string;
}

export function CkCockpitClient({ clients, initialMissionId, dataLabel }: CkCockpitClientProps) {
  const [snapshot, setSnapshot] = useState<CockpitSupervisorSnapshot>();
  const [capabilities, setCapabilities] = useState<readonly CapabilityViewSnapshot[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    readCockpitState(clients, initialMissionId)
      .then(({ snapshot: nextSnapshot, capabilities: nextCapabilities }) => {
        if (!current) return;
        setSnapshot(nextSnapshot);
        setCapabilities(nextCapabilities);
      })
      .catch((reason: unknown) => {
        if (current) setError(toErrorMessage(reason));
      });
    return () => {
      current = false;
    };
  }, [clients, initialMissionId]);

  async function handleSubmit(objective: string) {
    setError(undefined);
    try {
      const missionId = await submitMissionObjective(objective, clients.missionEntryClient);
      const next = await readCockpitState(clients, missionId);
      setSnapshot(next.snapshot);
      setCapabilities(next.capabilities);
    } catch (reason) {
      setError(toErrorMessage(reason));
    }
  }

  if (!snapshot) {
    return (
      <main className="ck-loading-state">
        <p>{dataLabel}</p>
        <p role={error ? "alert" : "status"}>{error ?? "Chargement de la supervision…"}</p>
      </main>
    );
  }

  return (
    <CkSupervisorSurface
      snapshot={snapshot}
      capabilities={capabilities}
      dataLabel={dataLabel}
      onSubmitObjective={handleSubmit}
      submitError={error}
    />
  );
}

function toErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "La lecture locale a échoué.";
}

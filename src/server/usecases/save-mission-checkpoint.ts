import { randomUUID } from "node:crypto";
import type { MissionRepository } from "@/server/mission/ports";
import type { DurableMemory } from "@/core/context/durable-memory";
import type { Mission, MissionTask } from "@/core/mission/contracts";
import type { Checkpoint } from "@/core/context/contracts";

export interface SaveMissionCheckpointInput {
  missionId: string;
  label?: string;
}

export interface SaveMissionCheckpointOutcome {
  ok: boolean;
  checkpointId?: string;
  reason?: string;
  message?: string;
}

export async function saveMissionCheckpoint(
  deps: {
    missions: MissionRepository;
    durableMemory: DurableMemory;
  },
  input: SaveMissionCheckpointInput,
): Promise<SaveMissionCheckpointOutcome> {
  const mission = await deps.missions.findById(input.missionId);
  if (!mission) {
    return {
      ok: false,
      reason: "mission_not_found",
      message: `Mission not found: ${input.missionId}`,
    };
  }

  const tasks = await deps.missions.listTasks(input.missionId);

  const checkpointId = randomUUID();
  const label = input.label ?? `Checkpoint at ${new Date().toISOString()}`;

  // Build a checkpoint object conforming to the Checkpoint schema
  const checkpoint: Checkpoint = {
    id: checkpointId,
    missionId: mission.id,
    label,
    createdAt: new Date().toISOString(),
    version: 1,
    mission: {
      id: mission.id,
      title: mission.title,
      objective: mission.objective,
      status: mission.status,
      createdAt: mission.createdAt.toISOString(),
      updatedAt: mission.updatedAt?.toISOString() ?? null,
    },
    tasks: tasks.map((t) => ({
      id: t.id,
      missionId: t.missionId,
      title: t.title,
      description: t.description,
      dependsOn: t.dependsOn,
      status: t.status,
      workerKind: t.workerKind,
      capability: t.capability,
      taskId: t.taskId,
    })),
    taskResults: undefined,
    decisions: undefined,
    artifacts: undefined,
    evidence: undefined,
    errors: undefined,
    tokenCount: undefined,
    compressed: false,
  };

  await deps.durableMemory.saveCheckpoint(checkpoint);

  return {
    ok: true,
    checkpointId,
    message: `Checkpoint saved: ${label}`,
  };
}

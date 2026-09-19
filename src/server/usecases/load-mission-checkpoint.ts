import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { DurableMemory } from "@/core/context/durable-memory";
import type { Mission, MissionTask } from "@/core/mission/contracts";
import type { Task } from "@/core/contracts";
import type { Checkpoint } from "@/core/context/contracts";

export interface LoadMissionCheckpointInput {
  missionId: string;
}

export interface LoadMissionCheckpointOutcome {
  ok: boolean;
  checkpointId?: string;
  reason?: string;
  message?: string;
  restoredMission?: Mission;
  restoredTasks?: MissionTask[];
}

const STATUS_PROGRESS: Record<string, number> = {
  draft: 0,
  queued: 1,
  running: 2,
  awaiting_approval: 3,
  succeeded: 4,
  failed: 4,
  blocked: 4,
};

function mostAdvancedStatus<T extends string>(
  current: T,
  checkpoint: T,
): T {
  const currentRank = STATUS_PROGRESS[current] ?? 0;
  const checkpointRank = STATUS_PROGRESS[checkpoint] ?? 0;

  return checkpointRank > currentRank
    ? checkpoint
    : current;
}

/**
 * Load the latest checkpoint for a mission and restore the mission and task state.
 * This is used for restart recovery.
 */
export async function loadMissionCheckpoint(
  deps: {
    missions: MissionRepository;
    tasks: TaskRepository;
    durableMemory: DurableMemory;
  },
  input: LoadMissionCheckpointInput,
): Promise<LoadMissionCheckpointOutcome> {
  const { missionId } = input;

  // Get the latest checkpoint for this mission
  const checkpoints = await deps.durableMemory.getCheckpoints(missionId);
  if (!checkpoints || checkpoints.length === 0) {
    return {
      ok: false,
      reason: "no_checkpoint_found",
      message: `No checkpoint found for mission: ${missionId}`,
    };
  }

  const latest = checkpoints[0]; // already sorted descending by createdAt


  const missionState = latest.mission;
  const tasksState = latest.tasks;

  // Repository state may have advanced after this checkpoint was saved.
  // Recovery must never rewind durable PostgreSQL state.
  const currentMission = await deps.missions.findById(missionId);
  const currentTasks = await deps.missions.listTasks(missionId);
  const currentTaskById = new Map(
    currentTasks.map((task) => [task.id, task]),
  );

  // Restore mission
  const mission: Mission = {
    id: missionState.id,
    title: missionState.title,
    objective: missionState.objective,
    status: currentMission
      ? mostAdvancedStatus(
          currentMission.status,
          missionState.status as Mission["status"],
        )
      : (missionState.status as Mission["status"]),
    createdAt: new Date(missionState.createdAt),
    updatedAt: new Date(missionState.updatedAt ?? missionState.createdAt),
  };

  // Restore tasks (MissionTask objects)
  const tasks: MissionTask[] = tasksState.map((t: (typeof tasksState)[number]) => {
    const checkpointStatus = t.status as MissionTask["status"];
    const currentTask = currentTaskById.get(t.id);

    return {
      id: t.id,
      missionId: t.missionId,
      title: t.title,
      description: t.description,
      dependsOn: t.dependsOn,
      status: currentTask
        ? mostAdvancedStatus(
            currentTask.status,
            checkpointStatus,
          )
        : checkpointStatus,
      workerKind: t.workerKind,
      capability: t.capability,
      taskId: t.taskId,
    };
  });

  // Update the mission in the repository
  await deps.missions.updateMission(mission.id, mission);

  // Update each task in the missionTasks table (via mission repository)
  for (const task of tasks) {
    // Update dependsOn and status
    await deps.missions.updateMissionTaskDependsOn(task.id, task.dependsOn);
    await deps.missions.updateMissionTaskStatus(task.missionId, task.id, task.status);
  }

  return {
    ok: true,
    checkpointId: latest.id,
    restoredMission: mission,
    restoredTasks: tasks,
  };
}

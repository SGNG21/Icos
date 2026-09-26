import type { MissionRepository } from "@/server/mission/ports";
import type { Mission, MissionTask } from "@/core/mission/contracts";
import { isValidMissionTransition } from "@/core/mission/machine";
import type { CreateMissionInput } from "@/core/mission/contracts";
import type {
  MissionPlan,
} from "@/server/mission/mission-plan";
import {
  validateMissionPlan,
} from "@/server/mission/mission-plan";

export class MissionService {
  constructor(private readonly missionRepository: MissionRepository) {};

  async createMission(input: CreateMissionInput): Promise<Mission> {
    // Validation graph
    this.validateGraph(input.tasks);

    return this.missionRepository.create(input);
  }

  async applyPlan(
    missionId: string,
    plan: MissionPlan,
  ): Promise<MissionTask[]> {
    validateMissionPlan(plan);

    const mission =
      await this.missionRepository.findById(
        missionId,
      );

    if (!mission) {
      throw new Error(
        `MISSION_NOT_FOUND:${missionId}`,
      );
    }

    return this.missionRepository.applyPlan(
      missionId,
      plan,
    );
  }

  async getMission(id: string): Promise<Mission | null> {
    return this.missionRepository.findById(id);
  }

  async getTasks(missionId: string): Promise<MissionTask[]> {
    return this.missionRepository.listTasks(missionId);
  }

  /**
   * Validation déterministe obligatoire du WorkGraph :
   * - dépendance inconnue interdite
   * - self-dependency interdite
   * - cycle interdit
   */
  private validateGraph(tasks: Omit<MissionTask, "id" | "missionId" | "status" | "taskId">[]) {
    const titles = new Set(tasks.map((t) => t.title));

    for (const task of tasks) {
      // 1. Self-dependency
      if (task.dependsOn.includes(task.title)) {
        throw new Error(`Self-dependency forbidden on task: ${task.title}`);
      }

      // 2. Unknown dependency
      for (const dep of task.dependsOn) {
        if (!titles.has(dep)) {
          throw new Error(`Unknown dependency: "${dep}" for task "${task.title}"`);
        }
      }
    }

    // 3. Cycle detection
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const hasCycle = (node: string): boolean => {
      if (recStack.has(node)) return true;
      if (visited.has(node)) return false;

      visited.add(node);
      recStack.add(node);

      const task = tasks.find((t) => t.title === node);
      if (task) {
        for (const dep of task.dependsOn) {
          if (hasCycle(dep)) return true;
        }
      }

      recStack.delete(node);
      return false;
    };

    for (const task of tasks) {
      if (hasCycle(task.title)) {
        throw new Error("Cycle detected in task dependencies!");
      }
    }
  }

  async updateMissionStatus(missionId: string, status: Mission["status"]): Promise<void> {
    const mission = await this.missionRepository.findById(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }

    const currentStatus = mission.status;
    if (!isValidMissionTransition(currentStatus, status)) {
      throw new Error(`Invalid mission status transition from ${currentStatus} to ${status}`);
    }

    // Create a new mission object with updated status
    const updatedMission: Mission = {
      ...mission,
      status,
      updatedAt: new Date(),
    };
    await this.missionRepository.updateMission(missionId, updatedMission);
  }

  // Note: We need to add an update method to the MissionRepository interface.
  // But for now, let's assume we have an update method in the repository.
  // We'll update the repository interface separately.

  // For completeness, let's also update the updateMissionTaskStatus method to validate task status transitions?
  // However, task status transitions are defined in task.ts and we might want to validate there too.
  // But we can leave that for later or assume the repository handles it.
  // We'll focus on mission status for now.

  // We'll also need to add a method to update the mission in the repository.
  // Let's update the MissionRepository interface to include an update method.
  // We'll do that in a separate step.
}

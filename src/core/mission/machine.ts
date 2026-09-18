import { z } from "zod";
import { MissionStatusSchema } from "./contracts";

export type MissionStatus = z.infer<typeof MissionStatusSchema>;

/**
 * Defines the allowed transitions for mission status.
 * The keys are the current status, and the values are arrays of allowed next statuses.
 */
export const missionStatusTransitions: Record<MissionStatus, MissionStatus[]> = {
  draft: ["planning", "cancelled"],
  planning: ["ready", "cancelled"],
  ready: ["running", "blocked", "cancelled"],
  running: ["blocked", "awaiting_approval", "succeeded", "failed", "cancelled"],
  blocked: ["ready", "running", "cancelled"],
  awaiting_approval: ["running", "blocked", "failed", "cancelled"],
  succeeded: [], // terminal
  failed: [], // terminal
  cancelled: [], // terminal
};

/**
 * Validates whether a transition from currentStatus to nextStatus is allowed.
 * @param currentStatus - The current mission status
 * @param nextStatus - The desired next mission status
 * @returns true if the transition is allowed, false otherwise
 */
export function isValidMissionTransition(
  currentStatus: MissionStatus,
  nextStatus: MissionStatus,
): boolean {
  const allowedNext = missionStatusTransitions[currentStatus];
  return allowedNext.includes(nextStatus);
}

/**
 * Returns the list of allowed next statuses for a given current status.
 * @param currentStatus - The current mission status
 * @returns Array of allowed next statuses
 */
export function getAllowedNextStatuses(currentStatus: MissionStatus): MissionStatus[] {
  return missionStatusTransitions[currentStatus];
}

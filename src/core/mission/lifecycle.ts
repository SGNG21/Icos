import type { MissionStatus } from "./contract";
import { TERMINAL_STATUSES } from "./contract";

/**
 * Transitions valides entre états de mission.
 * La clé est l'état source, la valeur est l'ensemble des états cibles autorisés.
 */
const VALID_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  CREATED: ["PLANNING", "FAILED"],
  PLANNING: ["PLANNED", "FAILED"],
  PLANNED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: [
    "COMPLETED",
    "FAILED",
    "WAITING_FOR_APPROVAL",
    "BLOCKED_BY_POLICY",
    "PROVIDER_UNAVAILABLE",
    "TOOL_FAILED",
    "SKILL_REVOKED",
    "STALE_ATTESTATION",
    "MISSION_RECOVERABLE",
  ],
  WAITING_FOR_APPROVAL: ["IN_PROGRESS", "CANCELLED"],
  BLOCKED_BY_POLICY: ["IN_PROGRESS", "CANCELLED", "FAILED"],
  PROVIDER_UNAVAILABLE: ["IN_PROGRESS", "FAILED", "CANCELLED"],
  TOOL_FAILED: ["IN_PROGRESS", "FAILED", "CANCELLED"],
  SKILL_REVOKED: ["FAILED"],
  STALE_ATTESTATION: ["WAITING_FOR_APPROVAL", "FAILED"],
  MISSION_RECOVERABLE: ["IN_PROGRESS", "CANCELLED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/**
 * Vérifie si une transition est autorisée par la machine d'état.
 */
export function isTransitionAllowed(
  from: MissionStatus,
  to: MissionStatus,
): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) {
    return false;
  }
  return allowed.includes(to);
}

/**
 * Retourne les transitions autorisées depuis un état donné.
 */
export function allowedTransitionsFrom(status: MissionStatus): readonly MissionStatus[] {
  return VALID_TRANSITIONS[status] ?? [];
}

/**
 * Vrai si l'état est terminal.
 */
export function isTerminal(status: MissionStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Vrai si l'état est suspendu (en attente d'événement externe).
 */
export function isSuspended(status: MissionStatus): boolean {
  const suspended = [
    "WAITING_FOR_APPROVAL",
    "BLOCKED_BY_POLICY",
    "PROVIDER_UNAVAILABLE",
    "TOOL_FAILED",
    "STALE_ATTESTATION",
    "MISSION_RECOVERABLE",
    "SKILL_REVOKED",
  ] as readonly string[];
  return suspended.includes(status);
}

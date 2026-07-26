// ─────────────────────────────────────
// Cockpit Mappers — Contract → UI view model
// Pure mapping functions — no mock access, no side effects
// ─────────────────────────────────────

import type { AgentAction } from "@/core/contracts";
import type { Mission } from "@/core/mission";

import type {
  ArtifactDisplay,
  ArtifactType,
  ChatMessage,
  MissionHistoryItem,
} from "@/features/cockpit/types";

// ─────────────────────────────────────
// ArtifactRef — future backend model from Run output
// Defined locally as a stub until the backend contract is available.
// Do NOT confuse with ExternalReference or Error.
// ─────────────────────────────────────

export interface ArtifactRef {
  id: string;
  type: string;
  name: string;
  sizeBytes?: number;
  description?: string;
}

// ─────────────────────────────────────
// Mapper: Mission → MissionHistoryItem
// ─────────────────────────────────────

/**
 * Convert a backend Mission to a UI MissionHistoryItem.
 * Uses only fields confirmed present in the Mission Zod schema.
 */
export function missionToHistoryItem(mission: Mission): MissionHistoryItem {
  const completedSteps = mission.runs?.filter(
    (r) => r.status === "completed",
  ).length;

  return {
    id: mission.id,
    status: mission.status,
    userRequest: mission.userRequest,
    totalSteps: mission.plan?.totalSteps ?? mission.plan?.steps.length ?? undefined,
    completedSteps: completedSteps > 0 ? completedSteps : undefined,
    error: mission.error,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    completedAt: mission.completedAt,
  };
}

// ─────────────────────────────────────
// Mapper: ArtifactRef → ArtifactDisplay (stub for future)
// ─────────────────────────────────────

const ARTIFACT_TYPE_MAP: Record<string, ArtifactType> = {
  document: "document",
  data: "data",
  code: "code",
  image: "image",
  link: "link",
};

/**
 * Convert a future ArtifactRef to an ArtifactDisplay view model.
 *
 * In V1, ArtifactRef doesn't exist as a backend type yet. This mapper is
 * structurally ready — it receives mock-compatible data and produces correct
 * UI models. When the backend delivers real ArtifactRef objects, this function
 * remains the same pipeline step.
 *
 * Unknown artifact types are mapped to "document" as a safe default.
 */
export function artifactRefToDisplay(ref: ArtifactRef): ArtifactDisplay {
  return {
    id: ref.id,
    type: ARTIFACT_TYPE_MAP[ref.type] ?? "document",
    displayName: ref.name,
    originalName: ref.name,
    sizeBytes: ref.sizeBytes,
    description: ref.description,
  };
}

// ─────────────────────────────────────
// Mapper: AgentAction → ChatMessage (approval in-flow card)
// ─────────────────────────────────────

/**
 * Convert a pending AgentAction to a ChatMessage with role "approval".
 * The AgentAction is stored in the payload for the approval card component.
 */
export function actionToApprovalCard(action: AgentAction): ChatMessage {
  return {
    id: `approval-${action.id}`,
    role: "approval",
    payload: action,
    timestamp: action.requestedAt,
  };
}

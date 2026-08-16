import type { Mission, MissionStatus } from "@/core/mission";
import type { AgentAction } from "@/core/contracts";

// ─────────────────────────────────────
// Cockpit UI View Models
// These are frontend-specific types, NOT backend contracts.
// No Zod schemas — plain TypeScript interfaces.
// ─────────────────────────────────────

/**
 * Artifact types displayed in results.
 */
export type ArtifactType = "document" | "data" | "code" | "image" | "link";

/**
 * View model for artifact display in the conversation flow.
 * Pipeline: ArtifactRef (backend) → mapper → ArtifactDisplay → UI.
 * ArtifactDisplay is NOT an Error and NOT an ExternalReference.
 */
export interface ArtifactDisplay {
  id: string;
  type: ArtifactType;
  /** User-facing name, e.g. "Rapport d'analyse" */
  displayName: string;
  /** Original filename, e.g. "output_step3.json" — preserves identity */
  originalName: string;
  /** Raw byte count (formatted by UI via formatSizeBytes) */
  sizeBytes?: number;
  /** Optional description */
  description?: string;
}

/**
 * Activity item status for the timeline.
 */
export type ActivityStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

/**
 * A single step event in the activity timeline.
 * Each item represents one significant event — not technical logs.
 */
export interface ActivityItem {
  /** 0-based step index */
  stepIndex: number;
  /** User-facing label, e.g. "Plan généré" (no agent names) */
  label: string;
  /** Optional description or additional context */
  description?: string;
  status: ActivityStatus;
  /** Reason code for skipped steps */
  skipReasonCode?: string;
  /** Human-readable skip reason */
  skipReason?: string;
  /** Duration in milliseconds (formatted by UI) */
  durationMs?: number;
  /** ISO 8601 start timestamp */
  startedAt?: string;
  /** ISO 8601 completion timestamp */
  completedAt?: string;
}

/**
 * Message roles in the conversation flow.
 */
export type MessageRole =
  "user" | "icos" | "thinking" | "mission-progress" | "approval" | "activity" | "result" | "error";

/**
 * A single message in the conversation history.
 * The payload field carries data for in-flow cards depending on role.
 */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  /** Text content for user/icos/error messages */
  content?: string;
  /** Action label for error messages, e.g. "Réessayer" */
  errorLabel?: string;
  /** Data for in-flow cards: Mission, AgentAction, ActivityItem[], ArtifactDisplay[] */
  payload?: unknown;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Generic in-flow card wrapper data.
 * Carries the variant identification for rendering.
 */
export interface InFlowCard {
  /** Card title, e.g. "Mission progress", "🔐 Approbation requise" */
  title: string;
  /** Optional icon */
  icon?: string;
  variant: "mission" | "approval" | "activity" | "result";
}

/**
 * Subset of Mission for history display.
 * Contains only the fields needed for the history list UI.
 */
export interface MissionHistoryItem {
  id: string;
  status: MissionStatus;
  userRequest: string;
  totalSteps?: number;
  completedSteps?: number;
  /** Error message for failed/cancelled missions */
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/**
 * Lightweight project info for the project selector dropdown.
 * These are purely visual mocks — Project ≠ Workspace ≠ Client ≠ Tenant.
 */
export interface ProjectInfo {
  id: string;
  displayName: string;
  active: boolean;
}

/**
 * In-memory store shape.
 * All state lives in a plain object — no React state library needed for V1.
 */
export interface CockpitStore {
  messages: ChatMessage[];
  activeMission: Mission | null;
  history: MissionHistoryItem[];
  approvals: AgentAction[];
  projects: ProjectInfo[];
  activeProjectId: string;

  // Actions
  addMessage(msg: ChatMessage): void;
  setActiveMission(m: Mission | null): void;
  setActiveProject(id: string): void;
  resolveApproval(actionId: string, decision: "approved" | "rejected"): void;
}

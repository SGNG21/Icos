import type { NodeStatus } from "@/features/cockpit/dag";
import type { Tone } from "@/features/cockpit/snapshot";

export const NODE_TONE: Record<NodeStatus, Tone> = {
  PENDING: "unknown",
  READY: "flow",
  CLAIMED: "flow",
  DISPATCHED: "flow",
  RUNNING: "ok",
  VALIDATING: "flow",
  AWAITING_REVIEW: "warn",
  REPAIR_REQUIRED: "warn",
  READY_FOR_INTEGRATION: "autonomy",
  INTEGRATING: "autonomy",
  COMPLETED: "ok",
  FAILED_RETRYABLE: "warn",
  FAILED_TERMINAL: "critical",
  ESCALATED: "critical",
  QUARANTINED: "critical",
  SUPERSEDED: "unknown",
  BLOCKED: "critical",
  CANCELLED: "unknown",
};

export const nodeLabel = (s: NodeStatus) => s.replaceAll("_", " ");

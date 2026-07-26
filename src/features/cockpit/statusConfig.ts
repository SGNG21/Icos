import type { MissionStatus } from "@/core/mission";
import type { RiskLevel } from "@/core/contracts";

// ─────────────────────────────────────
// Status mapping — MissionStatus → UI view
// ─────────────────────────────────────

export interface StatusConfigItem {
  /** User-facing label, e.g. "En cours", "Suspendue — Fournisseur indisponible" */
  label: string;
  /** Icon character, e.g. "●", "◉", "⚠", "✅", "❌", "—" */
  icon: string;
  /** CSS color class suffix (no leading dot), e.g. "forest", "amber", "mint" */
  color: string;
  /** Full CSS class name for the status dot/bar, e.g. "status-in-progress" */
  cssClass: string;
}

export interface RiskConfigItem {
  label: string;
  cssClass: string;
}

/**
 * MissionStatus → UI mapping.
 *
 * Extensible record: add a new entry when the backend introduces a new status.
 * Recovery statuses (PROVIDER_UNAVAILABLE through MISSION_RECOVERABLE) share
 * the main label "Suspendue" with a distinct sub-status visible immediately.
 */
export const statusConfig: Record<MissionStatus, StatusConfigItem> = {
  CREATED: {
    label: "Créée",
    icon: "○",
    color: "muted",
    cssClass: "status-created",
  },
  PLANNING: {
    label: "Planification",
    icon: "◌",
    color: "muted",
    cssClass: "status-planning",
  },
  PLANNED: {
    label: "Planifiée",
    icon: "○",
    color: "muted",
    cssClass: "status-planned",
  },
  IN_PROGRESS: {
    label: "En cours",
    icon: "●",
    color: "forest",
    cssClass: "status-in-progress",
  },
  WAITING_FOR_APPROVAL: {
    label: "Requiert approbation",
    icon: "◉",
    color: "amber",
    cssClass: "status-waiting-approval",
  },
  BLOCKED_BY_POLICY: {
    label: "Bloquée",
    icon: "⊘",
    color: "red-orange",
    cssClass: "status-blocked-policy",
  },
  PROVIDER_UNAVAILABLE: {
    label: "Suspendue — Fournisseur indisponible",
    icon: "⚠",
    color: "amber",
    cssClass: "status-suspended-provider",
  },
  TOOL_FAILED: {
    label: "Suspendue — Outil indisponible",
    icon: "⚠",
    color: "amber",
    cssClass: "status-suspended-tool",
  },
  SKILL_REVOKED: {
    label: "Suspendue — Compétence révoquée",
    icon: "⚠",
    color: "amber",
    cssClass: "status-suspended-skill",
  },
  STALE_ATTESTATION: {
    label: "Suspendue — Attestation expirée",
    icon: "⚠",
    color: "amber",
    cssClass: "status-suspended-attestation",
  },
  MISSION_RECOVERABLE: {
    label: "Suspendue — Récupérable",
    icon: "⚠",
    color: "amber",
    cssClass: "status-suspended-recoverable",
  },
  COMPLETED: {
    label: "Terminée",
    icon: "✅",
    color: "mint",
    cssClass: "status-completed",
  },
  FAILED: {
    label: "Échouée",
    icon: "❌",
    color: "red",
    cssClass: "status-failed",
  },
  CANCELLED: {
    label: "Annulée",
    icon: "—",
    color: "muted",
    cssClass: "status-cancelled",
  },
};

/**
 * RiskLevel → human-readable label.
 * Extensible record — add entries when the backend adds new risk levels.
 */
export const riskLabelMap: Record<RiskLevel, string> = {
  read_only: "Lecture seule",
  reversible: "Réversible",
  sensitive: "Sensible",
};

/**
 * RiskLevel → UI chip config.
 * Extensible record — add entries when the backend adds new risk levels.
 */
export const riskStyleMap: Record<string, RiskConfigItem> = {
  read_only: { label: "Lecture seule", cssClass: "risk-read-only" },
  reversible: { label: "Réversible", cssClass: "risk-reversible" },
  sensitive: { label: "Sensible", cssClass: "risk-sensitive" },
};

/**
 * Safe accessor — returns config for a given MissionStatus.
 * Always returns a config entry; if the status is unknown, returns a fallback
 * to ensure the UI never breaks on new backend statuses.
 */
export function getStatusConfig(status: MissionStatus): StatusConfigItem {
  return statusConfig[status] ?? {
    label: String(status),
    icon: "?",
    color: "muted",
    cssClass: "status-unknown",
  };
}

/**
 * Safe accessor — returns risk chip config for a given RiskLevel.
 * Falls back to a label derived from the raw risk value for unknown levels.
 */
export function getRiskConfig(risk: RiskLevel): RiskConfigItem {
  return riskStyleMap[risk] ?? {
    label: riskLabelMap[risk] ?? String(risk),
    cssClass: "risk-unknown",
  };
}

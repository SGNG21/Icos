import type { TaskStatus, WorkerKind } from "@/core/contracts";

/**
 * Représentation visuelle des statuts métier officiels. Le frontend ne définit
 * AUCUN statut : il ne fait que rendre la vérité ICOS.
 */
export type StatusTone = "neutral" | "progress" | "attention" | "positive" | "negative";

export interface StatusPresentation {
  label: string;
  tone: StatusTone;
  /** Explication courte affichée en info-bulle. */
  hint: string;
}

export const taskStatusPresentation: Record<TaskStatus, StatusPresentation> = {
  draft: {
    label: "Brouillon",
    tone: "neutral",
    hint: "Créée, pas encore prise en charge par le moteur d’exécution.",
  },
  queued: {
    label: "En file",
    tone: "progress",
    hint: "Prise en charge par le moteur d’exécution durable, en attente d’un worker.",
  },
  awaiting_approval: {
    label: "À valider",
    tone: "attention",
    hint: "Bloquée : une validation humaine est requise.",
  },
  running: {
    label: "En cours",
    tone: "progress",
    hint: "Un worker exécute réellement le travail.",
  },
  review_pending: {
    label: "En revue",
    tone: "progress",
    hint: "L’exécution est terminée mais attend une décision de qualité durable.",
  },
  succeeded: {
    label: "Réussie",
    tone: "positive",
    hint: "Terminée avec un résultat métier enregistré.",
  },
  failed: {
    label: "Échouée",
    tone: "negative",
    hint: "Terminée en erreur ; une erreur métier exploitable est enregistrée.",
  },
  cancelled: {
    label: "Annulée",
    tone: "neutral",
    hint: "Interrompue avant terme.",
  },
};

/** Ordre d'affichage opérationnel : ce qui bloque d'abord. */
export const statusPriority: readonly TaskStatus[] = [
  "failed",
  "awaiting_approval",
  "running",
  "review_pending",
  "queued",
  "draft",
  "succeeded",
  "cancelled",
];

/**
 * Libellés des workers. La structure distingue déjà les workers futurs
 * (OpenHands) sans que leur intégration soit réalisée : le Cockpit affichera
 * simplement le worker réellement rapporté par la boucle d'exécution.
 */
export const workerKindLabel: Record<WorkerKind, string> = {
  hermes: "Hermes",
  openhands: "OpenHands",
  digitalos: "DigitalOS",
  other: "Worker externe",
  agent: "Agent",
};

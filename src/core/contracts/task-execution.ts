import { z } from "zod";

import { idSchema, isoDateTimeSchema } from "./common";

/**
 * Résultat canonique d'exécution d'une tâche (preuve métier ICOS).
 *
 * Frontière de responsabilité :
 * - Temporal conserve l'historique mécanique complet (events, retries, timers) ;
 * - ICOS conserve la PREUVE MÉTIER utile : issue, résultat exploitable, erreur
 *   normalisée, corrélation `taskId` ↔ `workflowId`.
 *
 * Ne JAMAIS y placer de secret, cookie, en-tête, credential, prompt système
 * privé ni trace interne complète : ce contrat est exposé au Cockpit.
 */

/** Identifiant de workflow durable côté moteur d'exécution (Temporal). */
export const workflowIdSchema = z.string().min(1).max(255);

/** Issue métier d'une exécution. Aucun état implicite : succès explicite requis. */
export const executionOutcomeSchema = z.enum(["success", "failure"]);

/**
 * Codes d'erreur normalisés et exploitables métier. `UNKNOWN_EFFECT` est
 * explicite et ne doit jamais être masqué en succès (fail-closed).
 */
export const executionErrorCodeSchema = z.enum([
  "WORKER_FAILED",
  "WORKER_TIMEOUT",
  "WORKER_UNAVAILABLE",
  "INVALID_RESULT",
  "UNKNOWN_EFFECT",
  "CANCELLED",
  "INTERNAL_ERROR",
]);

/** Erreur métier normalisée. `message` est un résumé court, jamais une stack. */
export const executionErrorSchema = z
  .object({
    code: executionErrorCodeSchema,
    message: z.string().min(1).max(2_000),
  })
  .strict();

/** Nature du worker ayant exécuté le travail (traçabilité de la chaîne). */
export const workerKindSchema = z.enum(["hermes", "openhands", "digitalos", "other", "agent"]);

/**
 * Artefact produit par l'exécution (fichier, URL, etc.)
 */
export const artifactSchema = z.object({
  type: z.string(),
  path: z.string().optional(),
  url: z.string().url().optional(),
  mediaType: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Artifact = z.infer<typeof artifactSchema>;

/**
 * Preuve d'exécution (rapport, journal, métrique)
 */
export const evidenceSchema = z.object({
  type: z.string(),
  source: z.string(),
  path: z.string().optional(),
  url: z.string().url().optional(),
  timestamp: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Evidence = z.infer<typeof evidenceSchema>;

/**
 * Finding normalisé (gate, healer, etc.)
 */
export const findingSchema = z.object({
  severity: z.enum(["PASS", "WARN", "BLOCK"]),
  check: z.string(),
  message: z.string(),
  where: z.string().optional(),
  category: z.string().optional(),
  repairability: z.enum(["auto", "content", "human"]).optional(),
});

export type Finding = z.infer<typeof findingSchema>;

export type RecordTaskExecutionResultInput = {
  taskId: string;
  workflowId: string;
  outcome: ExecutionOutcome;
  workerKind?: WorkerKind;
  capability?: string;
  digitalosExecutionId?: string;
  result?: string;
  error?: ExecutionError;
  startedAt?: string;
  completedAt: string;
  artifacts?: Artifact[];
  evidence?: Evidence[];
  findings?: Finding[];
};

export type RecordTaskExecutionResultOutcome =
  | { ok: true; record: TaskExecutionResult; duplicate: boolean }
  | { ok: false; reason: "invalid_input" | "task_not_found" | "audit_failed"; message: string };

/**
 * Taille maximale du résultat conservé côté ICOS. Au-delà, l'appelant doit
 * tronquer explicitement : ICOS n'est pas un magasin d'artefacts volumineux.
 */
export const EXECUTION_RESULT_MAX_LENGTH = 20_000;

export const taskExecutionResultSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    /** Corrélation avec la mécanique durable. Clé d'idempotence du retour. */
    workflowId: workflowIdSchema,
    outcome: executionOutcomeSchema,
    /** Worker ayant produit le résultat, si connu. */
    workerKind: workerKindSchema.optional(),
    /** Capacité exécutée (ex: website.build, website.qa) */
    capability: z.string().optional(),
    /** Identifiant d'exécution DigitalOS (si worker digitalos) */
    digitalosExecutionId: z.string().optional(),
    /** Résultat métier exploitable (texte). Absent en cas d'échec. */
    result: z.string().max(EXECUTION_RESULT_MAX_LENGTH).optional(),
    /** Erreur normalisée. Obligatoire en cas d'échec (voir `refine`). */
    error: executionErrorSchema.optional(),
    /** Début réel du travail côté worker, si connu. */
    startedAt: isoDateTimeSchema.optional(),
    /** Fin de l'exécution telle que rapportée. */
    completedAt: isoDateTimeSchema,
    /** Date d'enregistrement canonique côté ICOS. */
    recordedAt: isoDateTimeSchema,
    /** Artefacts produits (config, build output, preview URL, etc.) */
    artifacts: z.array(artifactSchema).optional(),
    /** Preuves d'exécution (gate report, healer journal, preview metadata) */
    evidence: z.array(evidenceSchema).optional(),
    /** Findings normalisés (gate critiques, healer actions) */
    findings: z.array(findingSchema).optional(),
    /** Observations libres (ex: métriques, journaux) */
    observations: z.array(z.unknown()).optional(),
    /** Niveau de confiance de l'exécution (0-1) */
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine((value) => value.outcome !== "failure" || value.error !== undefined, {
    message: "un échec doit porter une erreur normalisée",
    path: ["error"],
  })
  .refine((value) => value.outcome !== "success" || value.error === undefined, {
    message: "un succès ne peut pas porter d'erreur",
    path: ["error"],
  });

export type ExecutionOutcome = z.infer<typeof executionOutcomeSchema>;
export type ExecutionErrorCode = z.infer<typeof executionErrorCodeSchema>;
export type ExecutionError = z.infer<typeof executionErrorSchema>;
export type WorkerKind = z.infer<typeof workerKindSchema>;
export type TaskExecutionResult = z.infer<typeof taskExecutionResultSchema>;

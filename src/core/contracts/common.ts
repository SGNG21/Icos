import { z } from "zod";

/**
 * Identifiant métier : minuscules, chiffres, tirets ou underscores, 3 caractères minimum.
 * Exemples valides : `agent-cto`, `task-001`.
 */
export const idSchema = z
  .string()
  .min(3)
  .regex(/^[a-z0-9][a-z0-9_-]+$/, "identifiant invalide (minuscules, chiffres, - ou _)");

/** Horodatage ISO 8601 complet, avec décalage horaire explicite ou UTC. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * Niveau de risque d'une action :
 * - `read_only` : aucune modification d'état externe ;
 * - `reversible` : modification annulable par une opération inverse connue ;
 * - `sensitive` : modification difficile ou impossible à annuler, ou à fort impact.
 */
export const riskLevelSchema = z.enum(["read_only", "reversible", "sensitive"]);

/**
 * Niveau d'autorisation d'un agent. Sémantique :
 * - 0 — Observation : lecture seule uniquement ;
 * - 1 — Contributeur : lecture seule uniquement (prépare, ne modifie pas) ;
 * - 2 — Opérateur : lecture seule et actions réversibles ;
 * - 3 — Superviseur : lecture seule et actions réversibles.
 *
 * Aucun niveau n'autorise seul une action `sensitive` : l'approbation humaine
 * explicite est toujours exigée en plus d'un niveau suffisant (>= 2).
 */
export const authorizationLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

/** Statut d'approbation porté par une action. */
export const approvalStatusSchema = z.enum(["not_required", "pending", "approved", "rejected"]);

/** Statut d'exécution d'une action (distinct du statut d'une tâche). */
export const executionStatusSchema = z.enum(["not_started", "refused", "succeeded", "failed"]);

/**
 * Valeur JSON sérialisable : n'accepte ni fonction, ni classe, ni valeur non
 * sérialisable. Ne jamais y placer de secret.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    // Nombres finis uniquement : NaN, Infinity et -Infinity ne sont pas
    // sérialisables en JSON et sont rejetés.
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type AuthorizationLevel = z.infer<typeof authorizationLevelSchema>;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

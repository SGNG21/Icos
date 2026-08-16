import { z } from "zod";

import { idSchema } from "@/core/contracts/common";
import { tenantIdSchema } from "@/core/contracts/tenant";

import { CONTEXT_LIMITS, contextSourceKindSchema, type MissionContext } from "./contract";

/**
 * CTX-SUP-1C — Adaptateur d'entrée Supervisor (frontière étroite).
 *
 * Rôle : figer la FORME du contrat que le Supervisor consommera, et fournir la
 * projection pure `MissionContext → SupervisorContextInput`. Ce lot NE BRANCHE
 * PAS le Supervisor vivant (interdit) : il produit seulement le DTO d'entrée.
 *
 * INVARIANTS DE FRONTIÈRE (voir spec §5 + §2.1) :
 *   Context ≠ Permission        Conversation ≠ Authorization
 *   Context ≠ Approval          Supervisor ≠ policy authority   (reste D1)
 *   Context ≠ Authority         Supervisor ≠ approval authority (reste humaine)
 *   Persistence ≠ Authorization Supervisor ≠ execution authority(reste G1/D4)
 *
 * Le DTO est :
 * - UNIDIRECTIONNEL : Conversation → MissionContext → SupervisorContextInput →
 *   Supervisor. Le Supervisor ne lit jamais en amont.
 * - LECTURE SEULE / NON AUTORITAIRE : aucun champ ne peut être interprété comme
 *   permission / approbation / grant. `.strict()` rejette tout champ superflu,
 *   en particulier tout champ ressemblant à de l'autorité.
 * - PLUS ÉTROIT que `MissionContext` (minimisation) : les `assumptions` ne sont
 *   pas transportées ; les claims sont réduits au strict nécessaire ; les
 *   champs d'audit (`builtAt`, `builtByLabel`) ne franchissent pas la frontière.
 * - BORNÉ : hérite des bornes de `MissionContext`.
 * - STABLE : versionné via `contextVersion`, découplé du format interne.
 */

/** Contrainte confirmée réduite : énoncé + référence de provenance opaque. */
export const supervisorConstraintSchema = z
  .object({
    statement: z.string().min(1).max(CONTEXT_LIMITS.statementMaxLength),
    ref: z.string().min(1).max(256),
  })
  .strict();

export type SupervisorConstraint = z.infer<typeof supervisorConstraintSchema>;

/** Question ouverte réduite : énoncé seul (aucune provenance nécessaire). */
export const supervisorOpenQuestionSchema = z
  .object({
    statement: z.string().min(1).max(CONTEXT_LIMITS.statementMaxLength),
  })
  .strict();

export type SupervisorOpenQuestion = z.infer<typeof supervisorOpenQuestionSchema>;

/**
 * Référence mémoire = preuve seulement. `source` est contraint à
 * `memory_reference` : la frontière ne peut pas laisser une preuve usurper une
 * autre origine.
 */
export const supervisorMemoryReferenceSchema = z
  .object({
    ref: z.string().min(1).max(256),
    source: z.literal(contextSourceKindSchema.enum.memory_reference),
  })
  .strict();

export type SupervisorMemoryReference = z.infer<typeof supervisorMemoryReferenceSchema>;

/**
 * SupervisorContextInput — DTO d'entrée figé (spec §5).
 *
 * `.strict()` garantit qu'aucun champ d'autorité (grant, token, décision allow,
 * approbation, credential) ni aucune `assumptions` ne peut être ajouté sans
 * casser le contrat.
 */
export const supervisorContextInputSchema = z
  .object({
    tenantId: tenantIdSchema,
    missionId: idSchema,
    contextVersion: z.number().int().nonnegative(),
    confirmedObjective: z.string().min(1).max(CONTEXT_LIMITS.statementMaxLength),
    confirmedConstraints: z.array(supervisorConstraintSchema).max(CONTEXT_LIMITS.maxClaims),
    openQuestions: z.array(supervisorOpenQuestionSchema).max(CONTEXT_LIMITS.maxClaims),
    boundedSummary: z.string().max(CONTEXT_LIMITS.summaryMaxLength),
    memoryReferences: z
      .array(supervisorMemoryReferenceSchema)
      .max(CONTEXT_LIMITS.maxMemoryReferences),
  })
  .strict();

export type SupervisorContextInput = z.infer<typeof supervisorContextInputSchema>;

/**
 * Projection pure et déterministe d'un `MissionContext` (artefact de lecture)
 * vers le DTO d'entrée du Supervisor.
 *
 * Propriétés :
 * - PURE : aucune I/O, aucune horloge, aucun accès réseau/SQL.
 * - DÉTERMINISTE : même contexte → même DTO.
 * - NON AUTORITAIRE : la sortie ne peut contenir ni grant, ni décision allow,
 *   ni approbation, ni secret (garanti structurellement par le schéma strict).
 * - MINIMISANTE : n'expose que ce dont la frontière a besoin ; les
 *   `assumptions` et les champs d'audit sont volontairement écartés.
 *
 * Ce mapping NE consulte NI D1 NI G1 et ne peut donc rien autoriser : un
 * Supervisor qui veut agir DOIT passer par D1/G1, jamais par ce DTO.
 */
export function toSupervisorContextInput(context: MissionContext): SupervisorContextInput {
  return {
    tenantId: context.tenantId,
    missionId: context.missionId,
    contextVersion: context.version,
    confirmedObjective: context.confirmedObjective,
    confirmedConstraints: context.confirmedConstraints.map((claim) => ({
      statement: claim.statement,
      ref: claim.provenance.ref,
    })),
    openQuestions: context.openQuestions.map((claim) => ({
      statement: claim.statement,
    })),
    boundedSummary: context.boundedSummary,
    memoryReferences: context.memoryReferences.map((memory) => ({
      ref: memory.ref,
      source: memory.source,
    })),
  };
}

import { z } from "zod";

import { idSchema } from "@/core/contracts";
import { humanAgentRelationSchema, roleSchema, userStatusSchema } from "@/core/identity";

export const createHumanBodySchema = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(12),
    name: z.string().trim().min(1).optional(),
    role: roleSchema,
  })
  .strict();

export const replaceRoleBodySchema = z.object({ role: roleSchema }).strict();

export const setStatusBodySchema = z.object({ status: userStatusSchema }).strict();

export const createAgentLinkBodySchema = z
  .object({ agentId: idSchema, relation: humanAgentRelationSchema })
  .strict();

/**
 * Certification d'un rôle de la digital workforce (ADR 0068, 0066). `testsPassed` et
 * `evidenceRef` sont l'attestation du certificateur — jamais vérifiés automatiquement par
 * cette route : c'est un acte humain, pas un calcul. La route transmet tel quel à
 * `certifyRole`, qui refuse `MISSING_TESTS` si la liste ne couvre pas `requiredRoleTests`.
 *
 * `testsPassed` n'impose PAS un minimum d'un élément : `requiredRoleTests` peut légitimement
 * être vide (une compétence sans `tests` déclarés), et `certifyRole` accepte alors
 * `testsPassed: []` sans violation. Un `.min(1)` ici rendrait ce rôle impossible à certifier
 * par cette route alors que la règle de gouvernance elle-même l'autorise.
 *
 * `evidenceRef` : AUCUNE validation de contenu ne peut prouver qu'un test a réellement
 * tourné — ce n'est pas calculable, et ce fichier ne prétend pas le résoudre (voir
 * `docs/acceptance/2026-10-23-brain-role-certification-dossier.md` et le runbook). Le seul
 * garde-fou raisonnable côté schéma est de relever le plancher au-delà d'un caractère
 * unique : `min(1)` laissait passer `"r"` ou `"x"` — une attestation qui ne référence
 * littéralement rien. `min(16)` force à écrire quelque chose qui ressemble à une vraie
 * référence (horodatage + chiffres, SHA, URL de run CI) sans prétendre la vérifier.
 */
export const certifyRoleBodySchema = z
  .object({
    version: z.string().trim().min(1),
    testsPassed: z.array(z.string().trim().min(1)),
    evidenceRef: z
      .string()
      .trim()
      .min(
        16,
        "evidenceRef doit référencer une preuve réelle (horodatage + chiffres d'un run, SHA, URL CI) — pas un texte arbitraire court",
      ),
  })
  .strict();

export const activateRoleBodySchema = z.object({ version: z.string().trim().min(1) }).strict();

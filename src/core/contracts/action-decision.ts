import { z } from "zod";

import { approvalDecisionSchema } from "./approval";

/**
 * Commande de décision humaine sur une action.
 *
 * `decidedByLabel` est une ÉTIQUETTE DÉCLARATIVE NON AUTHENTIFIÉE : au Lot 1B,
 * aucune authentification réelle n'existe. Ne jamais la présenter comme une
 * identité vérifiée.
 *
 * Règle (corr. 8) : pour une décision `rejected`, le motif est obligatoire et
 * non vide ; pour `approved`, il reste facultatif.
 *
 * `.strict()` rejette tout champ superflu — en particulier un `agent` ou un
 * `authorizationLevel` que le client tenterait d'injecter pour influencer la
 * décision d'exécution.
 */
export const actionDecisionCommandSchema = z
  .object({
    decidedByLabel: z.string().trim().min(1),
    decision: approvalDecisionSchema,
    reason: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((command, ctx) => {
    if (
      command.decision === "rejected" &&
      (command.reason === undefined || command.reason === "")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "un motif est obligatoire pour un rejet",
      });
    }
  });

export type ActionDecisionCommand = z.infer<typeof actionDecisionCommandSchema>;

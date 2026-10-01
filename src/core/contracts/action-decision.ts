import { z } from "zod";

import { approvalDecisionSchema } from "./approval";

/**
 * Commande de décision humaine sur une action.
 *
 * LE DÉCIDEUR N'EST PAS DANS LE CORPS. Il portait un `decidedByLabel` fourni par le
 * client, recopié tel quel dans `approval.decidedBy` ET dans l'acteur d'audit : n'importe
 * quel appelant autorisé pouvait donc signer sa décision du nom, de l'e-mail ou de l'id
 * d'un autre utilisateur. L'identité du décideur vient désormais de la session
 * authentifiée côté serveur (même règle que /api/tool-gateway/approvals/[id]/decision).
 *
 * Règle (corr. 8) : pour une décision `rejected`, le motif est obligatoire et
 * non vide ; pour `approved`, il reste facultatif.
 *
 * `.strict()` rejette tout champ superflu — en particulier un `agent`, un
 * `authorizationLevel` ou un `decidedByLabel` que le client tenterait d'injecter pour
 * influencer la décision d'exécution ou l'identité tracée.
 */
export const actionDecisionCommandSchema = z
  .object({
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

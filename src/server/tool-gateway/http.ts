import { z } from "zod";

import type { AuthenticatedSession } from "@/core/identity";
import { actionClassSchema, type ToolFailureClass } from "@/core/tool-gateway/model";
import type { ApiErrorCode } from "@/server/http/errors";
import { apiError } from "@/server/http/respond";

import type { HumanPrincipal, ToolCockpitSnapshot } from "./gateway";

/**
 * HTTP boundary helpers for the Tool Gateway routes. The principal is ALWAYS
 * the authenticated session: bodies are strict and carry no identity field, so
 * an approver or grantor identity cannot be forged by the caller.
 */
export const principalOf = (session: AuthenticatedSession): HumanPrincipal => ({
  kind: "human",
  id: session.user.id,
  roles: session.roles,
});

export const approvalDecisionBodySchema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const grantBodySchema = z
  .object({
    op: z.enum(["grant", "revoke"]),
    agentId: z.string().min(1).max(128),
    toolId: z.string().min(1).max(128),
    action: actionClassSchema,
    reason: z.string().trim().min(1).max(500),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const CODE: Partial<Record<ToolFailureClass, ApiErrorCode>> = {
  NOT_FOUND: "not_found",
  PERMISSION_DENIED: "forbidden",
  CONFLICT: "already_decided",
  APPROVAL_EXPIRED: "invalid_transition",
  INVALID_INPUT: "invalid_input",
};

export const toolFailureResponse = (failureClass: ToolFailureClass, message: string): Response =>
  apiError(CODE[failureClass] ?? "invalid_transition", message, { failureClass });

/**
 * Cockpit view for `cockpit.read`: pending approvals without their input
 * preview (which may hold personal data); previews are served only to deciders
 * by the approvals endpoint.
 */
export function cockpitView(s: ToolCockpitSnapshot) {
  return {
    ...s,
    pendingApprovals: s.pendingApprovals.map(({ inputPreview, ...rest }) => ({
      ...rest,
      inputFields: Object.keys(inputPreview),
    })),
  };
}

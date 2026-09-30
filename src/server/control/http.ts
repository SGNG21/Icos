import { randomUUID } from "node:crypto";

import type { ControlCommandResult, RejectionCode } from "@/core/control/contracts";
import type { AuthenticatedSession } from "@/core/identity";
import type { Container } from "@/server/container";
import { apiError } from "@/server/http/respond";

import type { CommandActor } from "./command-bus";

/** HTTP status for a command result. The body is ALWAYS the typed result. */
export function statusForResult(result: ControlCommandResult): number {
  switch (result.status) {
    case "EXECUTED":
      return 200;
    case "UNKNOWN_EXECUTION_STATE":
      return 202;
    case "FAILED":
      return 409;
    case "REJECTED":
      return statusForRejection(result.rejection!.code);
  }
}

export function statusForRejection(code: RejectionCode): number {
  switch (code) {
    case "INVALID_REQUEST":
    case "TARGET_KIND_MISMATCH":
      return 422;
    case "FORBIDDEN":
      return 403;
    case "TARGET_NOT_FOUND":
      return 404;
    case "VERSION_CONFLICT":
    case "INVALID_TRANSITION":
    case "IDEMPOTENCY_KEY_REUSED":
      return 409;
    case "SESSION_TOO_OLD":
    case "REAUTH_REQUIRED":
    case "REAUTH_INVALID":
    case "REAUTH_EXPIRED":
    case "CONFIRMATION_REQUIRED":
      return 428;
    case "CONTROL_STATE_UNAVAILABLE":
      return 503;
  }
}

/**
 * Binds the authenticated ICOS session to Better Auth session EVIDENCE (id +
 * issue time, never the token). Fails closed: no evidence, no command.
 */
export async function resolveActor(
  container: Container,
  headers: Headers,
  session: AuthenticatedSession,
): Promise<{ ok: true; actor: CommandActor } | { ok: false; response: Response }> {
  if (!container.control || !container.auth?.readSessionEvidence) {
    return {
      ok: false,
      response: apiError("persistence_unavailable", "control plane unavailable"),
    };
  }
  const evidence = await container.auth.readSessionEvidence(headers);
  if (!evidence || evidence.userId !== session.user.id) {
    return { ok: false, response: apiError("unauthenticated", "session evidence unavailable") };
  }
  return {
    ok: true,
    actor: { session, sessionId: evidence.sessionId, sessionIssuedAt: evidence.issuedAt },
  };
}

/** Audit of a structurally invalid command from an authenticated actor. */
export async function auditInvalidRequest(
  container: Container,
  userId: string,
  issues: unknown,
): Promise<string> {
  const id = `ctl-invalid-${randomUUID()}`;
  const at = new Date().toISOString();
  await container.audit.append({
    id,
    eventType: "control.command.rejected",
    actor: { kind: "human", id: userId },
    details: { code: "INVALID_REQUEST", issues: JSON.parse(JSON.stringify(issues ?? null)) },
    occurredAt: at,
    createdAt: at,
  });
  return id;
}

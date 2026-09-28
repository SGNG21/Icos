import type { Permission } from "@/core/identity";

import {
  COMMAND_SPECS,
  type ControlCommandType,
  type ReauthStatus,
  type RejectionCode,
  type RiskClass,
  type RuntimeFlags,
} from "./contracts";

/** Pure control policy (decision 0044). */

export const MEDIUM_MAX_SESSION_AGE_MS = 12 * 60 * 60 * 1000;
export const REAUTH_PROOF_TTL_MS = 5 * 60 * 1000;

/**
 * Explicit permission per command family. Mission commands additionally
 * require the mission to be in the caller's operational scope.
 */
export function requiredPermission(type: ControlCommandType): Permission {
  switch (COMMAND_SPECS[type].target) {
    case "mission":
      return "missions.write";
    case "worker":
      return "agents.manage";
    case "runtime":
      return "config.manage";
  }
}

export interface AuthRequirement {
  maxSessionAgeMs: number | null;
  reauth: boolean;
  typedConfirmation: boolean;
  /**
   * Hook for passkey / second factor on CRITICAL. "not_enforced" today; a
   * future "required" must make the bus reject without that evidence.
   */
  secondFactor: "not_enforced" | "required";
}

export function authRequirement(risk: RiskClass): AuthRequirement {
  switch (risk) {
    case "LOW":
      return { maxSessionAgeMs: null, reauth: false, typedConfirmation: false, secondFactor: "not_enforced" };
    case "MEDIUM":
      return { maxSessionAgeMs: MEDIUM_MAX_SESSION_AGE_MS, reauth: false, typedConfirmation: false, secondFactor: "not_enforced" };
    case "HIGH":
      return { maxSessionAgeMs: null, reauth: true, typedConfirmation: false, secondFactor: "not_enforced" };
    case "CRITICAL":
      return { maxSessionAgeMs: null, reauth: true, typedConfirmation: true, secondFactor: "not_enforced" };
  }
}

export type ProofCheck = "valid" | "missing" | "invalid" | "expired";

/**
 * Evaluates everything about the caller's authentication freshness EXCEPT
 * consuming the proof (that happens atomically in the command transaction).
 */
export function evaluateAuthFreshness(input: {
  risk: RiskClass;
  sessionIssuedAt: Date;
  now: Date;
  proof: ProofCheck;
  confirmationOk: boolean;
}): { ok: true; reauth: ReauthStatus } | { ok: false; code: RejectionCode; reauth: ReauthStatus } {
  const req = authRequirement(input.risk);
  if (req.maxSessionAgeMs !== null && input.now.getTime() - input.sessionIssuedAt.getTime() > req.maxSessionAgeMs) {
    return { ok: false, code: "SESSION_TOO_OLD", reauth: "NOT_REQUIRED" };
  }
  if (!req.reauth) return { ok: true, reauth: "NOT_REQUIRED" };
  if (req.secondFactor === "required") return { ok: false, code: "REAUTH_REQUIRED", reauth: "REQUIRED" };
  switch (input.proof) {
    case "missing":
      return { ok: false, code: "REAUTH_REQUIRED", reauth: "REQUIRED" };
    case "invalid":
      return { ok: false, code: "REAUTH_INVALID", reauth: "INVALID" };
    case "expired":
      return { ok: false, code: "REAUTH_EXPIRED", reauth: "EXPIRED" };
    case "valid":
      break;
  }
  if (req.typedConfirmation && !input.confirmationOk) {
    return { ok: false, code: "CONFIRMATION_REQUIRED", reauth: "SATISFIED" };
  }
  return { ok: true, reauth: "SATISFIED" };
}

/** A missing (unreadable) flags row means everything is off. */
export function effectiveFlags(stored: RuntimeFlags | null): RuntimeFlags {
  if (!stored) {
    return { safeMode: true, dispatchEnabled: false, integrationEnabled: false, externalActionsEnabled: false };
  }
  if (stored.safeMode) {
    return { safeMode: true, dispatchEnabled: false, integrationEnabled: false, externalActionsEnabled: false };
  }
  return stored;
}

/** Flags a fresh installation starts with: normal operation. */
export const DEFAULT_RUNTIME_FLAGS: RuntimeFlags = {
  safeMode: false,
  dispatchEnabled: true,
  integrationEnabled: true,
  externalActionsEnabled: true,
};

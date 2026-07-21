import type { ZodError } from "zod";

/** Union typée et stable des codes d'erreur exposés par l'API interne. */
export type ApiErrorCode =
  | "invalid_input"
  | "not_found"
  | "invalid_transition"
  | "already_decided"
  | "agent_not_found"
  | "inconsistent_reference"
  | "audit_failed"
  | "internal_error";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

const statusByCode: Record<ApiErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  invalid_transition: 409,
  already_decided: 409,
  agent_not_found: 422,
  inconsistent_reference: 422,
  audit_failed: 500,
  internal_error: 500,
};

export function httpStatusFor(code: ApiErrorCode): number {
  return statusByCode[code];
}

export interface ZodIssueDetail {
  path: string;
  code: string;
  message: string;
}

/**
 * Réduit une erreur Zod à des détails contrôlés : chemin du champ, code de
 * validation et message. La VALEUR d'entrée rejetée n'est jamais renvoyée.
 */
export function zodDetails(error: ZodError): ZodIssueDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    code: issue.code,
    message: issue.message,
  }));
}

import type { ExecutionError, ExecutionErrorCode } from "@/core/runtime";

/**
 * Crée une ExecutionError normalisée.
 */
export function createExecutionError(
  code: ExecutionErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): ExecutionError {
  return { code, message, retryable, details };
}

/**
 * Crée une ExecutionError depuis un code D3.
 */
export function mapAiErrorToExecutionError(
  code: string,
  message: string,
  retryable: boolean,
): ExecutionError {
  switch (code) {
    case "PROVIDER_UNAVAILABLE":
      return createExecutionError("AI_PROVIDER_UNAVAILABLE", message, retryable);
    case "RATE_LIMITED":
      return createExecutionError("AI_RATE_LIMITED", message, retryable);
    case "TIMEOUT":
      return createExecutionError("AI_TIMEOUT", message, false);
    case "INVALID_RESPONSE":
      return createExecutionError("AI_INVALID_RESPONSE", message, false);
    case "POLICY_BLOCKED":
      return createExecutionError("AI_POLICY_BLOCKED", message, false);
    case "UNSUPPORTED_CAPABILITY":
      return createExecutionError("AI_UNSUPPORTED_CAPABILITY", message, false);
    case "CANCELLED":
      return createExecutionError("CANCELLED", message, false);
    default:
      return createExecutionError("AI_INTERNAL_ERROR", message, false);
  }
}

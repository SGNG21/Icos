import { timingSafeEqual } from "node:crypto";

/**
 * Authentification des callbacks internes Temporal → ICOS.
 *
 * Contrat :
 * - un en-tête `x-icos-callback-secret` doit accompagner chaque callback ;
 * - la comparaison est faite en temps constant pour ne pas exposer d'oracle
 *   de longueur/timing ;
 * - le secret attendu vient de l'environnement (`ICOS_EXECUTION_CALLBACK_SECRET`) ;
 *   son ABSENCE fait échouer la vérification (`unconfigured`) — jamais de
 *   fallback permissif ;
 * - AUCUN log/erreur ne doit contenir la valeur du secret.
 */
export type ExecutionCallbackAuthResult =
  { ok: true } | { ok: false; reason: "unconfigured" | "missing" | "invalid" };

export const EXECUTION_CALLBACK_HEADER = "x-icos-callback-secret";

/** Minimum de robustesse : refuse un secret trop court, même si l'env l'accepte. */
const MIN_SECRET_LENGTH = 32;

export function verifyExecutionCallback(
  request: Request,
  expected: string | undefined,
): ExecutionCallbackAuthResult {
  if (!expected || expected.length < MIN_SECRET_LENGTH) {
    return { ok: false, reason: "unconfigured" };
  }
  const provided = request.headers.get(EXECUTION_CALLBACK_HEADER);
  if (!provided) {
    return { ok: false, reason: "missing" };
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return { ok: false, reason: "invalid" };
  }
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "invalid" };
}

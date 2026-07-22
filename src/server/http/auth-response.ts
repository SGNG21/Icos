import { AuthGuardError } from "@/server/auth/errors";

import { apiError } from "./respond";

const messageByCode = {
  unauthenticated: "Authentification requise.",
  session_expired: "La session a expiré.",
  forbidden: "Accès interdit.",
  account_disabled: "Le compte est désactivé.",
} as const;

/** Convertit un refus auth typé en réponse JSON stable et sans donnée interne. */
export function authErrorResponse(error: AuthGuardError): Response {
  return apiError(error.code, messageByCode[error.code]);
}

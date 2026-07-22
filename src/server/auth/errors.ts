export type AuthFailureCode =
  | "unauthenticated"
  | "session_expired"
  | "forbidden"
  | "account_disabled";

/** Refus d'authentification ou d'autorisation indépendant de la couche HTTP. */
export class AuthGuardError extends Error {
  constructor(readonly code: AuthFailureCode) {
    super(code);
    this.name = "AuthGuardError";
  }
}

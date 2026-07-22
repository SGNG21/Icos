import { AuthGuardError } from "@/server/auth/errors";

/** Vérifie strictement l'origine des mutations avant toute lecture du corps. */
export function isSameOriginMutation(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return false;
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function requireSameOrigin(request: Request): void {
  if (!isSameOriginMutation(request)) {
    throw new AuthGuardError("forbidden");
  }
}

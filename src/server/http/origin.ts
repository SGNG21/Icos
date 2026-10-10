import { AuthGuardError } from "@/server/auth/errors";

/**
 * Origine publique canonique déclarée par le déploiement (`BETTER_AUTH_URL`),
 * ou `null` si absente ou inexploitable. Seule l'origine (schéma, hôte, port)
 * compte : un éventuel chemin est ignoré. Hors http(s) l'origine sérialisée
 * vaut `"null"` : elle n'ouvre rien (fail closed). Aucun header proxy
 * (X-Forwarded-*) n'est consulté : l'autorité est la configuration, pas la requête.
 */
function configuredPublicOrigin(): string | null {
  const configured = process.env.BETTER_AUTH_URL;
  if (!configured) {
    return null;
  }

  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** Origines acceptées : l'origine directe de la requête et l'origine publique configurée. */
function allowedOrigins(request: Request): Set<string> {
  const allowed = new Set<string>([new URL(request.url).origin]);
  const publicOrigin = configuredPublicOrigin();
  if (publicOrigin !== null) {
    allowed.add(publicOrigin);
  }
  return allowed;
}

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
    return allowedOrigins(request).has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function requireSameOrigin(request: Request): void {
  if (!isSameOriginMutation(request)) {
    throw new AuthGuardError("forbidden");
  }
}

import { z } from "zod";

import type { Env } from "@/config/env";

/**
 * Configuration de la connexion à OmniRoute.
 * Validée par Zod — jamais de valeur invalide non détectée.
 */
export const omniRouteConfigSchema = z.object({
  /** URL de base d'OmniRoute, ex: http://127.0.0.1:20128 */
  baseUrl: z.string().url(),
  /** Clé API pour l'authentification ICOS → OmniRoute (optionnelle). */
  apiKey: z.string().optional(),
  /** Timeout par défaut pour les requêtes (ms). */
  defaultTimeoutMs: z.number().int().positive().default(60_000),
  /** Timeout maximum absolu (sécurité — pas de timeout excessif). */
  maxTimeoutMs: z.number().int().positive().default(300_000),
});

export type OmniRouteConfig = z.infer<typeof omniRouteConfigSchema>;

/**
 * Résout la configuration OmniRoute depuis l'environnement.
 * Tous les champs sont optionnels : l'application démarre sans OmniRoute.
 * Si `baseUrl` est absent, la valeur par défaut est utilisée.
 */
export function resolveOmniRouteConfig(env: Env): OmniRouteConfig {
  return omniRouteConfigSchema.parse({
    baseUrl: env.OMNIROUTE_BASE_URL,
    apiKey: env.OMNIROUTE_API_KEY,
    defaultTimeoutMs: env.OMNIROUTE_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: env.OMNIROUTE_MAX_TIMEOUT_MS,
  });
}

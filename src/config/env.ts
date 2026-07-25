import { z } from "zod";

/**
 * Les variables optionnelles vides (`FOO=`) sont traitées comme absentes :
 * copier `.env.example` tel quel reste valide.
 */
const emptyAsUndefined = (value: unknown) => (value === "" ? undefined : value);

const optionalSecret = z.preprocess(emptyAsUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyAsUndefined, z.url().optional());

const persistenceSchema = z.preprocess(emptyAsUndefined, z.enum(["memory", "postgres"]).optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PERSISTENCE: persistenceSchema,
  DATABASE_URL: optionalUrl,
  // Authentification humaine (Better Auth). Requis lorsque l'auth réelle est
  // composée (backend postgres). Aucune valeur réelle committée.
  BETTER_AUTH_SECRET: optionalSecret,
  BETTER_AUTH_URL: optionalUrl,
  ICOS_OWNER_EMAIL: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  OPENAI_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  GITHUB_TOKEN: optionalSecret,
  N8N_BASE_URL: optionalUrl,
  N8N_API_KEY: optionalSecret,
  DOLIBARR_BASE_URL: optionalUrl,
  DOLIBARR_API_KEY: optionalSecret,
  // OmniRoute AI Gateway
  OMNIROUTE_BASE_URL: z.preprocess(emptyAsUndefined, z.string().url().default("http://127.0.0.1:20128")),
  OMNIROUTE_API_KEY: optionalSecret,
  OMNIROUTE_DEFAULT_TIMEOUT_MS: z.preprocess(emptyAsUndefined, z.coerce.number().int().positive().default(60_000)),
  OMNIROUTE_MAX_TIMEOUT_MS: z.preprocess(emptyAsUndefined, z.coerce.number().int().positive().default(300_000)),
});

export type Env = z.infer<typeof envSchema>;

/** Configuration d'authentification résolue (secret ≥ 32 caractères, URL). */
export interface AuthConfig {
  secret: string;
  baseURL: string;
}

/**
 * Résout la configuration d'authentification réelle. Échoue explicitement si le
 * secret (≥ 32 caractères) ou l'URL manquent — jamais de valeur par défaut
 * faible, jamais de secret journalisé.
 */
export function resolveAuthConfig(env: Env): AuthConfig {
  if (env.BETTER_AUTH_SECRET === undefined || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error(
      "BETTER_AUTH_SECRET est requis (≥ 32 caractères) pour l'authentification humaine.",
    );
  }
  if (env.BETTER_AUTH_URL === undefined) {
    throw new Error("BETTER_AUTH_URL est requis pour l'authentification humaine.");
  }
  return { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL };
}

/**
 * Validation à la demande : aucune exécution au chargement du module, afin que
 * l'application démarre sans aucun service externe configuré. Les intégrations
 * restent désactivées tant que leurs adaptateurs n'existent pas.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

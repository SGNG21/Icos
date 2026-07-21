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
  OPENAI_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  GITHUB_TOKEN: optionalSecret,
  N8N_BASE_URL: optionalUrl,
  N8N_API_KEY: optionalSecret,
  DOLIBARR_BASE_URL: optionalUrl,
  DOLIBARR_API_KEY: optionalSecret,
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validation à la demande : aucune exécution au chargement du module, afin que
 * l'application démarre sans aucun service externe configuré. Les intégrations
 * restent désactivées tant que leurs adaptateurs n'existent pas.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

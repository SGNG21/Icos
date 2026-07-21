import { z } from "zod";

const optionalSecret = z.string().min(1).optional();
const optionalUrl = z.url().optional();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: optionalUrl,
  OPENAI_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  GITHUB_TOKEN: optionalSecret,
  N8N_BASE_URL: optionalUrl,
  N8N_API_KEY: optionalSecret,
  DOLIBARR_BASE_URL: optionalUrl,
  DOLIBARR_API_KEY: optionalSecret,
});

export const env = envSchema.parse(process.env);

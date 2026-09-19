/**
 * Contrôle d'intégrité de l'authentification humaine — `pnpm auth:check`.
 *
 * LECTURE SEULE (transaction READ ONLY) : ne crée, ne répare et ne modifie
 * rien ; ne teste pas le mot de passe. N'affiche que des états et des codes de
 * cause (jamais hash, secret, token, cookie, URL ou email). Code de sortie 1 si
 * `AUTH_INTEGRITY=FAIL`. À exécuter après toute migration / restauration.
 *
 * L'environnement est résolu comme Next.js : variables déjà présentes > `.env.local`
 * > `.env` (le décalage de base cible est ainsi visible via `DATABASE=<nom>`).
 */
import postgres from "postgres";

import { loadEnv } from "@/config/env";
import { formatAuthReport, runAuthIntegrityCheck } from "@/server/auth/integrity";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file); // n'écrase jamais une variable déjà définie
  } catch {
    // fichier absent : ignoré
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.DATABASE_URL === undefined) {
    // Sans base, aucune vérification possible : échec explicite (fail closed).
    console.log("AUTH_INTEGRITY=FAIL cause=database_url_missing");
    process.exitCode = 1;
    return;
  }
  const sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const report = await runAuthIntegrityCheck(sql, env);
    console.log(formatAuthReport(report));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(() => {
  // Aucun message brut : il pourrait contenir une URL ou une valeur de configuration.
  console.log("AUTH_INTEGRITY=FAIL cause=check_error");
  process.exitCode = 1;
});
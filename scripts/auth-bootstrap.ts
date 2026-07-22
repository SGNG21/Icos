/**
 * Bootstrap du premier utilisateur `owner` — adaptateur CLI MINCE autour de
 * `bootstrapOwner()` (aucune logique métier ici). Exécuté via `tsx` :
 * `pnpm auth:bootstrap`.
 *
 * Sécurité : Better Auth crée lui-même le hash (le script n'écrit jamais dans
 * `account.password`). Le mot de passe (`ICOS_OWNER_PASSWORD`) est fourni
 * PONCTUELLEMENT au processus puis retiré de l'environnement ; il n'est jamais
 * affiché ni inclus dans une erreur. Aucune `DATABASE_URL`, secret, token,
 * cookie ou hash n'est affiché. La commande ne s'exécute jamais automatiquement
 * et refuse un second bootstrap initial. Les migrations doivent être appliquées
 * au préalable.
 */
import { loadEnv } from "@/config/env";
import { bootstrapOwner } from "@/server/auth/bootstrap";
import { createContainer } from "@/server/container";

const RESULT_LABEL = {
  created: "owner_created",
  repaired: "owner_repaired",
  already_present: "owner_already_present",
} as const;

async function main(): Promise<void> {
  const env = loadEnv();

  // --- Validations AVANT toute ouverture de client / écriture ---
  if (env.PERSISTENCE !== "postgres") {
    throw new Error(
      "PERSISTENCE=postgres est requis (l'authentification réelle exige PostgreSQL).",
    );
  }
  const email = env.ICOS_OWNER_EMAIL;
  if (!email || !email.includes("@")) {
    throw new Error("ICOS_OWNER_EMAIL est requis et doit être un email valide.");
  }
  const password = process.env.ICOS_OWNER_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error("ICOS_OWNER_PASSWORD est requis (minimum 12 caractères).");
  }

  // createContainer valide DATABASE_URL + BETTER_AUTH_SECRET/URL et ouvre UN seul
  // client PostgreSQL partagé par Better Auth et les repositories.
  const container = await createContainer({ env });
  try {
    if (!container.auth || !container.roles) {
      throw new Error("Authentification indisponible : configuration incomplète.");
    }
    const result = await bootstrapOwner(
      { auth: container.auth, roles: container.roles, audit: container.audit },
      { email, password },
    );
    if (result.ok) {
      console.log(RESULT_LABEL[result.status]);
    } else {
      console.error(`bootstrap_failed:${result.reason}`);
      process.exitCode = 1;
    }
  } finally {
    await container.close();
  }
}

main().catch((error: unknown) => {
  // Message contrôlé, jamais de mot de passe / URL / secret.
  console.error(error instanceof Error ? error.message : "erreur inconnue");
  process.exitCode = 1;
});

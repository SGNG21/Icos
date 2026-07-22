import { defineConfig } from "drizzle-kit";

/**
 * Configuration Drizzle Kit. `generate` ne nécessite aucune connexion : le SQL
 * est produit à partir du schéma. Les identifiants de base ne servent qu'aux
 * commandes en ligne (migrate/studio) et proviennent de l'environnement.
 */
export default defineConfig({
  schema: "./src/server/database/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  strict: true,
  verbose: true,
  // `generate` n'en a pas besoin ; `migrate` exige un DATABASE_URL réel.
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});

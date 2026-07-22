import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Configuration des tests d'intégration PostgreSQL (Testcontainers). Nécessite
 * Docker. Exécutée uniquement via `pnpm test:integration`, jamais par `pnpm test`.
 * Timeout élevé pour le démarrage du conteneur ; pas de parallélisme entre
 * fichiers afin de partager proprement un conteneur par fichier.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

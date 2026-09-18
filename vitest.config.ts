import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    coverage: {
      reporter: ["text", "json", "html"],
    },
    include: ["src/**/*.test.ts"],
    // Les tests PostgreSQL partagent une base de test jetable (`icos_test`,
    // voir src/server/database/test-database-guard.ts) : séquence obligatoire.
    // Jamais la base live (icos_n23_probe) : `createDatabase` refuse toute base
    // non « test » sous Vitest.
    fileParallelism: false,
    // Les tests d'intégration PostgreSQL (TRUNCATE/DELETE) sont exécutés
    // séparément via `pnpm test:integration`, jamais par `pnpm test`.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
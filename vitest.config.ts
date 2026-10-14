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
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Les tests PostgreSQL partagent une base de test jetable (`icos_test`,
    // voir src/server/database/test-database-guard.ts) : séquence obligatoire.
    // Jamais la base live (icos_n23_probe) : `createDatabase` refuse toute base
    // non « test » sous Vitest.
    fileParallelism: false,
    // Les hooks qui composent un conteneur complet (createContainer à froid) dépassent les
    // 10 s par défaut sur le VPS chargé (e2e-failure.test.ts, 2026-10-14 : hook > 10 s, test
    // vert à 24 s). Aligné sur le --testTimeout=30000 de la porte : un délai, pas une assertion.
    hookTimeout: 30_000,
    // Les tests d'intégration PostgreSQL (TRUNCATE/DELETE) sont exécutés
    // séparément via `pnpm test:integration`, jamais par `pnpm test`.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
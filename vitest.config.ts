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
    // Les tests d'intégration PostgreSQL (Docker/Testcontainers) sont exécutés
    // séparément via `pnpm test:integration`.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});

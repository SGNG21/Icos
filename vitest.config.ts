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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Les tests d'intégration PostgreSQL (Docker/Testcontainers) sont exécutés
    // séparément via `pnpm test:integration`.
    // Les tests de composants cockpit utilisent renderToStaticMarkup (env node,
    // aucune dépendance DOM ajoutée) — voir docs du plan CPT-1.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});

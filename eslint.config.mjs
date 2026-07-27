import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    ".next/**",
    "coverage/**",
    "dist/**",
    "next-env.d.ts",
    // Générés par le WorktreeManager autonome : copies isolées du dépôt.
    // Sans cette exclusion, `eslint .` récurse dans chaque worktree worker.
    ".claude/worktrees/**",
  ]),
]);

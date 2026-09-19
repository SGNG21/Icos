import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([".next/**", "coverage/**", "dist/**", "next-env.d.ts"]),
  {
    // Tests build partial fakes/mocks of repositories and HTTP payloads; typing every
    // stand-in adds noise without protecting production. Production code keeps the rule.
    files: ["**/*.test.ts", "**/*.test.tsx", "test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
]);

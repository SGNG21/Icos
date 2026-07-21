import { describe, expect, it } from "vitest";

import { loadEnv } from "./env";

describe("loadEnv", () => {
  it("traite les chaînes vides des variables optionnelles comme absentes", () => {
    const env = loadEnv({
      NODE_ENV: "development",
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      GITHUB_TOKEN: "",
      N8N_BASE_URL: "",
      N8N_API_KEY: "",
      DOLIBARR_BASE_URL: "",
      DOLIBARR_API_KEY: "",
    });

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.N8N_BASE_URL).toBeUndefined();
    expect(env.NODE_ENV).toBe("development");
  });

  it("applique la valeur par défaut de NODE_ENV", () => {
    expect(loadEnv({}).NODE_ENV).toBe("development");
  });

  it("conserve une valeur optionnelle réellement fournie", () => {
    const env = loadEnv({ GITHUB_TOKEN: "ghp_exemple", DATABASE_URL: "https://db.example.test" });
    expect(env.GITHUB_TOKEN).toBe("ghp_exemple");
    expect(env.DATABASE_URL).toBe("https://db.example.test");
  });

  it("rejette une URL invalide fournie explicitement", () => {
    expect(() => loadEnv({ DATABASE_URL: "pas-une-url" })).toThrow();
  });

  it("rejette une valeur NODE_ENV hors de l'énumération", () => {
    expect(() => loadEnv({ NODE_ENV: "staging" })).toThrow();
  });
});

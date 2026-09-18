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

  it("parse l'intervalle du scheduler de récupération en millisecondes", () => {
    expect(loadEnv({ AUTONOMY_RECOVERY_INTERVAL_MS: "15000" }).AUTONOMY_RECOVERY_INTERVAL_MS).toBe(
      15_000,
    );
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity"])(
    "rejette l'intervalle invalide du scheduler de récupération %s",
    (intervalMs) => {
      expect(() => loadEnv({ AUTONOMY_RECOVERY_INTERVAL_MS: intervalMs })).toThrow();
    },
  );

  it("parse le délai du planner autonome en millisecondes", () => {
    expect(loadEnv({ ICOS_PLANNER_TIMEOUT_MS: "45000" }).ICOS_PLANNER_TIMEOUT_MS).toBe(45_000);
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity"])(
    "rejette le délai invalide du planner autonome %s",
    (timeoutMs) => {
      expect(() => loadEnv({ ICOS_PLANNER_TIMEOUT_MS: timeoutMs })).toThrow();
    },
  );

  it("traite la configuration Temporal vide comme absente", () => {
    const env = loadEnv({
      TEMPORAL_ADDRESS: "",
      TEMPORAL_TASK_QUEUE: "",
      TEMPORAL_WORKFLOW_TYPE: "",
    });

    expect(env.TEMPORAL_ADDRESS).toBeUndefined();
    expect(env.TEMPORAL_TASK_QUEUE).toBeUndefined();
    expect(env.TEMPORAL_WORKFLOW_TYPE).toBeUndefined();
  });

  it("parse et valide le délai de dispatch Temporal", () => {
    expect(loadEnv({ TEMPORAL_DISPATCH_TIMEOUT_MS: "7500" }).TEMPORAL_DISPATCH_TIMEOUT_MS).toBe(
      7_500,
    );
    expect(() => loadEnv({ TEMPORAL_DISPATCH_TIMEOUT_MS: "0" })).toThrow();
  });

  it("charge le secret de callback sous le nom partagé avec le worker", () => {
    expect(
      loadEnv({ ICOS_EXECUTION_CALLBACK_SECRET: "callback-secret" }).ICOS_EXECUTION_CALLBACK_SECRET,
    ).toBe("callback-secret");
  });

  it("rejette une URL invalide fournie explicitement", () => {
    expect(() => loadEnv({ DATABASE_URL: "pas-une-url" })).toThrow();
  });

  it("rejette une valeur NODE_ENV hors de l'énumération", () => {
    expect(() => loadEnv({ NODE_ENV: "staging" })).toThrow();
  });
});

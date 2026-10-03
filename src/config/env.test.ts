import { describe, expect, it } from "vitest";

import { AUTONOMY_BOUNDS_CEILING } from "@/core/autonomy/bounds";
import {
  MODEL_ALLOWLIST_UNRESTRICTED,
  isModelAllowed,
} from "@/core/autonomy/model-allowlist";

import {
  loadEnv,
  resolveAuthConfig,
  resolveAutonomyBounds,
  resolveSystemModelAllowlist,
} from "./env";

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

describe("ICOS_GOAL_MAX_TOTAL_TOKENS", () => {
  it("porte le seul plafond réellement applicable aujourd'hui", () => {
    expect(loadEnv({ ICOS_GOAL_MAX_TOTAL_TOKENS: "50000" }).ICOS_GOAL_MAX_TOTAL_TOKENS).toBe(50_000);
  });

  it("absente, reste indéfinie — et NON zéro, qui serait un plafond de zéro token", () => {
    expect(loadEnv({}).ICOS_GOAL_MAX_TOTAL_TOKENS).toBeUndefined();
  });

  it("refuse une valeur non exploitable au lieu de la coercer", () => {
    for (const value of ["0", "-1", "abc", "1.5"]) {
      expect(() => loadEnv({ ICOS_GOAL_MAX_TOTAL_TOKENS: value })).toThrow();
    }
  });
});

describe("ICOS_SELF_DEVELOPMENT", () => {
  it("accepte uniquement les deux états explicites", () => {
    expect(loadEnv({ ICOS_SELF_DEVELOPMENT: "enabled" }).ICOS_SELF_DEVELOPMENT).toBe("enabled");
    expect(loadEnv({ ICOS_SELF_DEVELOPMENT: "disabled" }).ICOS_SELF_DEVELOPMENT).toBe("disabled");
  });

  it("absente = indéfinie, donc OFF, jamais activée par défaut", () => {
    expect(loadEnv({}).ICOS_SELF_DEVELOPMENT).toBeUndefined();
  });

  it("une FAUTE DE FRAPPE échoue au lieu de désactiver en silence", () => {
    // C'est la raison du z.enum plutôt qu'un booléen : « enbaled » ne doit pas vouloir dire off.
    expect(() => loadEnv({ ICOS_SELF_DEVELOPMENT: "enbaled" })).toThrow();
    expect(() => loadEnv({ ICOS_SELF_DEVELOPMENT: "true" })).toThrow();
  });
});
describe("plafonds d'autonomie configurables (P0-E)", () => {
  it("rien de configuré = EXACTEMENT le plafond de politique historique", () => {
    expect(resolveAutonomyBounds(loadEnv({}))).toEqual(AUTONOMY_BOUNDS_CEILING);
    expect(AUTONOMY_BOUNDS_CEILING).toEqual({
      maxCycles: 100,
      maxRuntimeMs: 60 * 60 * 1000,
      maxStagnationCycles: 3,
      maxReplans: 5,
    });
  });

  it("un déploiement peut RESSERRER chaque borne", () => {
    const env = loadEnv({
      ICOS_AUTONOMY_MAX_CYCLES: "20",
      ICOS_AUTONOMY_MAX_RUNTIME_MS: "1800000",
      ICOS_AUTONOMY_MAX_REPLANS: "2",
      ICOS_AUTONOMY_MAX_STAGNATION_CYCLES: "2",
    });

    expect(resolveAutonomyBounds(env)).toEqual({
      maxCycles: 20,
      maxRuntimeMs: 30 * 60 * 1000,
      maxReplans: 2,
      maxStagnationCycles: 2,
    });
  });

  it("maxReplans = 0 est une valeur VALIDE (aucun replan autorisé)", () => {
    expect(resolveAutonomyBounds(loadEnv({ ICOS_AUTONOMY_MAX_REPLANS: "0" })).maxReplans).toBe(0);
  });

  it("REFUSE DE DÉMARRER si un déploiement tente d'ÉLARGIR au-dessus du plafond", () => {
    /* Un élargissement silencieusement ramené au plafond est une politique mensongère. */
    expect(() =>
      resolveAutonomyBounds(loadEnv({ ICOS_AUTONOMY_MAX_CYCLES: "100000" })),
    ).toThrow(/ICOS_AUTONOMY_BOUNDS_ABOVE_CEILING/);
    expect(() =>
      resolveAutonomyBounds(loadEnv({ ICOS_AUTONOMY_MAX_RUNTIME_MS: "86400000" })),
    ).toThrow(/ICOS_AUTONOMY_BOUNDS_ABOVE_CEILING/);
  });

  it("refuse une valeur non entière ou négative au chargement", () => {
    expect(() => loadEnv({ ICOS_AUTONOMY_MAX_CYCLES: "0" })).toThrow();
    expect(() => loadEnv({ ICOS_AUTONOMY_MAX_CYCLES: "vingt" })).toThrow();
    expect(() => loadEnv({ ICOS_AUTONOMY_MAX_REPLANS: "-1" })).toThrow();
  });
});

describe("pool de compute autorisé par le SYSTÈME (P0-F)", () => {
  it("absent = NON RESTREINT, état explicite et comportement d'avant", () => {
    expect(resolveSystemModelAllowlist(loadEnv({}))).toEqual(MODEL_ALLOWLIST_UNRESTRICTED);
  });

  it("une liste PRÉSENTE mais VIDE refuse de démarrer au lieu d'autoriser tout", () => {
    /*
     * Un gabarit émettant `ICOS_AUTONOMY_ALLOWED_MODELS=` veut dire « aucun », pas « tous ».
     * L'assertion précédente traitait la chaîne vide comme une absence et bénissait donc
     * « vide ⇒ TOUS les modèles » : le repli permissif que ce lot existe pour supprimer.
     */
    expect(() => loadEnv({ ICOS_AUTONOMY_ALLOWED_MODELS: "" })).toThrow();
    expect(() => loadEnv({ ICOS_AUTONOMY_ALLOWED_PROVIDERS: "" })).toThrow();
  });

  it("une liste déclarée borne le système, et elle seule", () => {
    const allowlist = resolveSystemModelAllowlist(
      loadEnv({ ICOS_AUTONOMY_ALLOWED_MODELS: "cheap-model, other-model" }),
    );

    expect(isModelAllowed(allowlist, "cheap-model")).toBe(true);
    expect(isModelAllowed(allowlist, "other-model")).toBe(true);
    expect(isModelAllowed(allowlist, "expensive-model")).toBe(false);
  });

  it("borne aussi les fournisseurs quand ils sont déclarés", () => {
    const allowlist = resolveSystemModelAllowlist(
      loadEnv({
        ICOS_AUTONOMY_ALLOWED_MODELS: "cheap-model",
        ICOS_AUTONOMY_ALLOWED_PROVIDERS: "omniroute",
      }),
    );

    expect(isModelAllowed(allowlist, "cheap-model", "omniroute")).toBe(true);
    expect(isModelAllowed(allowlist, "cheap-model", "autre-passerelle")).toBe(false);
  });

  it("REFUSE DE DÉMARRER si des fournisseurs sont déclarés sans modèles", () => {
    expect(() =>
      resolveSystemModelAllowlist(loadEnv({ ICOS_AUTONOMY_ALLOWED_PROVIDERS: "omniroute" })),
    ).toThrow(/ICOS_AUTONOMY_ALLOWED_PROVIDERS/);
  });

  it("refuse une liste malformée plutôt que de l'ignorer", () => {
    expect(() =>
      resolveSystemModelAllowlist(loadEnv({ ICOS_AUTONOMY_ALLOWED_MODELS: "cheap,,other" })),
    ).toThrow(/MODEL_ALLOWLIST_INVALID/);
  });
});

describe("resolveAuthConfig trusted origins", () => {
  const SECRET = "x".repeat(32);
  const CANONICAL = "https://macbook.example.ts.net";

  function resolve(trusted?: string) {
    return resolveAuthConfig(
      loadEnv({
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: CANONICAL,
        ...(trusted === undefined ? {} : { ICOS_AUTH_TRUSTED_ORIGINS: trusted }),
      }),
    );
  }

  it("trusts the base origin alone when nothing else is approved", () => {
    expect(resolve().trustedOrigins).toEqual([CANONICAL]);
  });

  it("adds explicitly approved origins without duplicating the base", () => {
    expect(resolve(`http://localhost:3310, ${CANONICAL}`).trustedOrigins).toEqual([
      CANONICAL,
      "http://localhost:3310",
    ]);
  });

  it.each(["*", "https://*.ts.net", "https://evil.test/path", "not-a-url"])(
    "refuses the non-exact origin %s",
    (entry) => {
      expect(() => resolve(entry)).toThrow(/ICOS_AUTH_TRUSTED_ORIGINS/);
    },
  );
});

import { z } from "zod";

import { resolveBounds, type RuntimeBounds } from "@/core/autonomy/bounds";
import {
  MODEL_ALLOWLIST_UNRESTRICTED,
  modelAllowlist,
  type MissionModelAllowlist,
} from "@/core/autonomy/model-allowlist";

/**
 * Les variables optionnelles vides (`FOO=`) sont traitées comme absentes :
 * copier `.env.example` tel quel reste valide.
 */
const emptyAsUndefined = (value: unknown) => (value === "" ? undefined : value);

const optionalSecret = z.preprocess(emptyAsUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyAsUndefined, z.url().optional());

const persistenceSchema = z.preprocess(emptyAsUndefined, z.enum(["memory", "postgres"]).optional());

const optionalPositiveInteger = z.preprocess(
  emptyAsUndefined,
  z.coerce.number().int().positive().optional(),
);

/* 0 est une valeur de politique LÉGITIME là où elle veut dire « aucun », pas « absent ». */
const optionalNonNegativeInteger = z.preprocess(
  emptyAsUndefined,
  z.coerce.number().int().nonnegative().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PERSISTENCE: persistenceSchema,
  DATABASE_URL: optionalUrl,
  // Authentification humaine (Better Auth). Requis lorsque l'auth réelle est
  // composée (backend postgres). Aucune valeur réelle committée.
  BETTER_AUTH_SECRET: optionalSecret,
  BETTER_AUTH_URL: optionalUrl,
  ICOS_OWNER_EMAIL: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  OPENAI_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  GITHUB_TOKEN: optionalSecret,
  N8N_BASE_URL: optionalUrl,
  N8N_API_KEY: optionalSecret,
  DOLIBARR_BASE_URL: optionalUrl,
  DOLIBARR_API_KEY: optionalSecret,
  // SkillsMP read-only discovery (optionnel — le provider échoue closed si absent)
  SKILLSMP_API_KEY: optionalSecret,
  // DigitalOS facade path (optional)
  DIGITALOS_FACADE_PATH: z.preprocess(emptyAsUndefined, z.string().optional()),
  /*
   * Worker health probe commands, per RUNTIME, as JSON (M6, defect 16). Example:
   *   {"binary":{"command":"/usr/local/bin/some-worker","args":["--version"]}}
   * Absent means only the `node` runtime is probeable; every other runtime is
   * recorded `unsupported` and routes nothing. No executable name is committed:
   * a deployment decides what "running" means for its runtimes.
   */
  ICOS_WORKER_PROBE_COMMANDS: z.preprocess(emptyAsUndefined, z.string().optional()),
  /*
   * Whether `startProductionServices` BOOTSTRAPS the declared compute fleet into the
   * worker registry at boot (live-worker bootstrap lane).
   *
   * DEFAULT OFF, and that is the point: registering a fleet writes to whatever
   * database this process resolved, so it is an explicit operator decision, never
   * something a deployment acquires by being upgraded. Off, the registry is only ever
   * written by `pnpm compute:register --apply`. On, every boot reconciles the registry
   * with what the provider serves — idempotently, and without resetting probe evidence
   * for a candidate whose declaration has not changed.
   *
   * Requires OMNIROUTE_BASE_URL/OMNIROUTE_API_KEY; a provider outage is reported and
   * never aborts startup, because the rest of the runtime must still boot.
   */
  /* Trimmed before parsing: a trailing space in a deployment variable is a typo, not a
   * reason to refuse to boot the whole runtime. An unrecognised WORD still throws. */
  ICOS_COMPUTE_BOOTSTRAP: z.preprocess(
    (v) => emptyAsUndefined(typeof v === "string" ? v.trim() : v),
    z.stringbool().optional(),
  ),
  /*
   * Budget for ONE model health probe over OmniRoute's HTTP API (live-worker bootstrap).
   *
   * Defaults to DEFAULT_HTTP_PROBE_TIMEOUT_MS (15s), chosen from measurement rather than
   * taste: 15 live candidates through a LOCAL gateway gave p95 5297ms and a worst probe of
   * 6305ms. Configurable because those are local numbers — a remote gateway must be
   * re-measured. Keep it low enough that one sweep (ceil(workers / 6) waves) finishes well
   * inside ICOS_WORKER_PROBE_INTERVAL_MS and the 120s evidence horizon, or healthy workers
   * flicker out of routable between sweeps.
   */
  ICOS_WORKER_PROBE_HTTP_TIMEOUT_MS: optionalPositiveInteger,
  /*
   * How often the durable `probe_workers` job sweeps the fleet (M6). Defaults to a
   * quarter of the health-evidence horizon, so evidence never expires between
   * sweeps. A value at or above the horizon is REFUSED at composition time.
   */
  ICOS_WORKER_PROBE_INTERVAL_MS: optionalPositiveInteger,
  /*
   * EXTERNAL WORKER EXECUTION (M6.3). Per RUNTIME, the non-interactive command that
   * makes a worker do work, as JSON. No executable, product or provider name is
   * committed: adding Hermes, Codex or anything else is configuration. Malformed
   * configuration REFUSES TO BOOT rather than silently executing nothing.
   */
  ICOS_WORKER_EXEC_COMMANDS: z.preprocess(emptyAsUndefined, z.string().optional()),
  /*
   * The failure taxonomy's recognisers, as JSON: per failure class, the regexes
   * that identify it, plus optional exit-code mappings. Provider-shaped strings
   * live HERE and never in the core.
   */
  ICOS_WORKER_FAILURE_CONFIG: z.preprocess(emptyAsUndefined, z.string().optional()),
  /** How long one execution may hold its fence before it can be taken over. */
  ICOS_WORKER_EXECUTION_LEASE_MS: optionalPositiveInteger,
  /** Where worker worktrees are created. Defaults to the OS temp directory. */
  ICOS_WORKER_WORKSPACE_ROOT: z.preprocess(emptyAsUndefined, z.string().optional()),
  /** The canonical repository. A writer worker is guaranteed NOT to run here. */
  ICOS_REPO_PATH: z.preprocess(emptyAsUndefined, z.string().optional()),
  /*
   * The Integration Gate's verification commands, as JSON (M9).
   *
   * The gate hardcodes `pnpm install/typecheck/lint/test/build`. A deployment using a
   * different package manager or different script names could not run the gate at all, so
   * this is configuration rather than a constant. Partial: anything omitted keeps its
   * default.
   */
  ICOS_GATE_COMMANDS: z.preprocess(emptyAsUndefined, z.string().optional()),
  /*
   * A LOCAL-PROCESS planner backend, as JSON (M12): `{"command":"...","args":[...]}` where
   * one arg contains `{{prompt}}`.
   *
   * The canonical planner owns every plan semantic; this only says which compute answers it.
   * No product, model or provider name is committed — a deployment names the binary, exactly
   * as it does for worker probe and exec commands. Malformed configuration REFUSES TO BOOT
   * rather than silently leaving ICOS unable to plan.
   */
  ICOS_PLANNER_COMMAND: z.preprocess(emptyAsUndefined, z.string().optional()),
  /**
   * The local-process REVIEWER backend, same shape and same rules as the planner's (M13).
   * The canonical review policy, vocabulary and schema are unchanged; this only says which
   * compute answers them.
   */
  ICOS_REVIEWER_COMMAND: z.preprocess(emptyAsUndefined, z.string().optional()),
  ICOS_EXECUTION_CALLBACK_SECRET: optionalSecret,
  AUTONOMY_RECOVERY_INTERVAL_MS: optionalPositiveInteger,
  /**
   * Interrupteur du PASSAGE d'auto-amélioration gouvernée sur le timer de production.
   * Absent = `disabled` : le coordinateur reste joignable mais ICOS ne se modifie jamais
   * de lui-même tant que le propriétaire ne l'a pas activé explicitement. Énumération et
   * non booléen : une faute de frappe échoue à la validation au lieu de désactiver en silence
   * une capacité que l'on croit active.
   */
  /**
   * Plafond de tokens par goal — LE SEUL plafond réellement applicable aujourd'hui, la table
   * de prix étant vide (tout appel est donc UNPRICED et aucun plafond monétaire ne peut être
   * déclaré satisfait).
   *
   * Absent = aucun plafond de tokens. Conséquence, fermée et visible, jamais silencieuse : un
   * goal sans budget monétaire n'a alors RIEN d'applicable et ses complétions de mission sont
   * refusées (`NO_ENFORCEABLE_CAP`). Renseigner cette variable est donc la condition pour
   * qu'une mission autonome puisse dépenser quoi que ce soit.
   */
  ICOS_GOAL_MAX_TOTAL_TOKENS: optionalPositiveInteger,
  /**
   * PLAFOND DU BUDGET DE CONVERSATION, en tokens, PAR CONVERSATION (décision du
   * propriétaire : deux portées de budget distinctes).
   *
   * Parler à ICOS n'est pas du travail de goal et ne doit jamais entamer le budget
   * d'exécution d'un goal. Absent = `DEFAULT_CONVERSATION_MAX_TOTAL_TOKENS`, qui est une
   * borne réelle et non une absence de borne : ICOS doit pouvoir parler sur un déploiement
   * par défaut, mais jamais sans limite.
   */
  ICOS_CONVERSATION_MAX_TOTAL_TOKENS: optionalPositiveInteger,
  /**
   * SORTIE MAXIMALE imposée à un appel de complétion qui n'en déclare aucune (verrou C1).
   *
   * Le plafond est écrit DANS la requête et il est réservé avant l'émission, donc il borne
   * réellement la dépense. Il a un coût : une réponse STRUCTURÉE plus longue que ce plafond
   * est tronquée par le fournisseur, et un JSON tronqué est un JSON invalide. Le
   * planificateur le signale alors en `INVALID_RESPONSE` — bruyant et récupérable, jamais un
   * plan silencieusement amputé — mais c'est une panne de disponibilité, et c'est pourquoi
   * ce levier existe : un déploiement qui planifie de grosses missions doit pouvoir le lever.
   *
   * Absent = `DEFAULT_MAX_OUTPUT_TOKENS`.
   */
  ICOS_MAX_OUTPUT_TOKENS: optionalPositiveInteger,
  /**
   * NOMS DE VARIABLES que les workers externes ont le droit d'hériter, séparés par des
   * virgules, EN PLUS de la liste blanche de plateforme (`child-environment.ts`).
   *
   * Un processus enfant n'hérite plus de `process.env` : il voyait auparavant
   * `DATABASE_URL` et toutes les clés d'API, ce qui faisait de tout agent CLI un pair de
   * confiance du serveur. Ouvrir une variable ici est donc une décision de déploiement,
   * explicite et nommée — jamais un défaut.
   *
   * Exemple : `ICOS_WORKER_ENV_PASSTHROUGH=ANTHROPIC_API_KEY,NVIDIA_API_KEY`
   */
  ICOS_WORKER_ENV_PASSTHROUGH: z.string().optional(),
  /*
   * PLAFOND DE DÉPLOIEMENT des bornes d'UNE mission autonome (P0-E). Ces quatre valeurs
   * étaient codées en dur (100 cycles / 60 min / 5 replans / 3 cycles de stagnation) ;
   * elles restent le plafond de POLITIQUE (`AUTONOMY_BOUNDS_CEILING`) et un déploiement
   * ne peut que le RESSERRER.
   *
   * Absentes = exactement le comportement historique. Une valeur AU-DESSUS du plafond
   * refuse de démarrer (`resolveAutonomyBounds`) au lieu d'être ramenée en silence : un
   * plafond qu'on croit à 24 h et qui vaut 1 h est une politique mensongère.
   *
   * Un goal, lui, ne peut que resserrer encore ce plafond-ci — voir
   * `startAutonomousMission` (`input.bounds`).
   */
  ICOS_AUTONOMY_MAX_CYCLES: optionalPositiveInteger,
  ICOS_AUTONOMY_MAX_RUNTIME_MS: optionalPositiveInteger,
  ICOS_AUTONOMY_MAX_STAGNATION_CYCLES: optionalPositiveInteger,
  /** 0 = aucun replan autorisé. C'est la borne la plus serrée, pas une absence. */
  ICOS_AUTONOMY_MAX_REPLANS: optionalNonNegativeInteger,
  /*
   * POOL DE COMPUTE AUTORISÉ PAR LE SYSTÈME (P0-F), listes séparées par des virgules.
   *
   * Absent = NON RESTREINT : l'état explicite `unrestricted`, c'est-à-dire le
   * comportement d'avant cette lane, et la SEULE façon de l'obtenir. Déclarées, ces
   * listes deviennent le plafond qu'une politique de goal ne peut que réduire : un goal
   * ne s'octroie JAMAIS un modèle que le système n'autorisait pas.
   *
   * Déclarer des fournisseurs sans modèles refuse de démarrer : « seulement ces
   * fournisseurs, tous modèles » n'est pas exprimable dans une liste d'autorisation.
   */
  /*
   * CES DEUX-LÀ NE TRAITENT PAS LA CHAÎNE VIDE COMME UNE ABSENCE.
   *
   * Pour une liste d'AUTORISATION, `FOO=` est ambigu : un gabarit de déploiement qui l'émet
   * veut presque toujours dire « aucun modèle », alors que l'absence veut dire « non
   * restreint ». Les confondre transformait un gabarit vide en « TOUS les modèles autorisés »
   * — exactement le repli permissif que ce lot existe pour supprimer. Une valeur présente mais
   * vide REFUSE donc de démarrer, au lieu de choisir à la place de l'opérateur.
   *
   * Conséquence assumée : ces deux variables ne figurent pas, vides, dans `.env.example`.
   */
  ICOS_AUTONOMY_ALLOWED_MODELS: z
    .string()
    .min(1, "ICOS_AUTONOMY_ALLOWED_MODELS vide : ambigu, l'omettre pour « non restreint »")
    .optional(),
  ICOS_AUTONOMY_ALLOWED_PROVIDERS: z
    .string()
    .min(1, "ICOS_AUTONOMY_ALLOWED_PROVIDERS vide : ambigu, l'omettre pour « non restreint »")
    .optional(),
  ICOS_SELF_DEVELOPMENT: z.preprocess(
    emptyAsUndefined,
    z.enum(["enabled", "disabled"]).optional(),
  ),
  SCHEDULER_LEASE_MS: optionalPositiveInteger,
  TEMPORAL_ADDRESS: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  TEMPORAL_TASK_QUEUE: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  TEMPORAL_WORKFLOW_TYPE: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  TEMPORAL_DISPATCH_TIMEOUT_MS: optionalPositiveInteger,
  // OmniRoute configuration
  OMNIROUTE_BASE_URL: optionalUrl,
  OMNIROUTE_API_KEY: optionalSecret,
  ICOS_PLANNER_MODEL: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  ICOS_PLANNER_TIMEOUT_MS: optionalPositiveInteger,
  ICOS_REVIEWER_MODEL: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  ICOS_REVIEWER_TIMEOUT_MS: optionalPositiveInteger,
});

export type Env = z.infer<typeof envSchema>;

/** Configuration d'authentification résolue (secret ≥ 32 caractères, URL). */
export interface AuthConfig {
  secret: string;
  baseURL: string;
}

/**
 * Résout la configuration d'authentification réelle. Échoue explicitement si le
 * secret (≥ 32 caractères) ou l'URL manquent — jamais de valeur par défaut
 * faible, jamais de secret journalisé.
 */
export function resolveAuthConfig(env: Env): AuthConfig {
  if (env.BETTER_AUTH_SECRET === undefined || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error(
      "BETTER_AUTH_SECRET est requis (≥ 32 caractères) pour l'authentification humaine.",
    );
  }
  if (env.BETTER_AUTH_URL === undefined) {
    throw new Error("BETTER_AUTH_URL est requis pour l'authentification humaine.");
  }
  return { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL };
}

/**
 * Résout le PLAFOND DE DÉPLOIEMENT des bornes d'autonomie (P0-E).
 *
 * Réutilise `resolveBounds`, l'unique autorité de résolution : la configuration est
 * traitée exactement comme n'importe quelle demande, donc elle ne peut que RÉDUIRE
 * `AUTONOMY_BOUNDS_CEILING`. Différence assumée avec un goal : un élargissement demandé
 * par un GOAL est rogné et rapporté, un élargissement écrit dans la CONFIGURATION D'UN
 * DÉPLOIEMENT refuse de démarrer — personne ne lit un rapport de rognage au boot.
 */
export function resolveAutonomyBounds(env: Env): RuntimeBounds {
  const { bounds, clamped } = resolveBounds({
    ...(env.ICOS_AUTONOMY_MAX_CYCLES !== undefined
      ? { maxCycles: env.ICOS_AUTONOMY_MAX_CYCLES }
      : {}),
    ...(env.ICOS_AUTONOMY_MAX_RUNTIME_MS !== undefined
      ? { maxRuntimeMs: env.ICOS_AUTONOMY_MAX_RUNTIME_MS }
      : {}),
    ...(env.ICOS_AUTONOMY_MAX_STAGNATION_CYCLES !== undefined
      ? { maxStagnationCycles: env.ICOS_AUTONOMY_MAX_STAGNATION_CYCLES }
      : {}),
    ...(env.ICOS_AUTONOMY_MAX_REPLANS !== undefined
      ? { maxReplans: env.ICOS_AUTONOMY_MAX_REPLANS }
      : {}),
  });

  if (clamped.length > 0) {
    throw new Error(`ICOS_AUTONOMY_BOUNDS_ABOVE_CEILING:${clamped.join(",")}`);
  }

  return bounds;
}

/**
 * Résout le pool de compute autorisé par le SYSTÈME (P0-F).
 *
 * C'est l'autorité de référence : une politique de goal ne peut que la réduire
 * (`narrowModelAllowlist`). Absent = `unrestricted`, un état NOMMÉ et non un repli.
 */
export function resolveSystemModelAllowlist(env: Env): MissionModelAllowlist {
  const models = splitIds(env.ICOS_AUTONOMY_ALLOWED_MODELS);
  const providers = splitIds(env.ICOS_AUTONOMY_ALLOWED_PROVIDERS);

  if (models === undefined) {
    if (providers !== undefined) {
      throw new Error(
        "ICOS_AUTONOMY_ALLOWED_PROVIDERS_WITHOUT_MODELS: déclarer des fournisseurs autorisés exige de déclarer aussi les modèles autorisés",
      );
    }

    return MODEL_ALLOWLIST_UNRESTRICTED;
  }

  return modelAllowlist(models, providers);
}

/**
 * `undefined` (variable absente) et une liste sont deux états distincts ; une entrée
 * vide n'est PAS écartée, elle est transmise telle quelle pour que `modelAllowlist`
 * refuse la configuration au lieu de l'ignorer.
 */
function splitIds(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(",").map((id) => id.trim());
}

/**
 * Validation à la demande : aucune exécution au chargement du module, afin que
 * l'application démarre sans aucun service externe configuré. Les intégrations
 * restent désactivées tant que leurs adaptateurs n'existent pas.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

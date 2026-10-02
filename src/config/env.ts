import { z } from "zod";

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
 * Validation à la demande : aucune exécution au chargement du module, afin que
 * l'application démarre sans aucun service externe configuré. Les intégrations
 * restent désactivées tant que leurs adaptateurs n'existent pas.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

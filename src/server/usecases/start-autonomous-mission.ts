import type { MissionRepository } from "@/server/mission/ports";
import { runWithAttribution } from "@/server/budget/attribution-context";
import type { AutonomousMissionRuntimeRepository } from "@/server/autonomy/runtime";
import {
  AUTONOMY_BOUNDS_CEILING,
  resolveBounds,
  type RequestedBounds,
  type RuntimeBounds,
} from "@/core/autonomy/bounds";
import {
  decideModel,
  narrowModelAllowlist,
  resolveModelAllowlist,
  type MissionModelAllowlist,
  type ModelCandidate,
  type RequestedComputePolicy,
} from "@/core/autonomy/model-allowlist";
import {
  AutonomousMissionRunner,
  type AutonomousMissionPlanner,
  type AutonomousSupervisor,
  type AutonomousMissionRunnerOptions,
  type AutonomousMissionRunnerResult,
} from "@/server/autonomy/autonomous-mission-runner";

/**
 * Phase 6 — Autonomous mission ignition.
 *
 * This is the single production entry point that makes "one objective is
 * enough". It does NOT introduce a second runner, planner or supervisor: it
 * composes the existing canonical `AutonomousMissionRunner` so that a freshly
 * created mission (objective + empty or seeded graph) begins executing without
 * any further manual step.
 *
 * Control flow after ignition is entirely owned by the existing pipeline:
 *   - runner bootstraps a durable runtime (createIfAbsent) and claims the lease;
 *   - initial planning (tasks.length === 0) calls the real planner and persists
 *     the validated DAG through the repository's atomic applyPlan();
 *   - the supervisor prepares + dispatches ready tasks through the durable
 *     dispatch ledger;
 *   - worker callbacks resume through AutonomyWakeupService;
 *   - quality control, correction, retry, replan, recovery and completion
 *     gating all remain the Phase 3/4/5 code paths.
 *
 * Invariants preserved:
 *   - ownership/fencing: the runner claims the runtime lease; a losing caller
 *     receives `waiting`/`AUTONOMY_RUNTIME_ALREADY_OWNED` and must not mutate;
 *   - budgets: cycle/runtime/stagnation/replan budgets are the runtime's own
 *     durable values, never widened here. A caller MAY request tighter bounds
 *     for a *fresh* mission (`input.bounds`); the request is resolved against
 *     the ceiling in `@/core/autonomy/bounds`, may only narrow, and a widening
 *     attempt is clamped and reported in `clampedBounds`. Re-igniting an
 *     existing runtime reuses its persisted caps and ignores the request —
 *     the runner enforces `runtime.max*`, not these options;
 *   - pool de compute: un goal PEUT restreindre les modèles/fournisseurs de sa mission
 *     (`input.computePolicy`), et seulement les restreindre. La demande est réduite
 *     contre le pool autorisé par le système (`deps.systemModelAllowlist`); un id que
 *     le système n'autorisait pas est REFUSÉ, jamais accordé, et l'allumage échoue
 *     avant tout effet de bord. Voir `assertComputePermitted`;
 *   - fail-closed: an unavailable planner surfaces as a thrown planner error,
 *     never an implicit empty plan or false success;
 *   - idempotency: re-igniting an existing runtime is safe — createIfAbsent is a
 *     no-op and the runner resumes the persisted runtime instead of resetting
 *     counters.
 */
/**
 * Ce que la COMPOSITION (le conteneur) sait et que l'allumage doit appliquer : le
 * plafond du déploiement et le pool de compute que le système autorise. Un seul type,
 * transporté tel quel par `igniteAutonomousMission`, pour qu'aucun maillon n'ait à
 * reconstruire la politique — ni à en inventer une.
 */
export interface AutonomyCompositionPolicy {
  /** Plafond du déploiement. Absent = `AUTONOMY_BOUNDS_CEILING`, comme avant. */
  options?: AutonomousMissionRunnerOptions;

  /**
   * Pool de compute autorisé PAR LE SYSTÈME. Absent devient l'état explicite
   * `unrestricted` à l'unique frontière prévue pour ça (`resolveModelAllowlist`).
   */
  systemModelAllowlist?: MissionModelAllowlist;

  /**
   * Le compute que ce processus utilisera RÉELLEMENT pour planifier (le modèle
   * configuré, et le fournisseur qui le sert). Absent / sans modèle = irrésoluble :
   * sous un pool restreint, c'est un REFUS, jamais un laissez-passer.
   */
  plannerCompute?: Partial<ModelCandidate>;
}

export interface StartAutonomousMissionDeps extends AutonomyCompositionPolicy {
  missions: Pick<MissionRepository, "findById" | "listTasks" | "applyPlan" | "replacePlan">;
  runtimeRepository: AutonomousMissionRuntimeRepository;
  supervisor: AutonomousSupervisor;
  planner: AutonomousMissionPlanner;
  now?: () => Date;
}

export interface StartAutonomousMissionInput {
  missionId: string;
  goalId?: string;

  /**
   * Optional per-mission runtime bounds. Absent fields keep the ceiling value,
   * so omitting `bounds` entirely is byte-identical to the previous behaviour.
   */
  bounds?: RequestedBounds;

  /**
   * Pool de compute demandé par CE goal. Il ne peut que RÉDUIRE le pool système :
   * demander un modèle ou un fournisseur hors de celui-ci refuse l'allumage.
   */
  computePolicy?: RequestedComputePolicy;
}

const DEFAULT_OPTIONS: AutonomousMissionRunnerOptions = AUTONOMY_BOUNDS_CEILING;

export async function startAutonomousMission(
  deps: StartAutonomousMissionDeps,
  input: StartAutonomousMissionInput,
): Promise<AutonomousMissionRunnerResult> {
  const baseOptions = deps.options ?? DEFAULT_OPTIONS;

  /*
   * No request -> the base options are used verbatim, exactly as before.
   * A request -> resolved against those same options as the ceiling, so an
   * injected (tighter) deployment configuration can never be widened either.
   */
  const resolved = input.bounds ? resolveBounds(input.bounds, ceilingOf(baseOptions)) : null;

  /* Avant tout effet de bord : une politique de compute refusée n'allume rien. */
  assertComputePermitted(deps, input.computePolicy);

  const mission = await deps.missions.findById(input.missionId);
  if (!mission) {
    throw new Error(`START_AUTONOMOUS_MISSION_NOT_FOUND:${input.missionId}`);
  }

  const runner = new AutonomousMissionRunner(
    deps.missions,
    deps.supervisor,
    deps.planner,
    resolved ? { ...baseOptions, ...resolved.bounds } : baseOptions,
    deps.now ?? (() => new Date()),
    deps.runtimeRepository,
  );

  /*
   * PORTÉE D'IMPUTATION DE LA DÉPENSE (verrou B1). C'est l'allumage qui connaît le goal ;
   * les adaptateurs, eux, sont construits une fois pour le processus. Tout appel mesuré
   * descendant de `run` est donc imputé ici, sans qu'aucune signature intermédiaire change.
   *
   * LA CLÉ EST LE GOAL SEUL, pas (mission, goal) : `attributionKey` dérive la fenêtre de
   * TOUTE l'imputation, donc y ajouter la mission donnerait à chaque mission une copie
   * NEUVE du budget de son goal — N missions, N fois le budget. Or c'est le goal qui porte
   * `budget`, c'est donc lui qu'on accumule.
   *
   * Le `goalId` vient de la MISSION PERSISTÉE, la seule autorité sur ce lien (`input.goalId`
   * reste inutilisé, comme avant). Une mission sans goal n'ouvre AUCUNE portée : l'appel est
   * alors non imputé et le journal le refuse. Fermé par défaut — une mission qu'aucun budget
   * ne couvre ne dépense pas, et surtout on ne lui en fabrique pas un.
   */
  const run = () => runner.run(input.missionId);
  const result = await (mission.goalId
    ? runWithAttribution({ goalId: mission.goalId }, run)
    : run());

  if (resolved && resolved.clamped.length > 0) {
    return { ...result, clampedBounds: resolved.clamped };
  }

  return result;
}

/**
 * LA COUTURE D'APPLICATION du pool de compute (P0-F).
 *
 * C'est ici que le modèle d'une mission est arrêté : le planificateur est construit une
 * fois pour le processus (`container.ts`), donc le modèle qu'il utilisera est connu, et
 * cet allumage est le seul passage obligé avant qu'il ne serve. Trois états, jamais deux :
 *
 *   - pool système `unrestricted` et aucune politique de goal -> rien n'est vérifié,
 *     comportement d'avant au bit près ;
 *   - pool borné (par le système, par le goal, ou par les deux) -> le modèle configuré
 *     doit y figurer, SINON REFUS ;
 *   - un id demandé par le goal que le système n'autorisait pas -> REFUS nommé. Jamais
 *     accordé, jamais rogné en silence.
 *
 * Aucun repli permissif : `?? ""` ci-dessous est un repli REFUSANT (`MODEL_ID_INVALID`),
 * exigé par « un modèle irrésoluble sous un goal restreint est refusé ». Le sélecteur à
 * deux états dont le repli est permissif est précisément le fail-open déjà livré deux fois
 * ici.
 */
function assertComputePermitted(
  deps: AutonomyCompositionPolicy,
  requested: RequestedComputePolicy | undefined,
): void {
  const narrowed = narrowModelAllowlist(
    resolveModelAllowlist(deps.systemModelAllowlist),
    requested,
  );

  if (narrowed.refused.length > 0) {
    throw new Error(`START_AUTONOMOUS_MISSION_COMPUTE_REFUSED:${narrowed.refused.join(",")}`);
  }

  if (narrowed.allowlist.mode === "unrestricted") {
    return;
  }

  const decision = decideModel(narrowed.allowlist, {
    modelId: deps.plannerCompute?.modelId ?? "",
    ...(deps.plannerCompute?.providerId !== undefined
      ? { providerId: deps.plannerCompute.providerId }
      : {}),
  });

  if (!decision.allowed) {
    throw new Error(`START_AUTONOMOUS_MISSION_COMPUTE_REFUSED:${decision.reason}`);
  }
}

function ceilingOf(options: AutonomousMissionRunnerOptions): RuntimeBounds {
  return {
    maxCycles: options.maxCycles,
    maxRuntimeMs: options.maxRuntimeMs,
    maxStagnationCycles: options.maxStagnationCycles,
    maxReplans: options.maxReplans ?? AUTONOMY_BOUNDS_CEILING.maxReplans,
  };
}

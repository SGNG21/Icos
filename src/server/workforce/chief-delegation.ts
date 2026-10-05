import {
  classifyRawObjective,
  type ClassifiedObjective,
} from "@/core/chief/objective-classification";
import {
  planObjectiveDelegation,
  type DelegationAssignment,
  type DelegationLimits,
  type DelegationPlan,
  type DelegationRefusal,
} from "@/core/chief/delegation";
import type { HighLevelGoal } from "@/core/contracts/high-level-goal";
import { UNKNOWN } from "@/core/supervisor/contracts";
import {
  classifyObjective,
  DEFAULT_PRIORITY_POLICY,
  type PriorityPolicy,
} from "@/core/supervisor/priority";
import type { DelegationGap } from "@/core/workforce/delegation";
import type { WorkAssignment, WorkRequest } from "@/core/workforce/contracts";
import type { Principal } from "@/core/workforce/governance";

import type { BrainRegistry } from "./brain-registry";
import type { WorkforceStore } from "./ports";
import type { WorkforceService } from "./workforce-service";

/**
 * GOAL → CHIEF → CERVEAU → AFFECTATION (verrou C6). LE chaînon qui manquait.
 *
 * ── CE QUI ÉTAIT CASSÉ ──────────────────────────────────────────────────────────────────
 * Trois morceaux parfaits, aucun relié : `planObjectiveDelegation` (qui décide quel cerveau
 * prend quelle part), `WorkforceService.delegate` (qui enregistre une affectation gouvernée)
 * et `workforceTaskCompute` (que CORE3 consulte au dispatch) n'avaient AUCUN appelant entre
 * eux. Les douze cerveaux étaient donc zéro ligne, et même seedés ils auraient été douze
 * lignes que le dispatcheur ignore, faute de quoi que ce soit qui crée une affectation.
 *
 * ── CE QUE CE FICHIER FAIT, ET RIEN DE PLUS ─────────────────────────────────────────────
 *   1. CLASSER l'objectif (`classifyRawObjective`, autorité unique de la classe de travail) ;
 *   2. PLANIFIER (`planObjectiveDelegation`, autorité unique du choix de cerveau) ;
 *   3. ENREGISTRER (`WorkforceService.delegate`, autorité unique de l'affectation gouvernée).
 *
 * Il ne crée AUCUNE autorité : pas de second ordonnanceur, pas de second matcher, pas de
 * seconde politique d'approbation. Il traduit un plan en demandes de travail et laisse la
 * gouvernance refuser ce qu'elle doit refuser.
 *
 * ── CE QU'IL NE FAIT PAS ────────────────────────────────────────────────────────────────
 * Il n'EXÉCUTE rien. Une affectation est un engagement durable ; c'est CORE3 qui dispatche,
 * via `workforceTaskCompute.forTask`, qui lit ces affectations et ne peut que RESSERRER le
 * dispatch. Le cerveau n'est ni le worker, ni le modèle, ni le fournisseur — il dit quelle
 * compétence et quelle autorité portent ce travail, jamais avec quoi on le fait.
 */

/**
 * L'identifiant de l'affectation de RELECTURE, qui n'est PAS une tâche CORE3 : la relecture
 * est rendue par le `ReviewerService`, pas dispatchée. Clé d'idempotence d'une affectation
 * hors-tâche, et rien d'autre — jamais une clé de jointure avec le dispatch.
 */
export const reviewAssignmentTaskId = (missionId: string): string => `${missionId}:review`;

/**
 * La tâche telle que le pont la voit : l'identité DURABLE CORE3 (`mission_tasks.task_id`,
 * celle que le superviseur passe à `forTask`) et la capacité que le planificateur a déclarée,
 * s'il en a déclaré une.
 */
export interface BindableTask {
  readonly taskId: string;
  readonly capability?: string | null;
  /** CORE3's own status. A finished or superseded task gives its brain's slot back. */
  readonly status?: string | null;
}

/** Task statuses after which an assignment only holds capacity hostage. */
export const RELEASABLE_TASK_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
]);

export interface TaskBinding {
  readonly taskId: string;
  readonly stages: readonly DelegationAssignment[];
}

/**
 * LE PONT, en une règle déterministe (décision 0070).
 *
 * Une tâche qui DÉCLARE une capacité va à l'étape (ou aux étapes) du plan qui la porte :
 * `code_write` en auto-amélioration lie Evolution ET Builder, et `forTask` compose la plus
 * stricte. Une tâche qui n'en déclare aucune — le cas réel : 23 tâches sur 26 en base —
 * appartient au CERVEAU DE TÊTE de la classe de travail, l'étape de vague 0 : Planner pour un
 * objectif logiciel, Evolution pour l'auto-amélioration, Recovery pour une réparation,
 * Business pour un client. Une tâche dont la capacité ne correspond à aucune étape n'est PAS
 * devinée vers le cerveau de tête : elle est rendue non liée, visible, et dispatchée comme
 * avant.
 */
export function planTaskBindings(
  plan: Pick<DelegationPlan, "assignments">,
  tasks: readonly BindableTask[],
): { bound: TaskBinding[]; unbound: BindableTask[] } {
  const lowestWave = Math.min(...plan.assignments.map((a) => a.wave));
  const leads = plan.assignments.filter((a) => a.wave === lowestWave);
  const bound: TaskBinding[] = [];
  const unbound: BindableTask[] = [];
  for (const task of tasks) {
    const capability = task.capability?.trim();
    const stages = capability ? plan.assignments.filter((a) => a.capability === capability) : leads;
    if (stages.length === 0) unbound.push(task);
    else bound.push({ taskId: task.taskId, stages });
  }
  return { bound, unbound };
}

export type ChiefDelegationOutcome =
  | {
      readonly ok: true;
      readonly plan: DelegationPlan;
      readonly assignments: readonly WorkAssignment[];
      /** Ce que la gouvernance a refusé. Non vide ne veut PAS dire que rien n'a été fait. */
      readonly gaps: readonly DelegationGap[];
      /** Tâches CORE3 qu'aucune étape du plan ne couvre : dispatchées sans cerveau, dit tel quel. */
      readonly unbound: readonly BindableTask[];
      /** Tâches déjà liées avant cet appel : la délégation est idempotente par tâche et cerveau. */
      readonly alreadyBound: number;
      /** Affectations rendues : tâche remplacée par un replan, ou terminée. */
      readonly released: number;
    }
  | {
      readonly ok: false;
      readonly refusals: readonly DelegationRefusal[];
      /** Aucun travail n'a été enregistré : le refus précède tout effet de bord. */
      readonly classified: ClassifiedObjective;
    };

export interface ChiefDelegationDeps {
  readonly registry: BrainRegistry;
  readonly service: Pick<WorkforceService, "delegate" | "cancel">;
  /** Les affectations existantes du tenant : ce qui rend un second appel idempotent. */
  readonly store: Pick<WorkforceStore, "listAssignments">;
  /**
   * Le principal du CHIEF. C'est lui qui délègue, donc lui que la gouvernance contrôle : la
   * workforce n'accorde une affectation qu'à un rapport DIRECT du délégant, et les onze
   * autres cerveaux rapportent à `brain-chief`. Un autre principal ne pourrait rien déléguer,
   * ce qui est exactement la protection voulue.
   */
  readonly chief: Principal;
  readonly limits?: DelegationLimits;
  /**
   * La politique dont dérive la classe de travail D'APRÈS LA FICHE du goal. Par défaut la
   * MÊME que celle de l'admission (`ObjectiveCoordinator`) : deux politiques donneraient
   * deux classes pour un seul goal, donc deux portefeuilles.
   */
  readonly priorityPolicy?: PriorityPolicy;
}

/**
 * Plafonds par défaut de la délégation d'un objectif.
 *
 * `maxAutonomyLevel: 2` — PAS 3. Le niveau 3 est celui du Chief lui-même ; le lui accorder
 * en délégation reviendrait à ce qu'un objectif confère l'autonomie maximale à un exécutant.
 * Un plafond se déclare, il ne se déduit pas du silence.
 */
export const DEFAULT_DELEGATION_LIMITS: DelegationLimits = Object.freeze({
  maxParallelAssignments: 4,
  maxAutonomyLevel: 2,
});

export interface ChiefDelegation {
  /**
   * Délègue l'objectif d'une mission à ses cerveaux, TÂCHE PAR TÂCHE : chaque affectation
   * porte l'identité durable CORE3 de la tâche qu'elle gouverne, celle que le dispatch lit.
   * Idempotent : une tâche déjà affectée à ce cerveau n'est pas réaffectée.
   */
  delegateGoal(
    goal: HighLevelGoal,
    missionId: string,
    tasks: readonly BindableTask[],
  ): Promise<ChiefDelegationOutcome>;
}

export function chiefDelegation(deps: ChiefDelegationDeps): ChiefDelegation {
  const limits = deps.limits ?? DEFAULT_DELEGATION_LIMITS;

  return {
    async delegateGoal(goal, missionId, tasks) {
      /*
       * DEUX SOURCES DE CLASSE, UNE PRÉCÉDENCE ÉCRITE — et aucun troisième classificateur.
       *
       *   1. LE TEXTE du propriétaire (`classifyRawObjective`). Il ne reconnaît que ce dont
       *      il est sûr — auto-amélioration, client — et rend UNKNOWN pour tout le reste
       *      plutôt que de deviner. Quand il est sûr, il GAGNE : « Améliore ICOS » est de
       *      l'auto-amélioration quoi que dise une métadonnée, et c'est le même chemin que
       *      la phrase ait été tapée ou dite.
       *
       *   2. LA FICHE du goal (`classifyObjective`), l'autorité que l'ADMISSION utilise
       *      déjà. Reprendre la sienne plutôt qu'en écrire une autre garantit qu'un goal
       *      n'est pas rangé dans une classe par le portefeuille et dans une autre par le
       *      Chief — sans quoi un plafond de classe borderait un travail et le Chief en
       *      déléguerait un autre.
       *
       * Le texte d'abord parce qu'il est la demande EXPLICITE ; la fiche ensuite parce
       * qu'elle est une déduction. On ne devine jamais : si les deux se taisent, la fiche
       * rend sa classe par défaut et la forme de délégation décidera si elle est routable.
       */
      const spoken = classifyRawObjective(goal.rawInput || goal.objective);
      const classified: ClassifiedObjective =
        spoken.workClass === UNKNOWN
          ? {
              ...spoken,
              workClass: classifyObjective(deps.priorityPolicy ?? DEFAULT_PRIORITY_POLICY, goal)
                .class,
            }
          : spoken;
      const brains = await deps.registry.list(deps.chief.tenantId);
      const outcome = planObjectiveDelegation(classified, brains, limits);
      if (!outcome.ok) return { ok: false, refusals: outcome.refusals, classified };

      /*
       * Les étapes DIFFÉRÉES ne sont pas enregistrées : elles sont dues, pas accordées. Les
       * enregistrer comme affectations ferait croire au dispatcheur qu'un cerveau au-dessus
       * de sa capacité travaille déjà. Elles restent dans le plan, visibles, et une
       * délégation ultérieure les reprendra — même identifiant d'étape, donc pas de doublon.
       */
      /*
       * IDEMPOTENCE PAR (TÂCHE, CERVEAU). `planDelegation` ne dédoublonne rien : relancer la
       * délégation à chaque passage du superviseur recréerait les mêmes affectations et
       * consommerait la capacité du Chief jusqu'au refus. Une affectation annulée ne compte
       * pas : le Chief a retiré ce travail, le réaffecter est une nouvelle décision.
       */
      const existing = (await deps.store.listAssignments(deps.chief.tenantId)).filter(
        (a) => a.missionId === missionId && a.status !== "cancelled",
      );

      /*
       * LE CHIEF REPLANIFIE EXPLICITEMENT (propriété 6 du propriétaire) : une tâche que le
       * replan a remplacée, ou qui est terminée, rend le créneau de son cerveau. Sans cela une
       * affectation par tâche consomme la concurrence du cerveau de tête jusqu'à la fin de la
       * mission — mesuré : trois tâches remplacées tenaient les trois créneaux de Planner et
       * la mission suivante était refusée CONCURRENCY_LIMIT. La relecture n'est pas une tâche
       * et n'est rendue qu'avec la mission.
       */
      const live = new Set(
        tasks.filter((t) => !RELEASABLE_TASK_STATUSES.has(t.status ?? "")).map((t) => t.taskId),
      );
      const reviewKey = reviewAssignmentTaskId(missionId);
      const stale = existing.filter(
        (a) => a.taskId !== reviewKey && !live.has(a.taskId) && a.status === "assigned",
      );
      for (const a of stale) {
        await deps.service.cancel(deps.chief, a.assignmentId, "task replaced or finished");
      }
      const staleIds = new Set(stale.map((a) => a.assignmentId));
      const taken = new Set(
        existing
          .filter((a) => !staleIds.has(a.assignmentId))
          .map((a) => `${a.taskId}|${a.assigneeAgentId}`),
      );

      const { bound, unbound } = planTaskBindings(
        outcome.plan,
        tasks.filter((t) => live.has(t.taskId)),
      );
      const requests: WorkRequest[] = [];
      let alreadyBound = 0;
      for (const binding of bound) {
        for (const stage of binding.stages) {
          if (taken.has(`${binding.taskId}|${stage.brainId}`)) {
            alreadyBound++;
            continue;
          }
          requests.push({
            missionId,
            /* L'IDENTITÉ DURABLE CORE3, jamais une convention de nommage. */
            taskId: binding.taskId,
            taskType: stage.stage,
            requiredCapabilities: [stage.capability],
            scope: {},
            /* Une unité par tâche : le coût réel est mesuré par le budget, pas estimé ici. */
            computeUnits: 1,
            requiredAgentId: stage.brainId,
          });
        }
      }
      const review = outcome.plan.review;
      if (!taken.has(`${reviewAssignmentTaskId(missionId)}|${review.brainId}`)) {
        requests.push({
          missionId,
          taskId: reviewAssignmentTaskId(missionId),
          taskType: review.stage,
          requiredCapabilities: [review.capability],
          scope: {},
          computeUnits: 1,
          requiredAgentId: review.brainId,
        });
      }

      const recorded =
        requests.length === 0
          ? { assignments: [], gaps: [] }
          : await deps.service.delegate(deps.chief, { requests, parentAssignmentId: null });

      return {
        ok: true,
        plan: outcome.plan,
        assignments: recorded.assignments,
        gaps: recorded.gaps,
        unbound,
        alreadyBound,
        released: stale.length,
      };
    },
  };
}

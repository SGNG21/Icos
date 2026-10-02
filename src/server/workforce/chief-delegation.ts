import {
  classifyRawObjective,
  type ClassifiedObjective,
} from "@/core/chief/objective-classification";
import {
  planObjectiveDelegation,
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

/** Un identifiant de tâche stable par étape : rejouer la même délégation n'en crée pas deux. */
export const stageTaskId = (missionId: string, stage: string): string =>
  `${missionId}:${stage.toLowerCase()}`;

export type ChiefDelegationOutcome =
  | {
      readonly ok: true;
      readonly plan: DelegationPlan;
      readonly assignments: readonly WorkAssignment[];
      /** Ce que la gouvernance a refusé. Non vide ne veut PAS dire que rien n'a été fait. */
      readonly gaps: readonly DelegationGap[];
    }
  | {
      readonly ok: false;
      readonly refusals: readonly DelegationRefusal[];
      /** Aucun travail n'a été enregistré : le refus précède tout effet de bord. */
      readonly classified: ClassifiedObjective;
    };

export interface ChiefDelegationDeps {
  readonly registry: BrainRegistry;
  readonly service: Pick<WorkforceService, "delegate">;
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
  delegateGoal(goal: HighLevelGoal, missionId: string): Promise<ChiefDelegationOutcome>;
}

export function chiefDelegation(deps: ChiefDelegationDeps): ChiefDelegation {
  const limits = deps.limits ?? DEFAULT_DELEGATION_LIMITS;

  return {
    async delegateGoal(goal, missionId) {
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
      const requests: WorkRequest[] = [...outcome.plan.assignments, outcome.plan.review].map(
        (assignment) => ({
          missionId,
          taskId: stageTaskId(missionId, assignment.stage),
          taskType: assignment.stage,
          requiredCapabilities: [assignment.capability],
          scope: {},
          /* Une unité par étape : le coût réel est mesuré par le budget, pas estimé ici. */
          computeUnits: 1,
          requiredAgentId: assignment.brainId,
        }),
      );

      const recorded = await deps.service.delegate(deps.chief, {
        requests,
        parentAssignmentId: null,
      });

      return {
        ok: true,
        plan: outcome.plan,
        assignments: recorded.assignments,
        gaps: recorded.gaps,
      };
    },
  };
}

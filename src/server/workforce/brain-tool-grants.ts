import { loadWorkforceBootstrap } from "@/core/workforce/bootstrap";
import type { AgentPolicy, ToolGrant, WorkforceAgent } from "@/core/workforce/contracts";
import type { Principal } from "@/core/workforce/governance";

import type { WorkforceStore } from "./ports";
import type { WorkforceService } from "./workforce-service";

/**
 * ACCORDER À CHAQUE CERVEAU LES OUTILS QUE SON RÔLE DÉCLARE — UN ACTE HUMAIN (verrou C6).
 *
 * ── POURQUOI CETTE ÉTAPE EXISTE ─────────────────────────────────────────────────────────
 * Un cerveau fraîchement seedé n'a AUCUN outil, par conception : « a grant comes from a
 * human ». La gouvernance refuse donc toute affectation avec `MISSING_TOOL_GRANT`, et c'est
 * le comportement correct — mesuré, pas supposé : sans cette étape, les douze cerveaux
 * existent, le Chief produit un plan juste, et PAS UNE SEULE affectation n'est accordée.
 * Seeder sans accorder donne donc exactement ce que la revue reprochait : des lignes que le
 * dispatcheur ignore.
 *
 * ── CE QUI REND CET ACTE LÉGITIME, ET BORNÉ ─────────────────────────────────────────────
 *   1. C'EST L'HUMAIN QUI L'EXÉCUTE. Le `principal` est le propriétaire qui lance
 *      l'amorçage ; rien ici ne s'exécute tout seul au démarrage du runtime. Le grant porte
 *      son identité, pas celle d'un agent.
 *   2. MINIMUM STRICT, DÉRIVÉ, JAMAIS « TOUS LES OUTILS ». Les outils accordés sont
 *      EXACTEMENT l'union des `requiredTools` des skills du rôle CERTIFIÉ du cerveau. Un
 *      rôle qui ne déclare aucun besoin reçoit zéro outil. Il n'existe aucun chemin, ici,
 *      pour accorder un outil qu'un rôle ne demande pas.
 *   3. RÉDUCTION SEULE À LA RE-EXÉCUTION. Un second passage n'ajoute rien à un cerveau qui
 *      a déjà ses outils : il est idempotent, et il n'ÉLARGIT jamais un grant existant que
 *      quelqu'un aurait restreint à la main.
 *   4. LA GOUVERNANCE GARDE LE DERNIER MOT. Tout passe par `changePolicy`, donc
 *      `evaluatePolicyChange` : un cerveau ne peut pas élever sa propre autorité, ni
 *      dépasser celle de son superviseur, et l'événement durable est écrit.
 *
 * ── L'AUTORITÉ DESCEND, DONC LE CHIEF D'ABORD ───────────────────────────────────────────
 * La gouvernance refuse qu'un agent détienne un outil que son superviseur ne détient pas
 * (`TOOL_NOT_HELD_BY_PARENT`) : c'est ce qui empêche une branche de se doter d'un pouvoir
 * que sa hiérarchie n'a pas. Or ICOS_CENTRAL ne déclare AUCUN outil, donc accorder les
 * enfants d'abord échoue sur les douze. Mesuré, pas supposé.
 *
 * La racine reçoit donc l'UNION des besoins de la flotte qu'on amorce — et rien d'autre.
 * Ce n'est PAS « tous les outils » : c'est exactement ce que les rôles certifiés des
 * cerveaux demandés déclarent, donc un ensemble dérivé, borné et réduit si l'on amorce
 * moins de cerveaux. Le Chief ne peut pas s'en servir lui-même pour autre chose : son
 * propre rôle ne déclare aucun skill qui les consomme ; il les détient pour pouvoir les
 * déléguer, ce qui est précisément le sens de la règle.
 *
 * `actions: ["*"]` sur l'outil accordé : la granularité par action n'existe pas encore dans
 * les skills (ils déclarent un `toolId`, pas une liste d'actions). L'écrire ainsi est la
 * vérité du modèle actuel ; l'affiner demandera que les skills déclarent leurs actions.
 */

export type BrainGrantOutcome = "granted" | "already-granted" | "refused" | "no-tools-needed";

export interface BrainGrantResult {
  readonly agentId: string;
  readonly outcome: BrainGrantOutcome;
  readonly tools: readonly string[];
  readonly violations?: readonly string[];
}

export interface BrainGrantReport {
  readonly results: readonly BrainGrantResult[];
  /** Vrai seulement si aucun cerveau n'a été refusé. Une absence n'est jamais un succès. */
  readonly complete: boolean;
}

/** L'union des `requiredTools` des skills ACTIFS du rôle. Rien de plus, jamais. */
export function toolsRequiredBy(
  agent: WorkforceAgent,
  bootstrap = loadWorkforceBootstrap(),
): string[] {
  const role = bootstrap.roles.find(
    (r) => r.roleId === agent.roleId && r.version === agent.roleVersion,
  );
  if (!role) return [];
  const tools = new Set<string>();
  for (const skillId of role.skills) {
    const skill = bootstrap.skills.find((s) => s.skillId === skillId);
    if (!skill || skill.status === "retired") continue;
    for (const toolId of skill.requiredTools) tools.add(toolId);
  }
  return [...tools].sort();
}

export async function grantBrainTools(
  deps: {
    service: Pick<WorkforceService, "changePolicy">;
    store: Pick<WorkforceStore, "listAgents">;
    now?: () => string;
  },
  admin: Principal,
  brainIds: readonly string[],
): Promise<BrainGrantReport> {
  const grantedAt = (deps.now ?? (() => new Date().toISOString()))();
  const agents = new Map(
    (await deps.store.listAgents(admin.tenantId)).map((a) => [a.agentId, a] as const),
  );

  /*
   * L'union des besoins de CETTE flotte, pour la racine. Calculée avant la boucle parce que
   * la racine doit détenir les outils AVANT que ses rapports les demandent.
   */
  const fleetTools = [
    ...new Set(
      brainIds.flatMap((id) => {
        const agent = agents.get(id);
        return agent ? toolsRequiredBy(agent) : [];
      }),
    ),
  ].sort();

  const results: BrainGrantResult[] = [];
  /* La racine d'abord : l'ordre est une condition, pas une préférence. */
  const ordered = [...brainIds].sort((a, b) => {
    const rootness = (id: string) => (agents.get(id)?.supervisorAgentId === null ? 0 : 1);
    return rootness(a) - rootness(b);
  });

  for (const agentId of ordered) {
    const agent = agents.get(agentId);
    if (!agent) {
      results.push({ agentId, outcome: "refused", tools: [], violations: ["AGENT_NOT_FOUND"] });
      continue;
    }
    /* La racine détient ce qu'elle délègue ; un rapport ne détient que SON minimum. */
    const tools = agent.supervisorAgentId === null ? fleetTools : toolsRequiredBy(agent);
    if (tools.length === 0) {
      results.push({ agentId, outcome: "no-tools-needed", tools: [] });
      continue;
    }
    const held = new Set(agent.policy.toolGrants.map((g) => g.toolId));
    if (tools.every((t) => held.has(t))) {
      results.push({ agentId, outcome: "already-granted", tools });
      continue;
    }

    /* On AJOUTE les manquants ; on ne réécrit pas un grant existant. */
    const added: ToolGrant[] = tools
      .filter((toolId) => !held.has(toolId))
      .map((toolId) => ({
        toolId,
        grantedBy: { kind: admin.kind, id: admin.id },
        actions: ["*"],
        grantedAt,
      }));
    const next: AgentPolicy = {
      ...agent.policy,
      toolGrants: [...agent.policy.toolGrants, ...added],
    };
    try {
      await deps.service.changePolicy(admin, agentId, next);
      results.push({ agentId, outcome: "granted", tools: added.map((g) => g.toolId) });
    } catch (error) {
      results.push({
        agentId,
        outcome: "refused",
        tools,
        violations: [error instanceof Error ? error.message : "unknown"],
      });
    }
  }

  return { results, complete: results.every((r) => r.outcome !== "refused") };
}

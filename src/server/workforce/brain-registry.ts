import { type AutonomyLevel, type BrainDescriptor } from "@/core/chief/delegation";
import type { AgentRole, SkillDefinition, WorkforceAgent } from "@/core/workforce/contracts";

import type { WorkforceStore } from "./ports";

/**
 * LE REGISTRE DES CERVEAUX, VU PAR LE CHIEF (verrou C6).
 *
 * `planObjectiveDelegation` raisonne sur un `BrainDescriptor` — une vue structurelle
 * minimale — et refusait délibérément d'importer les types de la workforce. Il n'existait
 * donc AUCUN adaptateur : la politique de délégation était écrite contre une flotte
 * hypothétique, et c'est pour cela qu'elle n'avait aucun appelant. Ce fichier est cet
 * adaptateur, et rien d'autre : il ne décide rien, il TRADUIT.
 *
 * ── D'OÙ VIENT CHAQUE CHAMP, ET POURQUOI ────────────────────────────────────────────────
 *
 *   brainId   l'`agentId` de la ligne `workforce_agents`. L'identité durable, pas le rôle :
 *             Builder, Recovery et Evolution partagent FULLSTACK_ENGINEER, donc le rôle ne
 *             distingue pas trois cerveaux dont les responsabilités diffèrent.
 *
 *   capabilities  l'UNION des capacités des SKILLS du rôle. Un cerveau ne redéclare aucune
 *             capacité (c'est écrit dans `brains.ts`) : la source unique est le rôle, et la
 *             remplacer par une liste tenue à la main créerait une seconde vérité.
 *
 *   autonomyLevel  celui de l'agent, RABATTU au plafond de son rôle. La politique d'un agent
 *             est déjà bornée par sa hiérarchie à la création, mais un rôle peut être
 *             recertifié plus bas APRÈS ; on prend donc le minimum à la lecture, pas une
 *             valeur figée au moment de la création.
 *
 *   reviewPolicy  dérivée, et JAMAIS « never ». Un skill qui exige une approbation humaine
 *             pour une classe d'action donne « always » ; tout le reste donne « if_risky ».
 *             « never » signifierait « ce cerveau n'est jamais relu », ce qui doit être une
 *             décision humaine explicite et non le défaut d'un adaptateur.
 *
 * Un agent dont le rôle est introuvable est OMIS, pas inventé avec des capacités vides : une
 * flotte incomplète doit produire un BESOIN NON COUVERT visible, jamais un cerveau fantôme
 * qui ne peut rien faire et que le plan croit disponible.
 */

/** Seul l'agent DURABLE est un cerveau. Un spécialiste éphémère est une exécution. */
const DURABLE: WorkforceAgent["kind"] = "DURABLE_AGENT";

function capabilitiesOf(role: AgentRole, skills: ReadonlyMap<string, SkillDefinition>): string[] {
  const capabilities = new Set<string>();
  for (const skillId of role.skills) {
    const skill = skills.get(skillId);
    /* Un skill retiré ne confère plus rien : on ne le compte pas. */
    if (!skill || skill.status !== "active") continue;
    for (const capability of skill.capabilities) capabilities.add(capability);
  }
  return [...capabilities].sort();
}

/** `always` dès qu'un skill du rôle exige une approbation humaine ; sinon `if_risky`. */
function reviewPolicyOf(
  role: AgentRole,
  skills: ReadonlyMap<string, SkillDefinition>,
): BrainDescriptor["reviewPolicy"] {
  for (const skillId of role.skills) {
    const skill = skills.get(skillId);
    if (skill && skill.approvalRequiredFor.length > 0) return "always";
  }
  return "if_risky";
}

const AUTONOMY_ORDER: readonly AutonomyLevel[] = [0, 1, 2, 3];

/** Le plus bas des deux niveaux. Un rôle recertifié plus bas RABAISSE ses agents. */
function narrowest(agent: number, ceiling: number): AutonomyLevel {
  const level = Math.min(agent, ceiling);
  return (AUTONOMY_ORDER.find((l) => l === level) ?? 0) as AutonomyLevel;
}

export interface BrainRegistry {
  /** Les cerveaux durables du tenant, tels que le Chief doit les voir. */
  list(tenantId: string): Promise<BrainDescriptor[]>;
}

export function brainRegistry(
  store: Pick<WorkforceStore, "listAgents" | "listRoles" | "listSkills">,
): BrainRegistry {
  return {
    async list(tenantId) {
      const [agents, roles, skills] = await Promise.all([
        store.listAgents(tenantId),
        store.listRoles(tenantId),
        store.listSkills(tenantId),
      ]);
      const roleByKey = new Map(roles.map((r) => [`${r.roleId}@${r.version}`, r]));
      const skillById = new Map(skills.map((s) => [s.skillId, s]));

      const descriptors: BrainDescriptor[] = [];
      for (const agent of agents) {
        if (agent.kind !== DURABLE) continue;
        const role = roleByKey.get(`${agent.roleId}@${agent.roleVersion}`);
        /* Rôle introuvable : on OMET. Un cerveau sans capacités serait un faux disponible. */
        if (!role) continue;
        descriptors.push({
          brainId: agent.agentId,
          role: agent.roleId,
          capabilities: capabilitiesOf(role, skillById),
          autonomyLevel: narrowest(agent.policy.autonomyLevel, role.autonomyCeiling),
          status: agent.status,
          maxConcurrentAssignments: agent.policy.bounds.maxConcurrentAssignments,
          reviewPolicy: reviewPolicyOf(role, skillById),
        });
      }
      return descriptors.sort((a, b) => a.brainId.localeCompare(b.brainId));
    },
  };
}

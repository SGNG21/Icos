import { z } from "zod";

import organizationData from "./bootstrap/organization.json";
import rolesData from "./bootstrap/roles.json";
import skillsData from "./bootstrap/skills.json";
import {
  agentRoleSchema,
  departmentSchema,
  skillDefinitionSchema,
  type AgentRole,
  type Department,
  type SkillDefinition,
} from "./contracts";

/**
 * Bootstrap templates (decision 0057): DATA, validated at load, not architecture. They seed a
 * registry; nothing here creates an agent or grants a tool. Roles ship as `draft` and go
 * through the same certification + human activation as a dynamically composed role.
 */

export const organizationBoundsSchema = z
  .object({
    maxDepth: z.number().int().positive(),
    maxAgents: z.number().int().positive(),
    maxConcurrentAssignmentsPerAgent: z.number().int().positive(),
  })
  .strict();
export type OrganizationBounds = z.infer<typeof organizationBoundsSchema>;

const organizationSchema = z
  .object({ bounds: organizationBoundsSchema, departments: z.array(departmentSchema) })
  .strict();

export interface WorkforceBootstrap {
  skills: SkillDefinition[];
  roles: AgentRole[];
  departments: Department[];
  bounds: OrganizationBounds;
}

/** Parses and cross-checks the templates. Throws on any inconsistency: bad data never loads. */
export function loadWorkforceBootstrap(): WorkforceBootstrap {
  const skills = z.array(skillDefinitionSchema).parse(skillsData);
  const roles = z.array(agentRoleSchema).parse(rolesData);
  const { bounds, departments } = organizationSchema.parse(organizationData);

  const skillIds = new Set(skills.map((s) => s.skillId));
  if (skillIds.size !== skills.length) throw new Error("bootstrap: skillId dupliqué");
  if (new Set(roles.map((r) => r.roleId)).size !== roles.length) {
    throw new Error("bootstrap: roleId dupliqué");
  }
  for (const role of roles) {
    if (role.status !== "draft" || role.certification) {
      throw new Error(`bootstrap: ${role.roleId} doit être draft et non certifié`);
    }
    for (const skillId of role.skills) {
      if (!skillIds.has(skillId))
        throw new Error(`bootstrap: ${role.roleId} -> skill inconnu ${skillId}`);
    }
  }
  const deptIds = new Set(departments.map((d) => d.departmentId));
  for (const d of departments) {
    if (d.parentDepartmentId && !deptIds.has(d.parentDepartmentId)) {
      throw new Error(`bootstrap: département parent inconnu ${d.parentDepartmentId}`);
    }
    if (d.supervisorAgentId !== null) {
      throw new Error(
        "bootstrap: un template ne nomme aucun agent (superviseur attribué par un humain)",
      );
    }
  }
  return { skills, roles, departments, bounds };
}

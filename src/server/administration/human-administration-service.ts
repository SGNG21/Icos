import { randomUUID } from "node:crypto";

import type { Agent } from "@/core/contracts";
import {
  canAdministerTarget,
  canCreateRole,
  type AdministrationOperation,
  type HumanAgentLink,
  type HumanAgentRelation,
  type Role,
  type UserStatus,
} from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import type {
  AdminHumanUser,
  AgentRepository,
  AuditRepository,
  HumanAgentLinkRepository,
  HumanUserAdministrationRepository,
} from "@/server/repositories/ports";
import type { HumanAdministrationResult, HumanAdministrationUnitOfWork } from "@/server/uow/ports";

import { buildHumanAdministrationAudit } from "./audit";

export type HumanAdministrationServiceResult<T> =
  | { ok: true; value: T; changed: boolean }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "already_exists"
        | "last_owner"
        | "audit_failed"
        | "invalid_input"
        | "internal_error";
      message: string;
    };

interface ActorInput {
  actorUserId: string;
  actorRoles: readonly Role[];
}

interface ServiceDependencies {
  auth: AuthGateway;
  users: HumanUserAdministrationRepository;
  links: HumanAgentLinkRepository;
  agents: AgentRepository;
  audit: AuditRepository;
  uow: HumanAdministrationUnitOfWork;
  now?: () => string;
  newId?: (prefix: string) => string;
}

const internalFailure = (): HumanAdministrationServiceResult<never> => ({
  ok: false,
  reason: "internal_error",
  message: "administration humaine indisponible",
});

export class HumanAdministrationService {
  private readonly auth: AuthGateway;
  private readonly users: HumanUserAdministrationRepository;
  private readonly links: HumanAgentLinkRepository;
  private readonly agents: AgentRepository;
  private readonly audit: AuditRepository;
  private readonly uow: HumanAdministrationUnitOfWork;
  private readonly now: () => string;
  private readonly newId: (prefix: string) => string;

  constructor(input: ServiceDependencies) {
    this.auth = input.auth;
    this.users = input.users;
    this.links = input.links;
    this.agents = input.agents;
    this.audit = input.audit;
    this.uow = input.uow;
    this.now = input.now ?? (() => new Date().toISOString());
    this.newId = input.newId ?? ((prefix) => `${prefix}-${randomUUID()}`);
  }

  listUsers(): Promise<AdminHumanUser[]> {
    return this.users.list();
  }

  async createHuman(
    input: ActorInput & {
      email: string;
      password: string;
      name?: string;
      role: Role;
    },
  ): Promise<HumanAdministrationServiceResult<AdminHumanUser>> {
    if (!canCreateRole(input.actorRoles, input.role).ok) {
      return this.deny(input, "create", "forbidden");
    }

    if ((await this.users.findByEmail(input.email)) !== null) {
      return this.deny(input, "create", "already_exists");
    }

    let created;
    try {
      created = await this.auth.createHumanUser({
        email: input.email,
        password: input.password,
        name: input.name,
      });
    } catch {
      return internalFailure();
    }

    if (!created.ok) {
      if (created.reason === "already_exists") {
        return this.deny(input, "create", "already_exists");
      }
      return {
        ok: false,
        reason: "invalid_input",
        message: "identité humaine invalide",
      };
    }

    let result: HumanAdministrationResult<AdminHumanUser>;
    try {
      result = await this.uow.finalizeHumanCreation({
        targetUserId: created.userId,
        role: input.role,
        actorUserId: input.actorUserId,
        auditId: this.newId("audit"),
        occurredAt: this.now(),
      });
    } catch {
      return this.compensate(created.userId, internalFailure());
    }

    if (!result.ok) {
      return this.compensate(created.userId, result);
    }

    return result;
  }

  async replaceRole(
    input: ActorInput & {
      targetUserId: string;
      role: Role;
    },
  ): Promise<HumanAdministrationServiceResult<AdminHumanUser>> {
    const target = await this.authorizedTarget(input, "role");
    if (!target.ok) return target.result;

    return this.runMutation(
      input,
      "role",
      input.targetUserId,
      this.uow.replaceRole({
        targetUserId: input.targetUserId,
        nextRole: input.role,
        actorUserId: input.actorUserId,
        auditId: this.newId("audit"),
        occurredAt: this.now(),
      }),
    );
  }

  async setStatus(
    input: ActorInput & {
      targetUserId: string;
      status: UserStatus;
    },
  ): Promise<HumanAdministrationServiceResult<AdminHumanUser>> {
    const target = await this.authorizedTarget(input, "status");
    if (!target.ok) return target.result;

    return this.runMutation(
      input,
      "status",
      input.targetUserId,
      this.uow.setStatus({
        targetUserId: input.targetUserId,
        nextStatus: input.status,
        actorUserId: input.actorUserId,
        auditId: this.newId("audit"),
        occurredAt: this.now(),
      }),
    );
  }

  async listLinks(
    input: ActorInput & {
      targetUserId: string;
    },
  ): Promise<HumanAdministrationServiceResult<HumanAgentLink[]>> {
    const target = await this.authorizedTarget(input, "links");
    if (!target.ok) return target.result;

    return {
      ok: true,
      value: await this.links.listForHuman(input.targetUserId),
      changed: false,
    };
  }

  async createLink(
    input: ActorInput & {
      targetUserId: string;
      agentId: string;
      relation: HumanAgentRelation;
    },
  ): Promise<HumanAdministrationServiceResult<HumanAgentLink>> {
    const target = await this.authorizedTarget(input, "links");
    if (!target.ok) return target.result;

    const agent: Agent | null = await this.agents.getById(input.agentId);
    if (agent === null) {
      return this.deny(input, "links", "not_found", input.targetUserId);
    }

    return this.runMutation(
      input,
      "links",
      input.targetUserId,
      this.uow.createAgentLink({
        id: this.newId("link"),
        targetUserId: input.targetUserId,
        agentId: input.agentId,
        relation: input.relation,
        actorUserId: input.actorUserId,
        auditId: this.newId("audit"),
        occurredAt: this.now(),
      }),
    );
  }

  async removeLink(
    input: ActorInput & {
      targetUserId: string;
      agentId: string;
    },
  ): Promise<HumanAdministrationServiceResult<HumanAgentLink>> {
    const target = await this.authorizedTarget(input, "links");
    if (!target.ok) return target.result;

    return this.runMutation(
      input,
      "links",
      input.targetUserId,
      this.uow.removeAgentLink({
        targetUserId: input.targetUserId,
        agentId: input.agentId,
        actorUserId: input.actorUserId,
        auditId: this.newId("audit"),
        occurredAt: this.now(),
      }),
    );
  }

  private async authorizedTarget(
    input: ActorInput & { targetUserId: string },
    operation: Exclude<AdministrationOperation, "create">,
  ): Promise<
    | { ok: true; target: AdminHumanUser }
    | { ok: false; result: HumanAdministrationServiceResult<never> }
  > {
    const target = await this.users.findById(input.targetUserId);
    if (target === null) {
      return {
        ok: false,
        result: await this.deny(input, operation, "not_found", input.targetUserId),
      };
    }

    const decision = canAdministerTarget({
      actorUserId: input.actorUserId,
      actorRoles: input.actorRoles,
      targetUserId: input.targetUserId,
      targetRoles: target.role === null ? [] : [target.role],
    });
    if (!decision.ok) {
      return {
        ok: false,
        result: await this.deny(input, operation, "forbidden", input.targetUserId),
      };
    }

    return { ok: true, target };
  }

  private async runMutation<T>(
    actor: ActorInput,
    operation: Exclude<AdministrationOperation, "create">,
    targetUserId: string,
    pending: Promise<HumanAdministrationResult<T>>,
  ): Promise<HumanAdministrationServiceResult<T>> {
    let result: HumanAdministrationResult<T>;
    try {
      result = await pending;
    } catch {
      return internalFailure();
    }

    if (
      !result.ok &&
      (result.reason === "not_found" ||
        result.reason === "already_exists" ||
        result.reason === "last_owner")
    ) {
      const denied = await this.deny(actor, operation, result.reason, targetUserId);
      return !denied.ok && denied.reason === "audit_failed" ? denied : result;
    }

    return result;
  }

  private async deny(
    actor: ActorInput,
    operation: AdministrationOperation,
    reason: "forbidden" | "last_owner" | "already_exists" | "not_found",
    targetUserId?: string,
  ): Promise<HumanAdministrationServiceResult<never>> {
    try {
      await this.audit.append(
        buildHumanAdministrationAudit({
          id: this.newId("audit"),
          occurredAt: this.now(),
          actorUserId: actor.actorUserId,
          eventType: "human_user.administration_denied",
          operation,
          ...(targetUserId === undefined ? {} : { targetUserId }),
          reason,
        }),
      );
    } catch {
      return {
        ok: false,
        reason: "audit_failed",
        message: "audit administratif indisponible",
      };
    }

    return {
      ok: false,
      reason,
      message: "opération administrative refusée",
    };
  }

  private async compensate<T>(
    userId: string,
    failure: HumanAdministrationServiceResult<T>,
  ): Promise<HumanAdministrationServiceResult<T>> {
    try {
      await this.auth.deleteHumanUser(userId);
      return failure;
    } catch {
      return internalFailure();
    }
  }
}

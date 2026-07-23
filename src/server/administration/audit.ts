import type { AuditEntry } from "@/core/contracts";
import type {
  AdministrationOperation,
  HumanAgentRelation,
  Role,
  UserStatus,
} from "@/core/identity";

interface BaseAuditInput {
  id: string;
  occurredAt: string;
  actorUserId: string;
}

export type HumanAdministrationAuditInput =
  | (BaseAuditInput & {
      eventType: "human_user.created";
      targetUserId: string;
      role: Role;
    })
  | (BaseAuditInput & {
      eventType: "human_user.role_changed";
      targetUserId: string;
      previousRole: Role;
      nextRole: Role;
      changed: boolean;
    })
  | (BaseAuditInput & {
      eventType: "human_user.enabled" | "human_user.disabled";
      targetUserId: string;
      previousStatus: UserStatus;
      nextStatus: UserStatus;
      changed: boolean;
    })
  | (BaseAuditInput & {
      eventType: "human_agent_link.created" | "human_agent_link.removed";
      targetUserId: string;
      agentId: string;
      relation: HumanAgentRelation;
    })
  | (BaseAuditInput & {
      eventType: "human_user.administration_denied";
      operation: AdministrationOperation;
      targetUserId?: string;
      reason: "forbidden" | "last_owner" | "already_exists" | "not_found";
    });

export function buildHumanAdministrationAudit(input: HumanAdministrationAuditInput): AuditEntry {
  const base = {
    id: input.id,
    occurredAt: input.occurredAt,
    eventType: input.eventType,
    actor: {
      kind: "human" as const,
      id: input.actorUserId,
    },
  };

  switch (input.eventType) {
    case "human_user.created":
      return {
        ...base,
        details: {
          targetUserId: input.targetUserId,
          role: input.role,
        },
      };
    case "human_user.role_changed":
      return {
        ...base,
        details: {
          targetUserId: input.targetUserId,
          previousRole: input.previousRole,
          nextRole: input.nextRole,
          changed: input.changed,
        },
      };
    case "human_user.enabled":
    case "human_user.disabled":
      return {
        ...base,
        details: {
          targetUserId: input.targetUserId,
          previousStatus: input.previousStatus,
          nextStatus: input.nextStatus,
          changed: input.changed,
        },
      };
    case "human_agent_link.created":
    case "human_agent_link.removed":
      return {
        ...base,
        details: {
          targetUserId: input.targetUserId,
          agentId: input.agentId,
          relation: input.relation,
        },
      };
    case "human_user.administration_denied":
      return {
        ...base,
        details: {
          operation: input.operation,
          ...(input.targetUserId === undefined ? {} : { targetUserId: input.targetUserId }),
          reason: input.reason,
        },
      };
  }
}

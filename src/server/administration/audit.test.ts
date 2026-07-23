import { describe, expect, expectTypeOf, it } from "vitest";

import { buildHumanAdministrationAudit } from "./audit";

const base = {
  id: "audit-001",
  occurredAt: "2026-07-23T10:00:00.000Z",
  actorUserId: "human-owner",
};

describe("buildHumanAdministrationAudit", () => {
  it.each([
    [
      {
        ...base,
        eventType: "human_user.created" as const,
        targetUserId: "human-operator",
        role: "operator" as const,
      },
      {
        eventType: "human_user.created",
        details: { targetUserId: "human-operator", role: "operator" },
      },
    ],
    [
      {
        ...base,
        eventType: "human_user.role_changed" as const,
        targetUserId: "human-operator",
        previousRole: "viewer" as const,
        nextRole: "operator" as const,
        changed: true,
      },
      {
        eventType: "human_user.role_changed",
        details: {
          targetUserId: "human-operator",
          previousRole: "viewer",
          nextRole: "operator",
          changed: true,
        },
      },
    ],
    [
      {
        ...base,
        eventType: "human_user.enabled" as const,
        targetUserId: "human-viewer",
        previousStatus: "disabled" as const,
        nextStatus: "active" as const,
        changed: true,
      },
      {
        eventType: "human_user.enabled",
        details: {
          targetUserId: "human-viewer",
          previousStatus: "disabled",
          nextStatus: "active",
          changed: true,
        },
      },
    ],
    [
      {
        ...base,
        eventType: "human_user.disabled" as const,
        targetUserId: "human-viewer",
        previousStatus: "active" as const,
        nextStatus: "disabled" as const,
        changed: true,
      },
      {
        eventType: "human_user.disabled",
        details: {
          targetUserId: "human-viewer",
          previousStatus: "active",
          nextStatus: "disabled",
          changed: true,
        },
      },
    ],
    [
      {
        ...base,
        eventType: "human_agent_link.created" as const,
        targetUserId: "human-operator",
        agentId: "agent-cto",
        relation: "supervisor" as const,
      },
      {
        eventType: "human_agent_link.created",
        details: {
          targetUserId: "human-operator",
          agentId: "agent-cto",
          relation: "supervisor",
        },
      },
    ],
    [
      {
        ...base,
        eventType: "human_agent_link.removed" as const,
        targetUserId: "human-operator",
        agentId: "agent-cto",
        relation: "observer" as const,
      },
      {
        eventType: "human_agent_link.removed",
        details: {
          targetUserId: "human-operator",
          agentId: "agent-cto",
          relation: "observer",
        },
      },
    ],
    [
      {
        ...base,
        eventType: "human_user.administration_denied" as const,
        operation: "links" as const,
        targetUserId: "human-owner-2",
        reason: "forbidden" as const,
      },
      {
        eventType: "human_user.administration_denied",
        details: {
          operation: "links",
          targetUserId: "human-owner-2",
          reason: "forbidden",
        },
      },
    ],
  ])("construit l'événement fermé %#", (input, expected) => {
    const entry = buildHumanAdministrationAudit(input);

    expect(entry).toEqual({
      id: base.id,
      occurredAt: base.occurredAt,
      actor: { kind: "human", id: base.actorUserId },
      ...expected,
    });
    expect(JSON.stringify(entry)).not.toMatch(
      /password|cookie|token|secret|hash|headers|database_url|sql/i,
    );
  });

  it("omet la cible facultative d'un refus de création", () => {
    expect(
      buildHumanAdministrationAudit({
        ...base,
        eventType: "human_user.administration_denied",
        operation: "create",
        reason: "already_exists",
      }).details,
    ).toEqual({ operation: "create", reason: "already_exists" });
  });

  it("n'accepte aucun blob arbitraire ou champ sensible", () => {
    type Input = Parameters<typeof buildHumanAdministrationAudit>[0];
    type ForbiddenKeys = Extract<
      keyof Input,
      "password" | "cookie" | "token" | "secret" | "hash" | "headers" | "database_url" | "sql"
    >;

    expectTypeOf<ForbiddenKeys>().toEqualTypeOf<never>();
  });
});

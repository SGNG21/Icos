import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { AuditEntry } from "@/core/contracts";
import type { AuditRepository } from "@/server/repositories/ports";

import { appendSecurityAudit } from "./security-audit";

function auditRepository(append = vi.fn(async (entry: AuditEntry) => entry)): AuditRepository {
  return {
    append,
    appendMany: async (entries) => [...entries],
    list: async () => [],
    query: async () => [],
  };
}

describe("appendSecurityAudit", () => {
  it.each([
    [
      {
        eventType: "auth.login.succeeded" as const,
        userId: "human-1",
      },
      { kind: "human", id: "human-1" },
      {},
    ],
    [
      {
        eventType: "auth.login.rejected" as const,
        reason: "invalid_credentials" as const,
      },
      { kind: "system", id: "icos-auth" },
      { reason: "invalid_credentials" },
    ],
    [
      {
        eventType: "auth.logout.succeeded" as const,
        userId: "human-1",
      },
      { kind: "human", id: "human-1" },
      {},
    ],
    [
      {
        eventType: "auth.access.denied" as const,
        userId: "human-1",
        method: "POST",
        route: "tasks.create",
        permission: "tasks.write" as const,
        reason: "forbidden" as const,
      },
      { kind: "human", id: "human-1" },
      {
        method: "POST",
        route: "tasks.create",
        permission: "tasks.write",
        reason: "forbidden",
      },
    ],
  ])(
    "ajoute un événement %s avec un acteur et des détails contrôlés",
    async (input, actor, details) => {
      const append = vi.fn(async (entry: AuditEntry) => entry);

      const result = await appendSecurityAudit(auditRepository(append), input);

      expect(result).toMatchObject({ eventType: input.eventType, actor, details });
      expect(result.id).toMatch(/^[a-z0-9][a-z0-9_-]+$/);
      expect(Date.parse(result.occurredAt)).not.toBeNaN();
      expect(append).toHaveBeenCalledOnce();
    },
  );

  it("utilise un acteur système pour un refus sans utilisateur connu", async () => {
    const result = await appendSecurityAudit(auditRepository(), {
      eventType: "auth.access.denied",
      method: "GET",
      route: "agents.list",
      permission: "cockpit.read",
      reason: "missing_session",
    });

    expect(result.actor).toEqual({ kind: "system", id: "icos-auth" });
  });

  it("n'accepte aucun blob arbitraire susceptible de contenir des données sensibles", () => {
    type Input = Parameters<typeof appendSecurityAudit>[1];
    type ForbiddenKeys = Extract<
      keyof Input,
      "password" | "cookie" | "token" | "secret" | "hash" | "headers"
    >;

    expectTypeOf<ForbiddenKeys>().toEqualTypeOf<never>();
  });
});
